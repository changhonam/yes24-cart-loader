const RE_NEW = /yes24\.com\/Product\/Goods\/(\d+)/i;
const RE_OLD = /yes24\.com\/24\/goods\/(\d+)/i;
const RE_ID = /^\d+$/;

const urlsEl = document.getElementById('urls');
const countsEl = document.getElementById('counts');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const progressWrap = document.getElementById('progressWrap');
const progressText = document.getElementById('progressText');
const progressFill = document.getElementById('progressFill');
const resultsEl = document.getElementById('results');
const summaryEl = document.getElementById('summary');

let currentItems = [];
let currentInvalidCount = 0;
let currentTotalLines = 0;

function extractGoodsId(line) {
  const m1 = line.match(RE_NEW);
  if (m1) return m1[1];
  const m2 = line.match(RE_OLD);
  if (m2) return m2[1];
  if (RE_ID.test(line)) return line;
  return null;
}

function parseInput(text) {
  const lines = text.split('\n');
  const aggMap = new Map();
  let totalLines = 0;
  let invalidCount = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    totalLines += 1;
    const goodsId = extractGoodsId(line);
    if (!goodsId) {
      invalidCount += 1;
      continue;
    }
    const prev = aggMap.get(goodsId);
    if (prev) {
      prev.qty += 1;
    } else {
      aggMap.set(goodsId, { goodsId, qty: 1, originalInput: line, valid: true });
    }
  }

  return {
    items: Array.from(aggMap.values()),
    totalLines,
    invalidCount
  };
}

function totalQty(items) {
  return items.reduce((sum, i) => sum + (i.qty || 1), 0);
}

function updateCounts(items, totalLines, invalidCount) {
  const species = items.length;
  const qtySum = totalQty(items);
  countsEl.textContent = `입력 ${totalLines}줄 · 유효 ${species}종 (${qtySum}권)` + (invalidCount > 0 ? ` · 무효 ${invalidCount}줄` : '');
  startBtn.disabled = species === 0;
}

function onInputChange() {
  const parsed = parseInput(urlsEl.value);
  currentItems = parsed.items;
  currentInvalidCount = parsed.invalidCount;
  currentTotalLines = parsed.totalLines;
  updateCounts(currentItems, currentTotalLines, currentInvalidCount);
}

urlsEl.addEventListener('input', onInputChange);

function iconFor(status) {
  switch (status) {
    case 'success': return '✓';
    case 'error': return '✗';
    case 'skipped': return '✗';
    case 'cancelled': return '○';
    case 'processing': return '⏳';
    default: return '○';
  }
}

function classFor(status) {
  if (status === 'success') return 'success';
  if (status === 'error' || status === 'skipped') return 'error';
  if (status === 'processing') return 'processing';
  return 'pending';
}

function renderResults(items, results, currentIndex, running) {
  resultsEl.innerHTML = '';
  items.forEach((item, idx) => {
    const li = document.createElement('li');
    let status, reason;
    if (results[idx]) {
      status = results[idx].status;
      reason = results[idx].reason;
    } else if (running && idx === currentIndex) {
      status = 'processing';
      reason = '처리 중...';
    } else {
      status = 'pending';
      reason = '대기 중';
    }
    li.className = classFor(status);
    const qty = item.qty || 1;
    const label = item.goodsId || item.originalInput.slice(0, 20);
    li.textContent = `${iconFor(status)} ${label} × ${qty}권 - ${reason}`;
    resultsEl.appendChild(li);
  });
}

function renderSummary(items, results) {
  const totalSpecies = items.length;
  const totalQtyAll = totalQty(items);
  let successSpecies = 0;
  let successQty = 0;
  let errorSpecies = 0;
  for (let i = 0; i < items.length; i++) {
    const r = results[i];
    if (!r) continue;
    if (r.status === 'success') {
      successSpecies += 1;
      successQty += (items[i].qty || 1);
    } else if (r.status === 'error' || r.status === 'skipped' || r.status === 'cancelled') {
      errorSpecies += 1;
    }
  }
  const remainSpecies = totalSpecies - successSpecies - errorSpecies;
  summaryEl.hidden = false;
  summaryEl.textContent = `결과: 성공 ${successSpecies}종(${successQty}권) / 실패 ${errorSpecies}종 / 남은 ${remainSpecies}종 · 전체 ${totalSpecies}종(${totalQtyAll}권)`;
}

function renderProgress(currentIndex, total, items, results) {
  progressWrap.hidden = false;
  let accQty = 0;
  if (Array.isArray(items) && Array.isArray(results)) {
    for (let i = 0; i < items.length; i++) {
      const r = results[i];
      if (r && r.status === 'success') accQty += (items[i].qty || 1);
    }
  }
  progressText.textContent = `진행: ${currentIndex} / ${total}종 · 누적 ${accQty}권`;
  const pct = total > 0 ? Math.round((currentIndex / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
}

function setRunningUI(running) {
  urlsEl.disabled = running;
  startBtn.disabled = running || currentItems.length === 0;
  stopBtn.disabled = !running;
}

startBtn.addEventListener('click', () => {
  const validItems = currentItems.map(i => ({
    goodsId: i.goodsId,
    originalInput: i.originalInput,
    qty: i.qty || 1
  }));
  if (validItems.length === 0) return;
  resultsEl.innerHTML = '';
  summaryEl.hidden = true;
  chrome.runtime.sendMessage({
    action: 'startBatchAdd',
    items: validItems,
    rawInput: urlsEl.value
  }, () => {
    setRunningUI(true);
    renderProgress(0, validItems.length, validItems, []);
    renderResults(validItems, [], 0, true);
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stopBatchAdd' });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'progress') {
    const items = (msg.items || []).map(i => ({ ...i, qty: i.qty || 1 }));
    renderProgress(msg.currentIndex, msg.total, items, msg.results || []);
    renderResults(items, msg.results || [], msg.currentIndex, true);
    renderSummary(items, msg.results || []);
  } else if (msg.action === 'batchComplete') {
    const items = (msg.items || []).map(i => ({ ...i, qty: i.qty || 1 }));
    setRunningUI(false);
    renderProgress(msg.total, msg.total, items, msg.results || []);
    renderResults(items, msg.results || [], msg.total, false);
    renderSummary(items, msg.results || []);
  }
});

chrome.runtime.sendMessage({ action: 'getStatus' }, (state) => {
  if (!state) return;
  const stateItems = Array.isArray(state.items)
    ? state.items.map(i => ({
        goodsId: i.goodsId,
        originalInput: i.originalInput,
        qty: i.qty || 1,
        valid: true
      }))
    : [];

  if (typeof state.rawInput === 'string' && state.rawInput.length > 0) {
    urlsEl.value = state.rawInput;
    onInputChange();
  } else if (stateItems.length > 0) {
    urlsEl.value = stateItems.map(i => i.originalInput).join('\n');
    onInputChange();
  }

  if (state.running) {
    setRunningUI(true);
    renderProgress(state.currentIndex, stateItems.length, stateItems, state.results || []);
    renderResults(stateItems, state.results || [], state.currentIndex, true);
    renderSummary(stateItems, state.results || []);
  } else if (state.results && state.results.length > 0 && stateItems.length > 0) {
    renderResults(stateItems, state.results, stateItems.length, false);
    renderSummary(stateItems, state.results);
    renderProgress(stateItems.length, stateItems.length, stateItems, state.results);
  }
});

onInputChange();
