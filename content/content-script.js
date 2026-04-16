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

  const OPTION_CONTAINER_SELECTORS = [
    '.gd_selRow',
    '#selPartBookWrap',
    '#gd_spring',
    '.gd_selGrpWrap',
    '[id^="gd_selGrpWrap"]',
    '.opt_selBox',
    '.opt_area'
  ];
  const OPTION_ITEM_SELECTORS = [
    'li[data-goodsno]',
    'li[data-partbookvalue]:not([data-partbookvalue="99"])',
    'li[data-value]',
    'li'
  ];
  const NEGATIVE_OPTION_PATTERNS = [/안\s*함/, /없음/, /미적용/, /선택\s*안\s*함/];
  const PLACEHOLDER_PATTERNS = [/선택해\s*주세요/, /선택하세요/, /옵션을\s*선택/];
  const OPTION_DROPDOWN_OPEN_WAIT_MS = 150;
  const OPTION_SELECT_WAIT_MS = 400;
  const OPTION_LABEL_MAX_LEN = 40;
  const OPTION_POPUP_PHRASES = ['옵션을 선택', '옵션을 먼저 선택', '필수 옵션'];

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

  function textOf(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function truncateLabel(text) {
    if (text.length <= OPTION_LABEL_MAX_LEN) return text;
    return text.slice(0, OPTION_LABEL_MAX_LEN) + '...';
  }

  function isNegativeOption(text) {
    return NEGATIVE_OPTION_PATTERNS.some(r => r.test(text));
  }

  function isPlaceholderOption(text) {
    return PLACEHOLDER_PATTERNS.some(r => r.test(text));
  }

  function pickSelectOptionIndex(sel) {
    let firstValid = -1;
    for (let i = 0; i < sel.options.length; i++) {
      const opt = sel.options[i];
      const t = (opt.textContent || '').trim();
      if (isPlaceholderOption(t) || !opt.value) continue;
      if (isNegativeOption(t)) return i;
      if (firstValid === -1) firstValid = i;
    }
    return firstValid;
  }

  function pickListItem(items) {
    const valid = items.filter(el => !isPlaceholderOption(textOf(el)));
    const neg = valid.find(el => isNegativeOption(textOf(el)));
    return neg || valid[0] || null;
  }

  async function ensureDropdownOpen(container) {
    const row = (container.classList && container.classList.contains('gd_selRow'))
      ? container
      : (container.closest && container.closest('.gd_selRow'));
    if (!row) return false;
    const dt = row.querySelector('dt');
    const dd = row.querySelector('dd');
    if (!dt || !dd) return false;
    const style = dd.getAttribute('style') || '';
    const hidden = /display\s*:\s*none/i.test(style) || dd.offsetParent === null;
    if (!hidden) return false;
    const clickable = dt.querySelector('a') || dt;
    try { clickable.click(); } catch (e) {}
    await sleep(OPTION_DROPDOWN_OPEN_WAIT_MS);
    return true;
  }

  function selectFirstDefaultOption(container) {
    const sel = container.matches && container.matches('select')
      ? container
      : container.querySelector('select');
    if (sel && sel.options && sel.options.length > 0) {
      const chosenIdx = pickSelectOptionIndex(sel);
      if (chosenIdx >= 0) {
        if (sel.selectedIndex !== chosenIdx) {
          sel.selectedIndex = chosenIdx;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const label = truncateLabel((sel.options[chosenIdx].textContent || '').trim());
        return { ok: true, label };
      }
    }
    for (const itemSel of OPTION_ITEM_SELECTORS) {
      const items = container.querySelectorAll(itemSel);
      if (items.length === 0) continue;
      const chosen = pickListItem(Array.from(items));
      if (chosen) {
        const clickTarget = chosen.querySelector('a') || chosen;
        try { clickTarget.click(); } catch (e) {}
        return { ok: true, label: truncateLabel(textOf(chosen)) };
      }
    }
    return { ok: false };
  }

  async function selectAllOptions() {
    const seen = new Set();
    const selectedLabels = [];
    let detectedAny = false;
    let allSelected = true;
    for (const sel of OPTION_CONTAINER_SELECTORS) {
      const containers = document.querySelectorAll(sel);
      for (const c of containers) {
        if (seen.has(c)) continue;
        const unit = (c.closest && c.closest('.gd_selRow')) || c;
        if (seen.has(unit)) { seen.add(c); continue; }
        seen.add(c);
        seen.add(unit);
        detectedAny = true;
        await ensureDropdownOpen(unit);
        const res = selectFirstDefaultOption(unit);
        if (res.ok && res.label) selectedLabels.push(res.label);
        if (!res.ok) allSelected = false;
      }
    }
    if (detectedAny) await sleep(OPTION_SELECT_WAIT_MS);
    return { detectedAny, allSelected, selectedLabels };
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
      for (const p of OPTION_POPUP_PHRASES) if (t.includes(p)) return { status: 'error', reason: '옵션 자동 선택 실패(경고 팝업)' };
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

        const optRes = await selectAllOptions();
        if (optRes.detectedAny && !optRes.allSelected) {
          resolve({ status: 'error', reason: '옵션 자동 선택 실패', selectedOptions: optRes.selectedLabels });
          return;
        }

        let appliedQty = 1;
        if (qty > 1) {
          const r = await incrementQuantity(qty);
          if (!r.ok) {
            const out = { status: 'error', reason: '수량 설정 실패: ' + r.reason };
            if (optRes.selectedLabels.length > 0) out.selectedOptions = optRes.selectedLabels;
            resolve(out);
            return;
          }
          appliedQty = r.applied;
          if (appliedQty !== qty) {
            const out = { status: 'error', reason: `수량 제한 초과 (요청 ${qty}, 반영 ${appliedQty})`, appliedQty };
            if (optRes.selectedLabels.length > 0) out.selectedOptions = optRes.selectedLabels;
            resolve(out);
            return;
          }
        }

        found.click();

        waitFor(() => detectResult(), RESULT_TIMEOUT_MS).then((res) => {
          const base = res || { status: 'error', reason: '결과 확인 시간 초과' };
          base.appliedQty = appliedQty;
          if (optRes.selectedLabels.length > 0) base.selectedOptions = optRes.selectedLabels;
          resolve(base);
        });
      });
    } catch (e) {
      resolve({ status: 'error', reason: '예외: ' + (e && e.message || String(e)) });
    }
  });
})();
