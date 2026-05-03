const state = {
  stores: [], selectedStore: null, adult: 2, child: 0,
  activeTab: 'stores', sessionId: null,
  pollInterval: null, storePollInterval: null, monitorInterval: null,
};
const SESSION_KEY = 'sushiroad_session';
const SETTINGS_KEY = 'sushiroad_settings';
const HISTORY_KEY = 'sushiroad_history';
const PINNED_STORES_KEY = 'sushiroad_pinned_stores';
const ACCOUNT_EMAIL_KEY = 'sushiroad_account_email';
const SEAT_LABEL = { TABLE: '桌位', COUNTER: '吧台', T: '桌位', C: '吧台' };

function esc(s) { return s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function validNtfyTopic(t) { return typeof t === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(t); }
function formatNtfyTopic(raw, maxLen = 64) {
  let topic = String(raw || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  if (topic.length > maxLen) topic = topic.slice(0, maxLen).replace(/^[-_]+|[-_]+$/g, '');
  return topic;
}
function fallbackNtfyTopic() { return 'user-' + Math.random().toString(36).slice(2, 8); }
function makeTopic(email) {
  const raw = (email || '').split('@')[0] || '';
  const suffix = '-sushiroad';
  const prefix = formatNtfyTopic(raw, 8);
  const safePrefix = prefix || formatNtfyTopic(fallbackNtfyTopic(), 64 - suffix.length);
  return `${safePrefix}${suffix}`;
}
function escJs(s) { return s == null ? '' : String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function validTimeValue(v) {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}
function defaultTargetTime() {
  const now = new Date();
  now.setMinutes(now.getMinutes() + 30);
  return now.toTimeString().slice(0, 5);
}

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

function getSetting(k, d) { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY))?.[k] ?? d; } catch { return d; } }
function setSetting(k, v) {
  const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  s[k] = v;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  persistAccountSettings({ [k]: v });
}
function persistAccountSettings(settings) {
  if (!state.sessionId || state.applyingRemoteSettings) return;
  fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: state.sessionId, settings }),
  }).catch(() => {});
}
function getLocalSettingsSnapshot() {
  const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  return {
    ntfyTopic: validNtfyTopic(settings.ntfyTopic) ? settings.ntfyTopic : getDefaultNtfyTopic(),
    ntfyTopicAuto: settings.ntfyTopicAuto ?? shouldUseAutoNtfyTopic(),
    storePoll: getSetting('storePoll', 60),
    schedulePoll: getSetting('schedulePoll', 60),
    earlyWindow: getSetting('earlyWindow', 10),
    lateWindow: getSetting('lateWindow', 5),
    reservationAdult: getSetting('reservationAdult', 2),
    reservationChild: getSetting('reservationChild', 0),
    pinnedStoreIds: loadPinnedStoreIds(),
    userLat: Number.isFinite(Number(settings.userLat)) ? Number(settings.userLat) : null,
    userLon: Number.isFinite(Number(settings.userLon)) ? Number(settings.userLon) : null,
  };
}
function applyAccountSettings(settings) {
  if (!settings) return;
  state.applyingRemoteSettings = true;
  try {
    const current = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...current, ...settings }));
    if (Array.isArray(settings.pinnedStoreIds)) {
      localStorage.setItem(PINNED_STORES_KEY, JSON.stringify(settings.pinnedStoreIds.map(String)));
    }

    applyReservationPeople(settings.reservationAdult ?? 2, settings.reservationChild ?? 0);
    $('#target-time').value = defaultTargetTime();
    $('#setting-store-poll').value = settings.storePoll ?? 60;
    $('#setting-schedule-poll').value = settings.schedulePoll ?? 60;
    $('#setting-ntfy-topic').value = validNtfyTopic(settings.ntfyTopic) ? settings.ntfyTopic : getDefaultNtfyTopic();
    $('#setting-early-window').value = settings.earlyWindow ?? 10;
    $('#setting-late-window').value = settings.lateWindow ?? 5;

    const lat = Number(settings.userLat);
    const lon = Number(settings.userLon);
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      state.userLat = lat;
      state.userLon = lon;
      $('#btn-location')?.classList.add('active');
    } else {
      state.userLat = state.userLon = null;
      $('#btn-location')?.classList.remove('active');
    }

    hideNtfyTopicError();
    startStorePoll();
    renderCurrentStores();
  } finally {
    state.applyingRemoteSettings = false;
  }
}
async function syncAccountSettings(settings, settingsExists) {
  if (!state.sessionId) return;
  if (settingsExists) {
    applyAccountSettings(settings);
    return;
  }
  const localSettings = getLocalSettingsSnapshot();
  try {
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, settings: localSettings }),
    });
    const data = await res.json();
    applyAccountSettings(data.settings || localSettings);
  } catch {
    applyAccountSettings(settings || localSettings);
  }
}
function shouldUseAutoNtfyTopic() {
  const topic = getSetting('ntfyTopic', '');
  const auto = getSetting('ntfyTopicAuto', null);
  return !validNtfyTopic(topic) || auto === true || (auto == null && /^user-[a-z0-9]{6}-sushiroad$/.test(topic));
}
function setAutoNtfyTopic(topic) {
  setSetting('ntfyTopic', topic);
  setSetting('ntfyTopicAuto', true);
  const input = $('#setting-ntfy-topic');
  if (input) input.value = topic;
  hideNtfyTopicError();
}
function applyLoginNtfyTopic(topic) {
  const normalized = formatNtfyTopic(topic);
  if (!validNtfyTopic(normalized) || !shouldUseAutoNtfyTopic()) return;
  setAutoNtfyTopic(normalized);
}
function getSavedAccountEmail() {
  return localStorage.getItem(ACCOUNT_EMAIL_KEY) || getSetting('accountEmail', '');
}
function saveAccountEmail(email) {
  const normalized = String(email || '').trim();
  if (!normalized) return;
  localStorage.setItem(ACCOUNT_EMAIL_KEY, normalized);
  setSetting('accountEmail', normalized);
}
function getSessionEmail() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY))?.email || getSavedAccountEmail();
  } catch {
    return getSavedAccountEmail();
  }
}
function getDefaultNtfyTopic() { return makeTopic(getSessionEmail()); }
function getStoredValidNtfyTopic() {
  const topic = getSetting('ntfyTopic', '');
  return validNtfyTopic(topic) ? topic : '';
}
function getEffectiveNtfyTopic() {
  const stored = getStoredValidNtfyTopic();
  return stored || getDefaultNtfyTopic();
}
function showNtfyTopicError(msg) {
  const el = $('#ntfy-topic-error');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}
function hideNtfyTopicError() {
  const el = $('#ntfy-topic-error');
  if (!el) return;
  el.textContent = '';
  el.style.display = 'none';
}
function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; } }
function saveHistory(h) { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); }
function addHistory(e) { const h = loadHistory(); h.unshift(e); if (h.length > 50) h.length = 50; saveHistory(h); }
function saveReservationPeople() {
  setSetting('reservationAdult', state.adult);
  setSetting('reservationChild', state.child);
}
function applyReservationPeople(adult, child) {
  state.adult = clampInt(adult, 1, 18, 2);
  state.child = clampInt(child, 0, 17, 0);
  $('#adult-count').textContent = state.adult;
  $('#child-count').textContent = state.child;
}
function loadPinnedStoreIds() {
  try {
    const ids = JSON.parse(localStorage.getItem(PINNED_STORES_KEY)) || [];
    if (Array.isArray(ids) && ids.length) return ids.map(String);
    const synced = getSetting('pinnedStoreIds', []);
    return Array.isArray(synced) ? synced.map(String) : [];
  } catch {
    return [];
  }
}
function savePinnedStoreIds(ids) {
  const normalized = [...new Set(ids.map(String))];
  localStorage.setItem(PINNED_STORES_KEY, JSON.stringify(normalized));
  setSetting('pinnedStoreIds', normalized);
}
function isPinnedStore(id) {
  return loadPinnedStoreIds().includes(String(id));
}
function togglePinStore(id, event) {
  event?.stopPropagation();
  const sid = String(id);
  const pinned = loadPinnedStoreIds();
  const next = pinned.includes(sid) ? pinned.filter(x => x !== sid) : [...pinned, sid];
  savePinnedStoreIds(next);
  renderCurrentStores();
}
function getVisibleStores(stores) {
  const hasLoc = state.userLat != null;
  const pinnedIds = loadPinnedStoreIds();
  const pinnedSet = new Set(pinnedIds);
  const byId = new Map(stores.map(s => [String(s.id), s]));
  const pinned = pinnedIds.map(id => byId.get(id)).filter(Boolean);
  const regular = stores.filter(s => !pinnedSet.has(String(s.id)));
  if (hasLoc) regular.sort((a,b) => a._dist - b._dist);
  return { pinned, regular, hasLoc };
}
function movePinnedStore(dragId, targetId) {
  if (!dragId || !targetId || dragId === targetId) return;
  const pinned = loadPinnedStoreIds();
  const from = pinned.indexOf(String(dragId));
  const to = pinned.indexOf(String(targetId));
  if (from < 0 || to < 0) return;
  const [item] = pinned.splice(from, 1);
  pinned.splice(to, 0, item);
  savePinnedStoreIds(pinned);
  renderCurrentStoresWithPinnedAnimation();
}

function distanceKm(lat1,lon1,lat2,lon2) { const R=6371,dLat=(lat2-lat1)*Math.PI/180,dLon=(lon2-lon1)*Math.PI/180,a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2; return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)); }
function fmtDist(km) { return km < 1 ? Math.round(km*1000)+' m' : km.toFixed(1)+' km'; }

// ==================== Init ====================
async function init() {
  await loadStores();
  bindEvents();
  initSettings();
  startStorePoll();
}

// ==================== Tabs ====================
function switchTab(tab) {
  state.activeTab = tab;
  $$('.tab-page').forEach(p => p.classList.remove('active'));
  $$('.tab-btn').forEach(b => b.classList.remove('active'));
  $(`#page-${tab}`).classList.add('active');
  $(`.tab-btn[data-tab="${tab}"]`).classList.add('active');
  if (tab === 'history') renderHistory();
  if (tab === 'monitor') renderMonitor();
}

// ==================== Stores ====================
async function loadStores() {
  $('#store-list').innerHTML = '<div class="loading"><div class="spinner"></div><p>載入中...</p></div>';
  try {
    const res = await fetch('/api/stores');
    state.stores = await res.json();
    renderCurrentStores();
  } catch (err) {
    $('#store-list').innerHTML = `<div class="error-msg">載入失敗: ${esc(err.message)}</div>`;
  }
}

function renderStores(stores) {
  const hasLoc = state.userLat != null;
  if (hasLoc) stores.forEach(s => { s._dist = distanceKm(state.userLat, state.userLon, s.latitude, s.longitude); });
  const { pinned, regular } = getVisibleStores(stores);

  let html = '';
  if (pinned.length) {
    html += `<div class="pinned-group"><div class="area-header">置頂店鋪 (${pinned.length})</div>`;
    pinned.forEach(s => { html += storeCard(s, hasLoc, true); });
    html += '</div>';
  }

  if (hasLoc) {
    regular.forEach(s => { html += storeCard(s, true, false); });
  } else {
    const grouped = {};
    regular.forEach(s => { (grouped[s.area||'其他'] ??= []).push(s); });
    for (const [area, list] of Object.entries(grouped)) {
      html += `<div class="area-group"><div class="area-header">${esc(area)} (${list.length})</div>`;
      list.forEach(s => { html += storeCard(s, false, false); });
      html += '</div>';
    }
  }
  $('#store-list').innerHTML = html || '<div class="empty-state">找不到符合條件的店鋪</div>';
}

function storeCard(s, showDist, pinned = isPinnedStore(s.id)) {
  const open = s.storeStatus === 'OPEN';
  const wait = open && s.wait > 0 ? `<div class="wait-time has-wait">等候 ${s.wait} 分鐘</div>` : '';
  const dist = showDist && s._dist != null ? `<div class="store-distance">${fmtDist(s._dist)}</div>` : '';
  const rawId = String(s.id);
  const id = escJs(rawId);
  const dragging = rawId === state.draggedPinnedStoreId || rawId === state.pointerDraggedPinnedStoreId;
  const drag = pinned
    ? `<button class="pin-drag-handle" draggable="true" title="拖曳排序" onclick="event.stopPropagation()" onpointerdown="startPinnedStorePointerDrag(event,'${id}')" ondragstart="startPinnedStoreDrag(event,'${id}')" ondragend="endPinnedStoreDrag(event)">::</button>`
    : '';
  const pinTitle = pinned ? '取消置頂' : '置頂店鋪';
  return `<div class="store-card ${pinned ? 'pinned-store' : ''} ${dragging ? 'dragging' : ''}" data-store-id="${esc(rawId)}" onclick="selectStore('${id}')" ondragenter="overPinnedStoreDrag(event,'${id}')" ondragover="overPinnedStoreDrag(event,'${id}')" ondrop="dropPinnedStoreDrag(event,'${id}')">
    ${drag}
    <div class="store-main"><div class="store-name">${esc(s.name)}</div><div class="store-address">${esc(s.address)}</div>${dist}</div>
    <div class="store-status"><span class="status-badge ${open?'open':'closed'}">${open?'營業中':'未營業'}</span>${wait}</div>
    <button class="pin-store-btn ${pinned ? 'active' : ''}" title="${pinTitle}" aria-label="${pinTitle}" onclick="togglePinStore('${id}', event)">${pinned ? '★' : '☆'}</button>
  </div>`;
}

function getStoresMatchingQuery(q) {
  if (!q) return state.stores;
  const ql = q.toLowerCase();
  return state.stores.filter(s => s.name.toLowerCase().includes(ql) || (s.area||'').toLowerCase().includes(ql));
}
function renderCurrentStores() {
  renderStores(getStoresMatchingQuery($('#store-search')?.value || ''));
}
function renderCurrentStoresWithPinnedAnimation() {
  const before = new Map([...document.querySelectorAll('.pinned-store')].map(el => [el.dataset.storeId, el.getBoundingClientRect()]));
  renderCurrentStores();
  requestAnimationFrame(() => {
    document.querySelectorAll('.pinned-store').forEach(el => {
      const oldRect = before.get(el.dataset.storeId);
      if (!oldRect) return;
      const newRect = el.getBoundingClientRect();
      const dx = oldRect.left - newRect.left;
      const dy = oldRect.top - newRect.top;
      if (!dx && !dy) return;
      el.animate([
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: 'translate(0, 0)' },
      ], { duration: 150, easing: 'ease-out' });
    });
  });
}
function filterStores(q) {
  renderStores(getStoresMatchingQuery(q));
}
function startPinnedStoreDrag(event, id) {
  event.stopPropagation();
  state.draggedPinnedStoreId = String(id);
  state.lastPinnedDragTargetId = null;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(id));
  event.currentTarget.closest('.store-card')?.classList.add('dragging');
}
function overPinnedStoreDrag(event, id) {
  if (!state.draggedPinnedStoreId || !isPinnedStore(id)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  if (state.lastPinnedDragTargetId === String(id)) return;
  state.lastPinnedDragTargetId = String(id);
  movePinnedStore(state.draggedPinnedStoreId, id);
}
function dropPinnedStoreDrag(event, id) {
  if (!state.draggedPinnedStoreId || !isPinnedStore(id)) return;
  event.preventDefault();
  event.stopPropagation();
  state.draggedPinnedStoreId = null;
  state.lastPinnedDragTargetId = null;
  renderCurrentStores();
}
function endPinnedStoreDrag(event) {
  event.currentTarget.closest('.store-card')?.classList.remove('dragging');
  state.draggedPinnedStoreId = null;
  state.lastPinnedDragTargetId = null;
  renderCurrentStores();
}
function startPinnedStorePointerDrag(event, id) {
  event.stopPropagation();
  state.pointerDraggedPinnedStoreId = String(id);
  state.lastPinnedDragTargetId = null;
  state.pointerDragStartedAt = { x: event.clientX, y: event.clientY };
  event.currentTarget.closest('.store-card')?.classList.add('dragging');
  document.addEventListener('pointermove', movePinnedStorePointerDrag);
  document.addEventListener('pointerup', finishPinnedStorePointerDrag, { once: true });
  document.addEventListener('pointercancel', cancelPinnedStorePointerDrag, { once: true });
}
function movePinnedStorePointerDrag(event) {
  const dragId = state.pointerDraggedPinnedStoreId;
  if (!dragId) return;
  const targetCard = document.elementFromPoint(event.clientX, event.clientY)?.closest('.pinned-store');
  const targetId = targetCard?.dataset.storeId;
  if (!targetId || targetId === dragId || state.lastPinnedDragTargetId === targetId) return;
  state.lastPinnedDragTargetId = targetId;
  movePinnedStore(dragId, targetId);
}
function finishPinnedStorePointerDrag(event) {
  const dragId = state.pointerDraggedPinnedStoreId;
  if (dragId) movePinnedStorePointerDrag(event);
  cancelPinnedStorePointerDrag();
}
function cancelPinnedStorePointerDrag() {
  document.removeEventListener('pointermove', movePinnedStorePointerDrag);
  document.querySelector('.store-card.dragging')?.classList.remove('dragging');
  state.pointerDraggedPinnedStoreId = null;
  state.pointerDragStartedAt = null;
  state.lastPinnedDragTargetId = null;
  renderCurrentStores();
}

function selectStore(id) {
  state.selectedStore = state.stores.find(s => String(s.id) === String(id));
  if (!state.selectedStore) return;
  const s = state.selectedStore, open = s.storeStatus === 'OPEN';
  const dist = s._dist != null ? `<div class="store-distance">${fmtDist(s._dist)}</div>` : '';
  $('#selected-store-info').innerHTML = `<div><div class="store-name">${esc(s.name)}</div><div class="store-address">${esc(s.address)}</div>${dist}</div>
    <div class="store-status"><span class="status-badge ${open?'open':'closed'}">${open?'營業中':'未營業'}</span></div>`;
  showStep('config');
}

function showStep(s) { $$('#page-stores .step').forEach(el => el.classList.remove('active')); $(`#step-${s}`).classList.add('active'); }

function startStorePoll() {
  if (state.storePollInterval) clearInterval(state.storePollInterval);
  const sec = getSetting('storePoll', 60);
  if (sec > 0) state.storePollInterval = setInterval(() => { if (state.activeTab === 'stores') loadStores(); }, sec * 1000);
}

// ==================== Events ====================
function bindEvents() {
  $('#store-search').addEventListener('input', e => filterStores(e.target.value));
  $$('.stepper-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.target, a = btn.dataset.action;
      if (t === 'adult') { state.adult = Math.max(1, Math.min(18, state.adult + (a === 'inc' ? 1 : -1))); $('#adult-count').textContent = state.adult; }
      else { state.child = Math.max(0, Math.min(17, state.child + (a === 'inc' ? 1 : -1))); $('#child-count').textContent = state.child; }
      saveReservationPeople();
    });
  });
  $('#btn-back').addEventListener('click', () => showStep('store'));
  $('#btn-submit').addEventListener('click', handleSubmit);
  $('#btn-new').addEventListener('click', () => showStep('store'));
  $$('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#btn-clear-history').addEventListener('click', () => { if (confirm('清除所有紀錄？')) { saveHistory([]); renderHistory(); } });
  $('#setting-store-poll').addEventListener('change', e => { setSetting('storePoll', Number(e.target.value)); startStorePoll(); });
  $('#setting-schedule-poll').addEventListener('change', e => setSetting('schedulePoll', Number(e.target.value)));
  $('#target-time').addEventListener('focus', e => {
    if (!validTimeValue(e.target.value)) e.target.value = defaultTargetTime();
  });
  $('#setting-ntfy-topic').addEventListener('input', () => hideNtfyTopicError());
  $('#setting-ntfy-topic').addEventListener('blur', e => {
    const raw = e.target.value.trim();
    if (validNtfyTopic(raw)) {
      e.target.value = raw;
      setSetting('ntfyTopic', raw);
      setSetting('ntfyTopicAuto', false);
      hideNtfyTopicError();
      return;
    }
    const fallback = getEffectiveNtfyTopic();
    e.target.value = fallback;
    setSetting('ntfyTopic', fallback);
    setSetting('ntfyTopicAuto', shouldUseAutoNtfyTopic());
    showNtfyTopicError('Topic 僅允許英文字母、數字、底線 (_) 與連字號 (-)，不接受句點 (.)，已還原為前一個有效值。');
  });
  $('#setting-early-window').addEventListener('change', e => { const n = Number(e.target.value); setSetting('earlyWindow', Number.isFinite(n) ? Math.max(0, Math.min(30, n)) : 10); });
  $('#setting-late-window').addEventListener('change', e => { const n = Number(e.target.value); setSetting('lateWindow', Number.isFinite(n) ? Math.max(0, Math.min(30, n)) : 5); });
}

function initSettings() {
  applyReservationPeople(getSetting('reservationAdult', 2), getSetting('reservationChild', 0));
  $('#target-time').value = defaultTargetTime();
  $('#setting-store-poll').value = getSetting('storePoll', 60);
  $('#setting-schedule-poll').value = getSetting('schedulePoll', 60);
  const storedTopic = getSetting('ntfyTopic', '');
  const normalizedTopic = formatNtfyTopic(storedTopic);
  const effectiveTopic = validNtfyTopic(normalizedTopic) ? normalizedTopic : getDefaultNtfyTopic();
  $('#setting-ntfy-topic').value = effectiveTopic;
  if (validNtfyTopic(storedTopic)) {
    setSetting('ntfyTopic', effectiveTopic);
  }
  hideNtfyTopicError();
  $('#setting-early-window').value = getSetting('earlyWindow', 10);
  $('#setting-late-window').value = getSetting('lateWindow', 5);
  if (!state.sessionId) updateLoginUI(null);
}

// ==================== Submit ====================
async function handleSubmit() {
  if (!state.selectedStore) return;
  if (!state.sessionId) {
    $('#ticket-status').innerHTML = `<div class="status-icon">🔒</div><div class="status-text">請先登入</div><div class="status-subtext">到設定頁面登入壽司郎帳號</div>`;
    $('#btn-cancel-ticket').style.display = 'none';
    $('#schedule-logs').style.display = 'none';
    showStep('status');
    return;
  }

  const targetTime = $('#target-time').value;
  if (!targetTime) return alert('請選擇用餐時間');
  saveReservationPeople();

  $('#btn-submit').disabled = true;
  $('#btn-submit').textContent = '處理中...';

  try {
    await tryBookOrMonitor(targetTime);
  } catch (err) {
    alert('操作失敗: ' + err.message);
  } finally {
    $('#btn-submit').disabled = false;
    $('#btn-submit').textContent = '預約 / 監控';
  }
}

async function tryBookOrMonitor(targetTime) {
  const storeid = state.selectedStore.id;
  const totalPersons = state.adult + state.child;
  const targetMins = parseInt(targetTime.split(':')[0]) * 60 + parseInt(targetTime.split(':')[1]);

  // Get today's date in yyyyMMdd
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).replace(/-/g, '');

  // Fetch available slots
  const res = await fetch(`/api/stores/${storeid}/timeslots?numpersons=${totalPersons}&tabletype=T`);
  const slots = await res.json();
  const available = Array.isArray(slots) ? slots.filter(s => s.availability === 'AVAILABLE' && s.date === today) : [];

  // Find slots within ±15 minutes of target
  const nearby = [];
  for (const s of available) {
    const slotMins = parseInt(s.start.substring(0,2)) * 60 + parseInt(s.start.substring(2,4));
    const diff = slotMins - targetMins;
    if (Math.abs(diff) <= 15) {
      const timeLabel = s.start.substring(0,2) + ':' + s.start.substring(2,4);
      nearby.push({ ...s, slotMins, diff, timeLabel });
    }
  }

  if (nearby.length === 0) {
    // No slots → start monitoring
    await startMonitoring(targetTime);
    return;
  }

  // Check if exact match exists (diff === 0)
  const exact = nearby.find(s => s.diff === 0);
  if (exact) {
    await confirmAndReserve(exact);
    return;
  }

  // Multiple nearby slots → ask user to pick
  showSlotPicker(nearby, targetTime);
}

function showSlotPicker(slots, targetTime) {
  let html = `
    <div class="status-icon">📅</div>
    <div class="status-text">選擇預約時段</div>
    <div class="status-subtext">指定時間 ${esc(targetTime)} 無可用時段，以下為 ±15 分鐘內可選時段：</div>
    <div style="margin-top:12px">`;
  for (const s of slots) {
    const diffLabel = s.diff > 0 ? `晚 ${s.diff} 分鐘` : `早 ${Math.abs(s.diff)} 分鐘`;
    html += `<button class="btn btn-secondary" style="margin:4px;padding:10px 16px" onclick="pickSlot('${escJs(s.date)}','${escJs(s.start)}','${escJs(s.end)}')">${esc(s.timeLabel)} (${diffLabel})</button>`;
  }
  html += `</div>
    <div style="margin-top:12px">
      <button class="btn btn-secondary btn-sm" onclick="startMonitoringFromUI('${escJs(targetTime)}')">改用監控模式</button>
    </div>`;
  $('#ticket-status').innerHTML = html;
  $('#btn-cancel-ticket').style.display = 'none';
  $('#schedule-logs').style.display = 'none';
  showStep('status');
}

async function pickSlot(date, start, end) {
  await confirmAndReserve({ date, start, end, timeLabel: start.substring(0,2)+':'+start.substring(2,4) });
}

async function startMonitoringFromUI(targetTime) {
  await startMonitoring(targetTime);
}

async function confirmAndReserve(slot) {
  $('#ticket-status').innerHTML = '<div class="loading"><div class="spinner"></div><p>預約中...</p></div>';
  showStep('status');

  const res = await fetch('/api/reservation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: state.sessionId,
      storeid: state.selectedStore.id,
      adult: state.adult, child: state.child, tabletype: 'T',
      date: slot.date, time: slot.start, end: slot.end,
    }),
  });
  const data = await res.json();
  const ticketNum = data.ticketNo || data.number || '---';
  const checkinCode = data.checkinCode || (data.ticketId ? String(data.ticketId).slice(-4) : '----');
  const timeStr = data.time ? data.time.replace(/(\d{2})(\d{2})\d{2}/, '$1:$2') : (slot.timeLabel || '');
  const dateStr = data.date ? data.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1/$2/$3') : '';

  if (data.success || data.ticketId) {
    $('#ticket-status').innerHTML = `
      <div class="status-icon">🎉</div>
      <div class="status-text">${esc(data.storeName || state.selectedStore.name)}</div>
      <div class="ticket-info" style="margin:8px 0 2px">號碼牌</div>
      <div class="ticket-number">#${esc(ticketNum)}</div>
      <div class="ticket-info" style="font-size:13px;margin:8px 0 4px">報到代碼</div>
      <div style="font-size:36px;font-weight:800;color:#2a9d8f;letter-spacing:4px">${esc(checkinCode)}</div>
      <div class="ticket-info" style="margin-top:8px">${state.adult} 大 ${state.child} 小 | 桌位</div>
      ${dateStr && timeStr ? `<div class="ticket-wait">${esc(dateStr)} ${esc(timeStr)}</div>` : ''}
      ${data.waitTime != null ? `<div class="ticket-info">預估等候 ${data.waitTime} 分鐘</div>` : ''}
      <div class="ticket-info" style="margin-top:12px;color:var(--danger);font-size:12px">來店後請於帶位台輸入報到代碼</div>`;
    $('#btn-cancel-ticket').style.display = 'inline-block';
    $('#btn-cancel-ticket').textContent = '取消預約';
    $('#btn-cancel-ticket').onclick = async () => {
      if (!confirm('取消預約？')) return;
      await fetch('/api/ticket/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.sessionId, ticketId: data.ticketId, storeid: state.selectedStore.id }),
      });
      $('#ticket-status').innerHTML = '<div class="status-icon">✅</div><div class="status-text">已取消</div>';
      $('#btn-cancel-ticket').style.display = 'none';
    };
    addHistory({
      storeName: data.storeName || state.selectedStore.name,
      ticketNo: ticketNum, checkinCode, mode: 'reservation',
      status: 'active', adult: state.adult, child: state.child,
      date: dateStr, time: timeStr, createdAt: new Date().toISOString(),
    });
  } else {
    const err = data.error || data.message || '預約失敗';
    $('#ticket-status').innerHTML = `<div class="status-icon">❌</div><div class="status-text">預約失敗</div><div class="status-subtext">${esc(err)}</div>`;
    $('#btn-cancel-ticket').style.display = 'none';
  }
  $('#schedule-logs').style.display = 'none';
}

async function startMonitoring(targetTime) {
  const ntfyTopic = getSetting('ntfyTopic', '');
  if (!ntfyTopic) {
    alert('請先在設定頁面填寫 ntfy Topic');
    return;
  }

  const res = await fetch('/api/monitor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storeid: state.selectedStore.id,
      storeName: state.selectedStore.name,
      adult: state.adult, child: state.child,
      targetTime, ntfyTopic,
      pollInterval: getSetting('schedulePoll', 60),
      earlyWindow: Math.max(0, Math.min(30, Number(getSetting('earlyWindow', 10)) || 10)),
      lateWindow: Math.max(0, Math.min(30, Number(getSetting('lateWindow', 5)) || 5)),
      sessionId: state.sessionId,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || '建立監控失敗');
    return;
  }

  $('#ticket-status').innerHTML = `
    <div class="status-icon">📡</div>
    <div class="status-text">監控已啟動</div>
    <div class="status-subtext">${esc(state.selectedStore.name)} | 目標: ${esc(targetTime)}</div>
    <div class="status-subtext">無可用預約時段，系統將監控等候時間</div>
    <div class="status-subtext">當最佳抽號時機到來時，會透過 ntfy 通知您</div>
    <div class="status-subtext pulse" style="margin-top:8px">監控 ID: ${esc(data.monitorId)}</div>`;
  $('#btn-cancel-ticket').style.display = 'inline-block';
  $('#btn-cancel-ticket').textContent = '取消監控';
  $('#btn-cancel-ticket').onclick = async () => {
    await fetch(`/api/monitor/${data.monitorId}?sessionId=${state.sessionId}`, { method: 'DELETE' });
    $('#ticket-status').innerHTML = '<div class="status-icon">✅</div><div class="status-text">已取消監控</div>';
    $('#btn-cancel-ticket').style.display = 'none';
    updateMonitorBadge();
  };
  $('#schedule-logs').style.display = 'none';
  showStep('status');
  updateMonitorBadge();
}

// ==================== History ====================
function renderHistory() {
  const history = loadHistory();
  if (state.sessionId) {
    renderAccountReservations(history);
    return;
  }
  if (!history.length) { $('#history-list').innerHTML = '<div class="empty-state">尚無紀錄</div>'; $('#btn-clear-history').style.display = 'none'; return; }
  $('#btn-clear-history').style.display = 'block';
  $('#history-list').innerHTML = renderLocalHistoryCards(history);
}

function renderLocalHistoryCards(history) {
  const statusMap = { active: ['進行中','pending'], success: ['已完成','success'], failed: ['失敗','failed'], cancelled: ['已取消','cancelled'] };
  let html = '';
  for (const e of history) {
    const [st, sc] = statusMap[e.status] || [e.status,'pending'];
    html += `<div class="history-card"><div class="h-top"><span class="h-store">${esc(e.storeName)}</span><span class="h-status ${sc}">${st}</span></div>
      ${e.ticketNo ? `<div class="h-ticket">#${esc(e.ticketNo)}</div>` : ''}
      ${e.checkinCode ? `<div class="h-detail" style="color:var(--success);font-weight:600">報到代碼: ${esc(e.checkinCode)}</div>` : ''}
      <div class="h-detail">${e.adult} 大 ${e.child} 小 ${e.date && e.time ? '| '+esc(e.date)+' '+esc(e.time) : ''}</div>
      <div class="h-time">${new Date(e.createdAt).toLocaleString('zh-TW')}</div></div>`;
  }
  return html;
}

async function renderAccountReservations(history = loadHistory()) {
  $('#btn-clear-history').style.display = history.length ? 'block' : 'none';
  $('#history-list').innerHTML = '<div class="loading"><div class="spinner"></div><p>載入中...</p></div>';
  try {
    const res = await fetch('/api/reservations?sessionId=' + encodeURIComponent(state.sessionId || ''));
    if (!res.ok) throw new Error('load failed');
    const reservations = await res.json();
    let html = '';
    if (reservations.length) {
      html += '<div class="history-section-title">帳號目前預約</div>';
      html += reservations.map(reservationCard).join('');
    }
    if (history.length) {
      html += '<div class="history-section-title">本裝置紀錄</div>';
      html += renderLocalHistoryCards(history);
    }
    $('#history-list').innerHTML = html || '<div class="empty-state">尚無紀錄</div>';
  } catch {
    $('#history-list').innerHTML = history.length ? renderLocalHistoryCards(history) : '<div class="empty-state">載入失敗</div>';
  }
}

function reservationCard(r) {
  const time = r.time ? String(r.time).replace(/(\d{2})(\d{2})\d{2}/, '$1:$2') : '';
  const date = r.date ? String(r.date).replace(/(\d{4})(\d{2})(\d{2})/, '$1/$2/$3') : '';
  return `<div class="history-card account-reservation">
    <div class="h-top"><span class="h-store">${esc(r.storeName || '壽司郎')}</span><span class="h-status pending">進行中</span></div>
    ${r.ticketNo ? `<div class="h-ticket">#${esc(r.ticketNo)}</div>` : ''}
    ${r.checkinCode ? `<div class="h-detail" style="color:var(--success);font-weight:600">報到代碼: ${esc(r.checkinCode)}</div>` : ''}
    <div class="h-detail">${date && time ? esc(date) + ' ' + esc(time) : ''}</div>
    <div class="m-actions"><button class="btn btn-danger btn-sm" onclick="cancelReservation('${escJs(r.ticketId)}','${escJs(r.storeid || '')}')">取消預約</button></div>
  </div>`;
}

async function cancelReservation(ticketId, storeid) {
  if (!state.sessionId || !ticketId) return;
  if (!confirm('取消預約？')) return;
  await fetch('/api/ticket/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: state.sessionId, ticketId, storeid }),
  });
  renderHistory();
}

// ==================== Monitor Page ====================
async function renderMonitor() {
  try {
    const res = await fetch('/api/monitors?sessionId=' + (state.sessionId || ''));
    const monitors = await res.json();
    if (!monitors.length) { $('#monitor-list').innerHTML = '<div class="empty-state">目前沒有進行中的監控</div>'; return; }
    let html = '';
    for (const m of monitors) {
      const icons = { waiting:'⏳', monitoring:'📡', notified:'🔔', failed:'❌', cancelled:'🚫' };
      const texts = { waiting:'等待開門', monitoring:'監控中', notified:'已通知', failed:'失敗', cancelled:'已取消' };
      html += `<div class="monitor-card">
        <div class="m-header"><span class="m-store">${esc(m.storeName)}</span><span>${icons[m.status]||''} ${texts[m.status]||m.status}</span></div>
        <div class="m-grid">
          <div class="m-stat"><div class="m-stat-value">${esc(m.targetTime)}</div><div class="m-stat-label">目標時間</div></div>
          <div class="m-stat"><div class="m-stat-value">${m.lastWait != null ? m.lastWait+'分' : '--'}</div><div class="m-stat-label">目前等候</div></div>
        </div>
        ${m.logs && m.logs.length ? `<div class="logs" style="margin-top:10px;max-height:100px">${m.logs.slice(-3).map(l=>`<div class="log-entry">${esc(l)}</div>`).join('')}</div>` : ''}
        <div class="m-updated">${new Date().toLocaleTimeString('zh-TW')} 更新</div>
        <div class="m-actions"><button class="btn btn-danger btn-sm" onclick="cancelMonitor('${escJs(m.monitorId)}')">${m.status === 'monitoring' || m.status === 'waiting' ? '取消監控' : '刪除'}</button></div>
      </div>`;
    }
    $('#monitor-list').innerHTML = html;
  } catch { $('#monitor-list').innerHTML = '<div class="empty-state">載入失敗</div>'; }
}

async function cancelMonitor(id) {
  await fetch(`/api/monitor/${id}?sessionId=${state.sessionId || ''}`, { method: 'DELETE' });
  renderMonitor();
  updateMonitorBadge();
}

async function updateMonitorBadge() {
  try {
    const res = await fetch('/api/monitors?sessionId=' + (state.sessionId || ''));
    const monitors = await res.json();
    const active = monitors.filter(m => m.status === 'monitoring' || m.status === 'waiting').length;
    $('#monitor-badge').style.display = active > 0 ? 'block' : 'none';
    $('#monitor-badge').textContent = active;
  } catch {}
}

// ==================== Location ====================
function requestLocation() {
  if (!navigator.geolocation) return alert('瀏覽器不支援定位');
  if (state.locating) return;
  state.locating = true;
  // If already has location, clear it first then re-fetch
  if (state.userLat != null) {
    state.userLat = state.userLon = null;
    setSetting('userLat', null); setSetting('userLon', null);
    $('#btn-location').classList.remove('active');
  }
  $('#btn-location').classList.add('loading'); $('#location-icon').textContent = '⏳';
  navigator.geolocation.getCurrentPosition(
    p => { state.locating = false; state.userLat = p.coords.latitude; state.userLon = p.coords.longitude; setSetting('userLat', state.userLat); setSetting('userLon', state.userLon); $('#btn-location').classList.remove('loading'); $('#btn-location').classList.add('active'); $('#location-icon').textContent = '📍'; renderCurrentStores(); },
    e => { state.locating = false; $('#btn-location').classList.remove('loading'); $('#location-icon').textContent = '📍'; alert('無法取得位置: ' + e.message); },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ==================== Login ====================
function showLoginDialog() { $('#login-overlay').style.display = 'flex'; $('#login-error').style.display = 'none'; $('#login-email').value = getSavedAccountEmail(); $('#login-password').value = ''; }
function hideLoginDialog() { $('#login-overlay').style.display = 'none'; }

async function doLogin() {
  const email = $('#login-email').value.trim(), password = $('#login-password').value;
  if (!email || !password) return;
  $('#btn-do-login').disabled = true; $('#btn-do-login').textContent = '登入中...'; $('#login-error').style.display = 'none';
  try {
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const data = await res.json();
    if (data.success) {
      state.sessionId = data.sessionId;
      localStorage.setItem(SESSION_KEY, JSON.stringify({ sessionId: data.sessionId, email: data.email }));
      saveAccountEmail(data.email);
      await syncAccountSettings(data.settings, data.settingsExists);
      updateLoginUI(data.email); hideLoginDialog();
      updateMonitorBadge();
      if (state.activeTab === 'history') renderHistory();
      if (state.activeTab === 'monitor') renderMonitor();
    } else {
      
      $('#login-error').textContent = !res.ok ? '帳號或密碼錯誤' : (data.error || '登入失敗');
      $('#login-error').style.display = 'block';
    }
  } catch (err) { $('#login-error').textContent = '連線錯誤'; $('#login-error').style.display = 'block'; }
  finally { $('#btn-do-login').disabled = false; $('#btn-do-login').textContent = '登入'; }
}

function logout() {
  if (state.sessionId) fetch('/api/auth/session/' + state.sessionId, { method: 'DELETE' }).catch(() => {});
  state.sessionId = null; localStorage.removeItem(SESSION_KEY); updateLoginUI(null);
  updateMonitorBadge();
  if (state.activeTab === 'history') renderHistory();
  if (state.activeTab === 'monitor') renderMonitor();
}

function updateLoginUI(email) {
  if (email) { $('#login-status-text').textContent = '已登入: ' + email; $('#btn-login').textContent = '登出'; $('#btn-login').onclick = logout; }
  else {
    const savedEmail = getSavedAccountEmail();
    $('#login-status-text').textContent = savedEmail ? '未登入 - 已記住帳號: ' + savedEmail : '未登入 - 登入後可使用預約功能';
    $('#btn-login').textContent = '登入';
    $('#btn-login').onclick = showLoginDialog;
  }
}

async function restoreSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (saved?.sessionId) {
      const res = await fetch('/api/auth/session/' + saved.sessionId);
      const data = await res.json();
      if (data.valid) {
        state.sessionId = saved.sessionId;
        updateLoginUI(saved.email || data.email);
        const email = saved.email || data.email || '';
        if (email) {
          saveAccountEmail(email);
          await syncAccountSettings(data.settings, data.settingsExists);
          updateMonitorBadge();
          if (state.activeTab === 'history') renderHistory();
          if (state.activeTab === 'monitor') renderMonitor();
        }
      }
      else {
        if (saved.email) saveAccountEmail(saved.email);
        localStorage.removeItem(SESSION_KEY);
        updateLoginUI(null);
      }
    } else {
      updateLoginUI(null);
    }
  } catch {}
}

// ==================== Globals ====================
window.selectStore = selectStore;
window.showLoginDialog = showLoginDialog;
window.hideLoginDialog = hideLoginDialog;
window.doLogin = doLogin;
window.logout = logout;
window.requestLocation = requestLocation;
window.cancelMonitor = cancelMonitor;
window.cancelReservation = cancelReservation;
window.pickSlot = pickSlot;
window.startMonitoringFromUI = startMonitoringFromUI;
window.togglePinStore = togglePinStore;
window.startPinnedStoreDrag = startPinnedStoreDrag;
window.overPinnedStoreDrag = overPinnedStoreDrag;
window.dropPinnedStoreDrag = dropPinnedStoreDrag;
window.endPinnedStoreDrag = endPinnedStoreDrag;
window.startPinnedStorePointerDrag = startPinnedStorePointerDrag;

// Restore saved location (validate coordinates)
const savedLat = Number(getSetting('userLat', null));
const savedLon = Number(getSetting('userLon', null));
if (Number.isFinite(savedLat) && Number.isFinite(savedLon) && savedLat >= -90 && savedLat <= 90 && savedLon >= -180 && savedLon <= 180) {
  state.userLat = savedLat;
  state.userLon = savedLon;
  document.addEventListener('DOMContentLoaded', () => { $('#btn-location')?.classList.add('active'); });
} else {
  setSetting('userLat', null);
  setSetting('userLon', null);
}

async function boot() {
  await init();
  await restoreSession();
  updateMonitorBadge();
}

boot();
