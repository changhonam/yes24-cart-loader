# TRD: Yes24 장바구니 일괄 담기 Chrome Extension

## 구현 방식: DOM 자동화 (Content Script)

### 선택 이유
- Yes24는 공식 API를 제공하지 않음
- 장바구니 담기 AJAX 엔드포인트(`/Product/Content/AjaxPage/Cart/Cart`)의 정확한 POST body 형식이 불투명
- `order_payment.addCartV3()` 내부 구현을 외부에서 확인 불가
- DOM 자동화는 API 형식 변경에 상대적으로 강건함

### 방식 요약
각 도서 URL을 백그라운드 탭으로 열고, Content Script를 주입하여 장바구니 버튼을 클릭한 뒤 결과를 감지한다. 입력 단계에서 같은 상품 URL을 `goodsId`로 집계하여, 중복 신청된 도서는 1회 방문 + 수량 합산으로 처리한다. 수량(`qty`)은 탭 URL의 해시 파라미터(`#qty=N`)로 Content Script에 전달한다.

## 프로젝트 구조

```
yes24-cart-loader/
├── manifest.json              # MV3 매니페스트
├── popup/
│   ├── popup.html             # 팝업 UI 레이아웃
│   ├── popup.css              # 스타일시트
│   └── popup.js               # URL 파싱, background 메시지 송수신, UI 업데이트
├── background/
│   └── service-worker.js      # 배치 오케스트레이션, 탭 관리, 상태 관리
├── content/
│   └── content-script.js      # Yes24 페이지에서 장바구니 버튼 클릭 + 결과 감지
├── icons/
│   ├── icon16.png             # 툴바 아이콘
│   ├── icon48.png             # 확장프로그램 관리 아이콘
│   └── icon128.png            # 스토어/설치 아이콘
├── docs/
│   ├── PRD.md
│   └── TRD.md (이 문서)
├── CLAUDE.md
└── .gitignore
```

## manifest.json 권한 설계

```json
{
  "manifest_version": 3,
  "permissions": ["scripting", "tabs", "storage"],
  "host_permissions": ["*://www.yes24.com/*"]
}
```

| 권한 | 용도 |
|------|------|
| `scripting` | `chrome.scripting.executeScript()`로 Content Script 동적 주입 |
| `tabs` | 탭 생성(`chrome.tabs.create`), 상태 감시, 닫기 |
| `storage` | `chrome.storage.session`으로 배치 상태 유지 |
| `host_permissions` | Yes24 도메인에 스크립트 주입 허용 |

Content Script는 매니페스트에 선언하지 않고, 필요 시에만 programmatic injection한다.

## 입력 파싱 & 집계 (popup.js)

```
textarea (plain text, 줄 단위)
        │
        ▼
parseInput(text):
   각 줄 trim → extractGoodsId(line):
     RE_NEW / RE_OLD / RE_ID 순 매칭
   ↓
   Map<goodsId, item>에 누적 (qty += 1)
   ↓
   return { items: [{goodsId, qty, originalInput, valid}], totalLines, invalidCount }
```

- **집계 키**: `goodsId` (신형/구형/숫자 입력이 같은 ID로 매칭되면 수량 합산)
- **무효 라인**: `goodsId` 추출 실패 → `invalidCount`로만 카운트, 배치 대상에서 제외
- **carry-over**: 집계 후 items는 배치 실행 단위. textarea 원본은 `rawInput`으로 별도 보존(팝업 복원용)

## 메시지 흐름

```
popup.js ──{startBatchAdd, items, rawInput}──▶ service-worker.js
                                          │
                                  FOR EACH item (goodsId, qty):
                                          │
                chrome.tabs.create({
                  url: `https://www.yes24.com/Product/Goods/{goodsId}#qty={qty}`,
                  active: false
                })
                                          │
                    injectWithRetry: 300ms 간격으로 스크립트 주입 시도
                    (페이지 로딩 완료를 기다리지 않고 즉시 시도)
                                          │
                    content-script.js:
                      location.hash에서 qty 파싱
                      waitFor(버튼 등장, 8초)
                      → 옵션 감지 시 각 컨테이너의 기본 항목 자동 선택
                      → qty > 1이면 setQuantity(qty)
                      → 버튼 클릭
                      → waitFor(결과 레이어 감지, 6초)
                      → return { status, reason, appliedQty, selectedOptions? }
                                          │
                    chrome.tabs.remove
                                          │
popup.js ◀──{progress, result}─── service-worker.js
                                          │
                                  delay 1.5~3초
                                          │
                                  NEXT item
```

### 메시지 타입

| action | 방향 | payload |
|--------|------|---------|
| `startBatchAdd` | popup → background | `{ items: [{ goodsId, originalInput, qty }], rawInput: string }` |
| `stopBatchAdd` | popup → background | (없음) |
| `getStatus` | popup → background | (없음) |
| `progress` | background → popup | `{ currentIndex, total, results[], items[] }` |
| `batchComplete` | background → popup | `{ total, results[], items[] }` |

## 상태 관리

### Service Worker 상태 구조
```javascript
{
  running: boolean,
  aborted: boolean,
  items: [{ goodsId: string, originalInput: string, qty: number }],
  currentIndex: number,
  results: [{
    goodsId: string,
    requestedQty: number,
    appliedQty?: number,         // content-script가 실제 반영한 수량
    selectedOptions?: string[],  // content-script가 자동 선택한 옵션 라벨 (제본/분철 등)
    status: 'success'|'error'|'skipped'|'cancelled',
    reason: string
  }],
  rawInput: string               // 팝업 textarea 원문 (복원용)
}
```

### 구버전 상태 호환

`loadState()`는 `chrome.storage.session`에 저장된 구버전 state를 읽을 때 다음 기본값으로 방어한다:
- `items[i].qty`가 없거나 숫자가 아니면 `1`
- `rawInput`이 문자열이 아니면 `''`

### 상태 유지: chrome.storage.session
- 팝업 닫힘/재열기 시 상태 복원
- Service Worker 재시작 시 상태 복원 (단, 진행 중이던 배치는 중단으로 처리)
- 브라우저 재시작 시 자동 초기화 (session 스코프)

## Content Script 상세

### 장바구니 버튼 탐색 전략 (우선순위 순)

```javascript
const CART_SELECTORS = ['#yDetailBtnCart', '.btnCart', '[data-action="addCart"]'];
const CART_BUTTON_TEXTS = ['카트에 넣기', '장바구니 담기', '장바구니에 담기'];

function findCartButton() {
  // 1. 알려진 ID/클래스 셀렉터
  for (const sel of CART_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  // 2. 텍스트 기반 탐색
  const els = document.querySelectorAll('a, button');
  for (const el of els) {
    const text = (el.textContent || '').trim();
    for (const kw of CART_BUTTON_TEXTS) {
      if (text.includes(kw)) return el;
    }
  }
  return null;
}
```

페이지 로딩 직후 버튼이 아직 렌더링되지 않았을 수 있으므로, `waitFor(findCartButton, 8초)` 패턴으로 버튼 등장까지 200ms 간격 폴링한다.

### 에러 상태 감지

| 상태 | 감지 방법 |
|------|-----------|
| 품절 | `.soldout`, `.gd_soldOut` 셀렉터 또는 `.gd_infoTop`, `.gd_titArea` 내 "품절/절판" 텍스트 |
| 404/없는 상품 | 페이지 타이틀에 "찾을 수 없/존재하지 않/삭제된 상품" 또는 `.errorArea`, `.error_area`, `#errorPage` 셀렉터 |
| 미로그인 | `location.href`에 `/Member/Login` 또는 `/Templates/FTLogin` 포함 여부 |

### 결과 감지 (버튼 클릭 후)

클릭 후 최대 **6초** 동안 **200ms 간격**으로 **보이는 팝업 레이어만** 폴링:

대상 레이어 셀렉터: `.yesPopUp`, `.layerCart`, `.layer_cart`, `.pop_cart`, `#_layerPop_addCart`
(`offsetParent !== null`인 보이는 요소만 검사)

- **성공 감지**: 레이어 내 텍스트 매칭 — "카트에 담겼습니다", "장바구니에 담겼습니다", "카트에 담았습니다", "장바구니에 담았습니다", "장바구니에 넣었습니다", "장바구니에 추가되었습니다"
- **이미 담김**: "이미 카트에 담긴", "이미 장바구니에 담긴" 등 → 성공 처리
- **품절**: 레이어 내 "품절된 상품", "재고가 없", "일시품절"
- **타임아웃**: 6초 내 결과 미감지 시 "결과 확인 시간 초과"
- **옵션 미선택 경고**: 레이어 내 "옵션을 선택", "옵션을 먼저 선택", "필수 옵션" 감지 시 → "옵션 자동 선택 실패(경고 팝업)" (selector 추론이 빗나가 옵션 선택이 실제 반영되지 않은 경우의 명시적 피드백)

### 반환 형식
```javascript
{
  status: 'success' | 'error' | 'skipped',
  reason: string,
  goodsId: string,            // service-worker가 부여
  requestedQty: number,       // service-worker가 부여 (item.qty)
  appliedQty?: number,        // content-script가 실제 반영한 수량 (qty > 1 케이스)
  selectedOptions?: string[]  // 옵션 자동 선택 시 선택된 항목 라벨
}
```

### 상품 옵션 자동 선택 (제본/분철 등)

일부 상품은 옵션(예: `.gd_selRow`에 렌더되는 "제본/분철")을 먼저 선택해야만 장바구니에 담긴다. Content Script는 담기 버튼 확보 직후 + 수량 설정 전에 `selectAllOptions()`를 호출하여 감지된 모든 옵션 행의 **기본 항목**을 자동 선택한다.

**실제 DOM 구조** (제본/분철 기준):

```html
<div class="gd_selRow">
  <dl>
    <dt><a><span class="opt_txt">제본/분철 여부를 선택해주세요. (필수)</span></a></dt>
    <dd style="display: none;">
      <div class="gd_selOptGrp">
        <ul id="selPartBookWrap">
          <li data-partbookvalue="99"><!-- placeholder (data-goodsno 없음) --></li>
          <li data-goodsno="..." data-partbookvalue="0" data-partbookname="제본/분철 안 함">
            <a><span class="opt_txt">제본/분철 안 함</span></a>
          </li>
          <li data-goodsno="..." data-partbookvalue="1" data-partbookname="스프링 제본 (1권)">...</li>
        </ul>
      </div>
    </dd>
  </dl>
</div>
```

**탐색 우선순위**:

```javascript
const OPTION_CONTAINER_SELECTORS = [
  '.gd_selRow',            // 1차: Yes24 옵션 행 (확인된 구조)
  '#selPartBookWrap',      // 제본/분철 UL 직접 참조
  '#gd_spring',            // 보조 fallback
  '.gd_selGrpWrap', '[id^="gd_selGrpWrap"]',
  '.opt_selBox', '.opt_area'
];
const OPTION_ITEM_SELECTORS = [
  'li[data-goodsno]',                                       // 실제 옵션만 (placeholder는 data-goodsno 없음)
  'li[data-partbookvalue]:not([data-partbookvalue="99"])',  // 제본/분철 값 기반 fallback
  'li[data-value]', 'li'
];
```

**중복 방지**: `.gd_selRow` / `#selPartBookWrap`가 같은 행을 동시 매치하므로, 각 컨테이너의 `closest('.gd_selRow')`를 unit 키로 사용해 같은 행은 1회만 처리.

**드롭다운 열기**: `<dd style="display:none">`로 접혀 있는 커스텀 드롭다운은 Yes24 핸들러 발화를 위해 먼저 `<dt>` 내 `<a>`를 `click()`한 뒤 150ms 대기 후 항목 `<li>`의 `<a>`를 클릭한다 (`ensureDropdownOpen()`).

**기본 항목 선정 규칙** (행당 1개):

1. `<select>` 요소가 있으면 해당 요소에서:
   - placeholder/빈값(option.value 없음) 제외
   - "안 함/없음/미적용/선택 안 함" 패턴 일치 → 우선 선택
   - 없으면 DOM 순서상 첫 유효 option → `selectedIndex` 세팅 + `change` 이벤트 dispatch
2. `<li>` 리스트형이면 (가시성 필터 없음 — 드롭다운이 접혀 있어도 OK):
   - "선택해주세요/선택하세요/옵션을 선택" placeholder 텍스트 제외
   - 음수 패턴 우선 → 없으면 DOM 순서상 첫 유효 `<li>` → 내부 `<a>` 우선 `click()` (없으면 `<li>` 자체)
3. 행은 감지됐으나 어느 경로에서도 선택 실패 → `{ status: 'error', reason: '옵션 자동 선택 실패' }`
4. 옵션 컨테이너가 전혀 없으면 기존 흐름 그대로 (옵션 없는 상품)

선택 후 UI 반영을 위해 400ms 대기 후 수량 처리/담기 버튼 클릭으로 진행. 선택된 라벨은 `selectedOptions: string[]`으로 결과에 포함되어 Popup에서 `[옵션: 제본/분철 안 함]`과 같이 결과 라인 끝에 표시된다.

### 수량(qty) 처리

Yes24 상품 페이지의 수량 위젯은 `order_payment` JS 객체로 내부 카운터를 관리하며, "담기" AJAX는 이 내부 카운터를 읽는다. DOM input의 `value`에 직접 값을 할당해도 내부 카운터는 갱신되지 않으므로, **"수량증가" 버튼을 `qty - 1`번 프로그래밍적 클릭**하여 `order_payment.upOrderCount()`를 정상 발화시키는 방식으로 처리한다.

실제 DOM 구조 (기준):

```html
<input type="text" name="ORD_GOODS_CNT" id="ordCnt_{goodsId}" value="1"
       onkeyup="checkGoodsCount()" maxlength="4">
<button type="button" class="bgGD plus"
        onclick="order_payment.upOrderCount('{goodsId}'); SetTotalOrderPriceScrollBar();">
  <span class="text">수량증가</span>
</button>
```

처리 흐름:

- 탭 URL 해시(`#qty=N`)에서 파싱. `location.hash.slice(1)`를 `URLSearchParams`로 파싱 후 `parseInt`로 정수화.
- `qty <= 1`이면 수량 설정 단계를 스킵하고 바로 담기 버튼 클릭.
- `qty > 1`이면 담기 버튼 클릭 **전에** `incrementQuantity(qty)` 호출:
  - `PLUS_BUTTON_SELECTORS` 목록을 순회하여 visible한 "수량증가" 버튼을 선택
    - 1차: `button.bgGD.plus`, `button.plus`, `[onclick*="upOrderCount"]`
    - fallback: `title/alt/aria-label/textContent`에 "수량증가" 포함
  - 해당 버튼을 `qty - 1`번 `click()` (각 클릭 간 80ms 딜레이)
  - `QTY_INPUT_SELECTORS`(`input[name="ORD_GOODS_CNT"]`, `input[id^="ordCnt_"]`)로 input의 `value`를 읽어 `appliedQty`로 기록
- 실패/제한 초과 시:
  - 버튼 미발견: `{ status: 'error', reason: '수량 설정 실패: 수량증가 버튼을 찾을 수 없음' }`
  - 클릭 중 예외: `{ status: 'error', reason: '수량 설정 실패: 수량증가 클릭 실패: ...' }`
  - 반영값 ≠ 요청값: `{ status: 'error', reason: '수량 제한 초과 (요청 N, 반영 M)' }`

> 참고: DOM `value` 직접 주입 방식은 `onkeyup="checkGoodsCount()"` 검증과 내부 shadow state 불일치 때문에 실제 담기 수량이 1로 고정되어 사용하지 않는다.

## 딜레이 및 차단 방지

- 도서 간 딜레이: `1500 + Math.random() * 1500`ms (1.5~3초)
- 탭은 한 번에 하나만 열기 (`active: false`)
- User-Agent 변경 없음 (일반 브라우저 세션 그대로 사용)

## 타임아웃 설정

| 대상 | 시간 | 초과 시 동작 |
|------|------|-------------|
| 스크립트 주입 재시도 (`injectWithRetry`) | 15초 (300ms 간격) | 탭 닫기, "페이지 로딩 시간 초과" |
| 장바구니 버튼 대기 (`waitFor`) | 8초 (200ms 간격) | "장바구니 버튼을 찾을 수 없습니다" |
| 결과 레이어 감지 (`waitFor`) | 6초 (200ms 간격) | "결과 확인 시간 초과" |

## 구현 순서

1. **Skeleton**: manifest.json + popup UI + service-worker 메시지 처리 뼈대
2. **Core**: 탭 생성/관리 + content-script 장바구니 클릭 로직
3. **Integration**: 전체 흐름 연결 + 진행률 브로드캐스트 + 상태 유지
4. **Error handling**: 로그인 체크, 타임아웃, 중지 기능
5. **Polish**: 아이콘, 엣지 케이스 처리
