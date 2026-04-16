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

function parseInput(text) {
  const lines = text.split('\n');
  const items = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let goodsId = null;
    const m1 = line.match(RE_NEW);
    const m2 = line.match(RE_OLD);
    if (m1) goodsId = m1[1];
    else if (m2) goodsId = m2[1];
    else if (RE_ID.test(line)) goodsId = line;
    items.push({ goodsId, originalInput: line, valid: !!goodsId });
  }
  return items;
}

function updateCounts(items) {
  const valid = items.filter(i => i.valid).length;
  countsEl.textContent = `인식된 도서: ${items.length}개 (유효: ${valid})`;
  startBtn.disabled = valid === 0;
}

function onInputChange() {
  currentItems = parseInput(urlsEl.value);
  updateCounts(currentItems);
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
    if (!item.valid) {
      status = 'skipped';
      reason = '유효하지 않은 URL';
    } else if (results[idx]) {
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
    const label = item.goodsId || item.originalInput.slice(0, 20);
    li.textContent = `${iconFor(status)} ${label} - ${reason}`;
    resultsEl.appendChild(li);
  });
}

function renderSummary(items, results) {
  const total = items.filter(i => i.valid).length;
  const success = results.filter(r => r && r.status === 'success').length;
  const error = results.filter(r => r && (r.status === 'error' || r.status === 'skipped')).length;
  const remain = total - success - error;
  summaryEl.hidden = false;
  summaryEl.textContent = `결과: 성공 ${success} / 실패 ${error} / 남은 ${remain}`;
}

function renderProgress(currentIndex, total) {
  progressWrap.hidden = false;
  progressText.textContent = `진행: ${currentIndex} / ${total}`;
  const pct = total > 0 ? Math.round((currentIndex / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
}

function setRunningUI(running) {
  urlsEl.disabled = running;
  startBtn.disabled = running || currentItems.filter(i => i.valid).length === 0;
  stopBtn.disabled = !running;
}

startBtn.addEventListener('click', () => {
  const validItems = currentItems.filter(i => i.valid).map(i => ({
    goodsId: i.goodsId,
    originalInput: i.originalInput
  }));
  if (validItems.length === 0) return;
  resultsEl.innerHTML = '';
  summaryEl.hidden = true;
  chrome.runtime.sendMessage({ action: 'startBatchAdd', items: validItems }, () => {
    setRunningUI(true);
    renderProgress(0, validItems.length);
    renderResults(currentItems, [], 0, true);
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stopBatchAdd' });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'progress') {
    const displayItems = currentItems.length > 0 ? currentItems : msg.items.map(i => ({ ...i, valid: true }));
    renderProgress(msg.currentIndex, msg.total);
    renderResults(displayItems, msg.results, msg.currentIndex, true);
    renderSummary(displayItems, msg.results);
  } else if (msg.action === 'batchComplete') {
    const displayItems = currentItems.length > 0 ? currentItems : msg.items.map(i => ({ ...i, valid: true }));
    setRunningUI(false);
    renderProgress(msg.total, msg.total);
    renderResults(displayItems, msg.results, msg.total, false);
    renderSummary(displayItems, msg.results);
  }
});

chrome.runtime.sendMessage({ action: 'getStatus' }, (state) => {
  if (!state) return;
  if (state.running) {
    const items = state.items.map(i => ({ goodsId: i.goodsId, originalInput: i.originalInput, valid: true }));
    currentItems = items;
    urlsEl.value = items.map(i => i.originalInput).join('\n');
    updateCounts(items);
    setRunningUI(true);
    renderProgress(state.currentIndex, items.length);
    renderResults(items, state.results, state.currentIndex, true);
    renderSummary(items, state.results);
  } else if (state.results && state.results.length > 0 && state.items && state.items.length > 0) {
    const items = state.items.map(i => ({ goodsId: i.goodsId, originalInput: i.originalInput, valid: true }));
    renderResults(items, state.results, items.length, false);
    renderSummary(items, state.results);
  }
});

onInputChange();
