(() => {
  const BUTTON_WAIT_MS = 8000;
  const RESULT_TIMEOUT_MS = 6000;
  const POLL_INTERVAL_MS = 200;

  const CART_SELECTORS = ['#yDetailBtnCart', '.btnCart', '[data-action="addCart"]'];
  const CART_BUTTON_TEXTS = ['카트에 넣기', '장바구니 담기', '장바구니에 담기'];

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
      }, BUTTON_WAIT_MS).then((found) => {
        if (!found) {
          resolve({ status: 'error', reason: '장바구니 버튼을 찾을 수 없습니다' });
          return;
        }
        if (found.__err) {
          resolve({ status: 'error', reason: found.__err });
          return;
        }

        found.click();

        waitFor(() => detectResult(), RESULT_TIMEOUT_MS).then((res) => {
          resolve(res || { status: 'error', reason: '결과 확인 시간 초과' });
        });
      });
    } catch (e) {
      resolve({ status: 'error', reason: '예외: ' + (e && e.message || String(e)) });
    }
  });
})();
