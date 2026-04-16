(() => {
  const BUTTON_WAIT_MS = 8000;
  const RESULT_TIMEOUT_MS = 6000;
  const POLL_INTERVAL_MS = 200;

  const CART_SELECTORS = ['#yDetailBtnCart', '.btnCart', '[data-action="addCart"]'];
  const CART_BUTTON_TEXTS = ['카트에 넣기', '장바구니 담기', '장바구니에 담기'];

  const QTY_INPUT_SELECTORS = [
    'input[name="ORD_GOODS_CNT"]',
    'input[id^="ordCnt_"]'
  ];

  const PLUS_BUTTON_SELECTORS = [
    'button.bgGD.plus',
    'button.plus',
    '[onclick*="upOrderCount"]'
  ];

  const QTY_CLICK_DELAY_MS = 80;

  const SUCCESS_PHRASES = [
    '카트에 담겼습니다',
    '장바구니에 담겼습니다',
    '카트에 담았습니다',
    '장바구니에 담았습니다',
    '장바구니에 넣었습니다',
    '장바구니에 추가되었습니다'
  ];
  const ALREADY_PHRASES = ['이미 카트에 담긴', '이미 장바구니에 담긴', '이미 장바구니에 있는'];
  const SOLDOUT_PHRASES = ['품절된 상품', '재고가 없', '일시품절'];

  const qty = (() => {
    const n = parseInt(new URLSearchParams(location.hash.slice(1)).get('qty'), 10);
    return Number.isFinite(n) && n >= 1 ? n : 1;
  })();

  function findCartButton() {
    for (const sel of CART_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    const els = document.querySelectorAll('a, button');
    for (const el of els) {
      const text = (el.textContent || '').trim();
      for (const kw of CART_BUTTON_TEXTS) {
        if (text.includes(kw)) return el;
      }
    }
    return null;
  }

  function findQtyInput() {
    for (const sel of QTY_INPUT_SELECTORS) {
      const nodes = document.querySelectorAll(sel);
      for (const el of nodes) {
        if (el.offsetParent === null) continue;
        return el;
      }
    }
    return null;
  }

  function findPlusButton() {
    for (const sel of PLUS_BUTTON_SELECTORS) {
      const nodes = document.querySelectorAll(sel);
      for (const el of nodes) {
        if (el.offsetParent === null) continue;
        return el;
      }
    }
    const candidates = document.querySelectorAll('button, a, span, img');
    for (const el of candidates) {
      if (el.offsetParent === null) continue;
      const hay = [
        el.getAttribute('title') || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('alt') || '',
        (el.textContent || '').trim()
      ].join(' ');
      if (/수량\s*증가/.test(hay) && hay.length < 30) return el;
    }
    return null;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async function incrementQuantity(targetQty) {
    const plus = findPlusButton();
    if (!plus) return { ok: false, reason: '수량증가 버튼을 찾을 수 없음' };
    const input = findQtyInput();
    const clicksNeeded = targetQty - 1;
    for (let i = 0; i < clicksNeeded; i++) {
      try {
        plus.click();
      } catch (e) {
        return { ok: false, reason: '수량증가 클릭 실패: ' + (e && e.message || String(e)) };
      }
      await sleep(QTY_CLICK_DELAY_MS);
    }
    let applied = 1;
    if (input) {
      const v = parseInt(input.value, 10);
      if (Number.isFinite(v) && v >= 1) applied = v;
    }
    return { ok: true, applied };
  }

  function isLoginPage() {
    const href = location.href;
    return href.includes('/Member/Login') || href.includes('/Templates/FTLogin');
  }

  function isSoldOut() {
    if (document.querySelector('.soldout, .gd_soldOut')) return true;
    const gd = document.querySelector('.gd_infoTop, .gd_titArea');
    if (gd && /품절|절판/.test(gd.textContent || '')) return true;
    return false;
  }

  function isNotFound() {
    const title = document.title || '';
    if (/찾을 수 없|존재하지 않|삭제된 상품|없는 상품/.test(title)) return true;
    if (document.querySelector('.errorArea, .error_area, #errorPage')) return true;
    return false;
  }

  function waitFor(check, timeoutMs) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const found = check();
      if (found) { resolve(found); return; }
      const timer = setInterval(() => {
        const r = check();
        if (r) { clearInterval(timer); resolve(r); return; }
        if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, POLL_INTERVAL_MS);
    });
  }

  function visibleLayers() {
    const layers = document.querySelectorAll('.yesPopUp, .layerCart, .layer_cart, .pop_cart, #_layerPop_addCart');
    const out = [];
    for (const el of layers) {
      if (el.offsetParent === null) continue;
      out.push(el);
    }
    return out;
  }

  function detectResult() {
    for (const el of visibleLayers()) {
      const t = (el.textContent || '').replace(/\s+/g, ' ');
      for (const p of SUCCESS_PHRASES) if (t.includes(p)) return { status: 'success', reason: '성공' };
      for (const p of ALREADY_PHRASES) if (t.includes(p)) return { status: 'success', reason: '이미 카트에 있음' };
      for (const p of SOLDOUT_PHRASES) if (t.includes(p)) return { status: 'error', reason: '품절된 상품' };
    }
    return null;
  }

  return new Promise((resolve) => {
    try {
      if (isLoginPage()) { resolve({ status: 'error', reason: '미로그인' }); return; }

      waitFor(() => {
        if (isNotFound()) return { __err: '상품을 찾을 수 없습니다' };
        if (isSoldOut()) return { __err: '품절된 상품' };
        return findCartButton();
      }, BUTTON_WAIT_MS).then(async (found) => {
        if (!found) {
          resolve({ status: 'error', reason: '장바구니 버튼을 찾을 수 없습니다' });
          return;
        }
        if (found.__err) {
          resolve({ status: 'error', reason: found.__err });
          return;
        }

        let appliedQty = 1;
        if (qty > 1) {
          const r = await incrementQuantity(qty);
          if (!r.ok) {
            resolve({ status: 'error', reason: '수량 설정 실패: ' + r.reason });
            return;
          }
          appliedQty = r.applied;
          if (appliedQty !== qty) {
            resolve({ status: 'error', reason: `수량 제한 초과 (요청 ${qty}, 반영 ${appliedQty})`, appliedQty });
            return;
          }
        }

        found.click();

        waitFor(() => detectResult(), RESULT_TIMEOUT_MS).then((res) => {
          if (res) {
            res.appliedQty = appliedQty;
            resolve(res);
          } else {
            resolve({ status: 'error', reason: '결과 확인 시간 초과', appliedQty });
          }
        });
      });
    } catch (e) {
      resolve({ status: 'error', reason: '예외: ' + (e && e.message || String(e)) });
    }
  });
})();
