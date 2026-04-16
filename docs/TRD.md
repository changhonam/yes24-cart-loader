# TRD: Yes24 장바구니 일괄 담기 Chrome Extension

## 구현 방식: DOM 자동화 (Content Script)

### 선택 이유
- Yes24는 공식 API를 제공하지 않음
- 장바구니 담기 AJAX 엔드포인트(`/Product/Content/AjaxPage/Cart/Cart`)의 정확한 POST body 형식이 불투명
- `order_payment.addCartV3()` 내부 구현을 외부에서 확인 불가
- DOM 자동화는 API 형식 변경에 상대적으로 강건함

### 방식 요약
각 도서 URL을 백그라운드 탭으로 열고, Content Script를 주입하여 장바구니 버튼을 클릭한 뒤 결과를 감지한다.

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

## 메시지 흐름

```
popup.js ──{startBatchAdd, items}──▶ service-worker.js
                                          │
                                  FOR EACH item:
                                          │
                    chrome.tabs.create({url, active: false})
                                          │
                    injectWithRetry: 300ms 간격으로 스크립트 주입 시도
                    (페이지 로딩 완료를 기다리지 않고 즉시 시도)
                                          │
                    content-script.js:
                      waitFor(버튼 등장, 8초)
                      → 버튼 클릭
                      → waitFor(결과 레이어 감지, 6초)
                      → return
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
| `startBatchAdd` | popup → background | `{ items: [{ goodsId, originalInput }] }` |
| `stopBatchAdd` | popup → background | (없음) |
| `getStatus` | popup → background | (없음) |
| `progress` | background → popup | `{ currentIndex, total, result, results[] }` |
| `batchComplete` | background → popup | `{ results[] }` |

## 상태 관리

### Service Worker 상태 구조
```javascript
{
  running: boolean,
  aborted: boolean,
  items: [{ goodsId: string, originalInput: string }],
  currentIndex: number,
  results: [{ goodsId: string, status: 'success'|'error'|'skipped'|'cancelled', reason: string }]
}
```

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

### 반환 형식
```javascript
{ status: 'success' | 'error' | 'skipped', reason: string, goodsId: string }
```

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
