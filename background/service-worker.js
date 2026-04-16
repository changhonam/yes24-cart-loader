const STATE_KEY = 'batchState';
const INJECT_TIMEOUT_MS = 15000;
const INJECT_RETRY_INTERVAL_MS = 300;
const DELAY_MIN_MS = 1500;
const DELAY_MAX_MS = 3000;

let state = {
  running: false,
  aborted: false,
  items: [],
  currentIndex: 0,
  results: [],
  rawInput: ''
};

async function loadState() {
  try {
    const obj = await chrome.storage.session.get(STATE_KEY);
    if (obj && obj[STATE_KEY]) {
      state = obj[STATE_KEY];
      if (state.running) {
        state.running = false;
        state.aborted = true;
      }
      if (Array.isArray(state.items)) {
        state.items.forEach(i => {
          if (!Number.isFinite(i.qty) || i.qty < 1) i.qty = 1;
        });
      }
      if (typeof state.rawInput !== 'string') state.rawInput = '';
    }
  } catch (e) {}
}

async function saveState() {
  try {
    await chrome.storage.session.set({ [STATE_KEY]: state });
  } catch (e) {}
}

function sendToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function buildUrl(goodsId, qty) {
  const base = `https://www.yes24.com/Product/Goods/${goodsId}`;
  const n = Number.isFinite(qty) && qty >= 1 ? qty : 1;
  return `${base}#qty=${n}`;
}

async function injectWithRetry(tabId, timeoutMs) {
  const startedAt = Date.now();
  let lastErr = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const injection = await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content-script.js']
      });
      const result = injection && injection[0] && injection[0].result;
      if (result) return result;
    } catch (e) {
      lastErr = e;
    }
    await sleep(INJECT_RETRY_INTERVAL_MS);
  }
  return { status: 'error', reason: '페이지 로딩 시간 초과' + (lastErr ? '' : '') };
}

async function closeTabSafe(tabId) {
  try { await chrome.tabs.remove(tabId); } catch (e) {}
}

function randomDelay() {
  return DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function processItem(item) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: buildUrl(item.goodsId, item.qty), active: false });
  } catch (e) {
    return { status: 'error', reason: '탭 생성 실패' };
  }

  const result = await injectWithRetry(tab.id, INJECT_TIMEOUT_MS);
  await closeTabSafe(tab.id);
  return result;
}

async function runBatch(rawItems, rawInput) {
  const items = (rawItems || []).map(i => ({
    goodsId: i.goodsId,
    originalInput: i.originalInput,
    qty: Number.isFinite(i.qty) && i.qty >= 1 ? i.qty : 1
  }));
  state = {
    running: true,
    aborted: false,
    items,
    currentIndex: 0,
    results: [],
    rawInput: typeof rawInput === 'string' ? rawInput : ''
  };
  await saveState();

  for (let i = 0; i < items.length; i++) {
    if (state.aborted) break;
    state.currentIndex = i;
    await saveState();
    sendToPopup({
      action: 'progress',
      currentIndex: i,
      total: items.length,
      results: state.results,
      items
    });

    const item = items[i];
    const result = await processItem(item);
    result.goodsId = item.goodsId;
    result.requestedQty = item.qty;
    state.results[i] = result;
    await saveState();

    sendToPopup({
      action: 'progress',
      currentIndex: i + 1,
      total: items.length,
      results: state.results,
      items
    });

    if (result.status === 'error' && result.reason === '미로그인') {
      state.aborted = true;
      break;
    }

    if (i < items.length - 1 && !state.aborted) {
      await sleep(randomDelay());
    }
  }

  for (let i = 0; i < items.length; i++) {
    if (!state.results[i]) {
      state.results[i] = {
        goodsId: items[i].goodsId,
        requestedQty: items[i].qty,
        status: 'cancelled',
        reason: '취소됨'
      };
    }
  }

  state.running = false;
  state.currentIndex = items.length;
  await saveState();

  sendToPopup({
    action: 'batchComplete',
    total: items.length,
    results: state.results,
    items
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'startBatchAdd') {
    if (state.running) {
      sendResponse({ ok: false, reason: 'already running' });
      return false;
    }
    runBatch(msg.items || [], msg.rawInput);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === 'stopBatchAdd') {
    state.aborted = true;
    saveState();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === 'getStatus') {
    (async () => {
      await loadState();
      sendResponse(state);
    })();
    return true;
  }
});

loadState();
