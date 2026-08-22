const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3737;

const API_BASE = 'https://crm-tw.akindo-sushiro.co.jp/api/2.0';
const REGION = 'TW';
const SUSHIRO_SHORTCUT_URL = 'shortcuts://run-shortcut?name=Open%20Sushiro';
const UA = 'Dart/3.6 (dart:io)';
const FETCH_TIMEOUT_MS = 12000;
const NTFY_TIMEOUT_MS = 10000;
const MAX_MONITORS_PER_SESSION = 3;
const MAX_MONITOR_LOGS = 100;
const MONITOR_STORE_CACHE_MS = 30000;
const DB_PATH = process.env.SUSHIROAD_DB || path.join(__dirname, 'data', 'sushiroad.db.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
  },
}));

// --- Simple per-IP rate limiter ---
const loginAttempts = new Map();
function checkLoginRate(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
  entry.count++;
  loginAttempts.set(ip, entry);
  return entry.count <= 5; // 5 attempts per minute
}

// --- In-memory state ---
const sessions = new Map();
const monitors = new Map();
const monitorStoreCache = {
  stores: null,
  fetchedAt: 0,
  inFlight: null,
};

// --- Lightweight file DB ---
function createEmptyDb() {
  return { version: 1, monitors: {}, reservations: {}, settings: {} };
}

function loadDb() {
  try {
    if (!fs.existsSync(DB_PATH)) return createEmptyDb();
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return {
      version: 1,
      monitors: parsed.monitors && typeof parsed.monitors === 'object' ? parsed.monitors : {},
      reservations: parsed.reservations && typeof parsed.reservations === 'object' ? parsed.reservations : {},
      settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
    };
  } catch (err) {
    console.error(`Failed to load DB: ${err.message}`);
    return createEmptyDb();
  }
}

let db = loadDb();

function saveDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmpPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2));
  fs.renameSync(tmpPath, DB_PATH);
}

function accountKey(email) {
  return String(email || '').trim().toLowerCase();
}

function persistMonitor(m) {
  const { intervalId, isRunning, ...record } = m;
  db.monitors[m.monitorId] = record;
  saveDb();
}

function deletePersistedMonitor(id) {
  if (db.monitors[id]) {
    delete db.monitors[id];
    saveDb();
  }
}

function persistReservation(account, ticket) {
  if (!account || !ticket?.ticketId) return;
  const id = String(ticket.ticketId);
  db.reservations[id] = {
    ...ticket,
    accountKey: account,
    updatedAt: new Date().toISOString(),
  };
  saveDb();
}

function markReservationCancelled(account, ticketId) {
  if (!ticketId) return;
  const id = String(ticketId);
  const existing = db.reservations[id];
  if (!existing || existing.accountKey !== account) return;
  existing.status = 'cancelled';
  existing.updatedAt = new Date().toISOString();
  saveDb();
}

function validTimeValue(v) {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

function defaultAccountSettings(email) {
  return {
    ntfyTopic: makeNtfyTopic(email),
    ntfyTopicAuto: true,
    storePoll: 60,
    schedulePoll: 60,
    earlyWindow: 10,
    lateWindow: 5,
    reservationAdult: 2,
    reservationChild: 0,
    pinnedStoreIds: [],
    userLat: null,
    userLon: null,
  };
}

function sanitizeSettings(input = {}, defaults = defaultAccountSettings('')) {
  const out = {};
  if (validNtfyTopic(input.ntfyTopic)) out.ntfyTopic = input.ntfyTopic;
  if (typeof input.ntfyTopicAuto === 'boolean') out.ntfyTopicAuto = input.ntfyTopicAuto;

  const storePoll = validInt(input.storePoll);
  if (storePoll !== null && [0, 60, 120, 300].includes(storePoll)) out.storePoll = storePoll;

  const schedulePoll = validInt(input.schedulePoll);
  if (schedulePoll !== null) out.schedulePoll = Math.max(30, Math.min(300, schedulePoll));

  const earlyWindow = validInt(input.earlyWindow);
  if (earlyWindow !== null) out.earlyWindow = Math.max(0, Math.min(30, earlyWindow));

  const lateWindow = validInt(input.lateWindow);
  if (lateWindow !== null) out.lateWindow = Math.max(0, Math.min(30, lateWindow));

  const adult = validInt(input.reservationAdult);
  if (adult !== null) out.reservationAdult = Math.max(1, Math.min(18, adult));

  const child = validInt(input.reservationChild);
  if (child !== null) out.reservationChild = Math.max(0, Math.min(17, child));

  if (Array.isArray(input.pinnedStoreIds)) {
    out.pinnedStoreIds = [...new Set(input.pinnedStoreIds.map(String).filter(id => validInt(id) !== null))].slice(0, 100);
  }

  if (input.userLat === null) out.userLat = null;
  else {
    const lat = Number(input.userLat);
    if (Number.isFinite(lat) && lat >= -90 && lat <= 90) out.userLat = lat;
  }

  if (input.userLon === null) out.userLon = null;
  else {
    const lon = Number(input.userLon);
    if (Number.isFinite(lon) && lon >= -180 && lon <= 180) out.userLon = lon;
  }

  return { ...defaults, ...out };
}

function getAccountSettings(account, email) {
  const defaults = defaultAccountSettings(email);
  const existing = db.settings[account];
  return {
    settings: sanitizeSettings(existing || {}, defaults),
    exists: Boolean(existing),
  };
}

function saveAccountSettings(account, email, incoming) {
  const current = getAccountSettings(account, email).settings;
  const settings = sanitizeSettings({ ...current, ...(incoming || {}) }, defaultAccountSettings(email));
  db.settings[account] = {
    ...settings,
    updatedAt: new Date().toISOString(),
  };
  saveDb();
  return settings;
}

// --- Validation helpers ---
function validInt(v) { if (!/^\d+$/.test(String(v))) return null; const n = Number(v); return Number.isInteger(n) ? n : null; }
function validNtfyTopic(t) { return typeof t === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(t); }
function formatNtfyTopic(raw, maxLen = 64) {
  let topic = String(raw || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  if (topic.length > maxLen) topic = topic.slice(0, maxLen).replace(/^[-_]+|[-_]+$/g, '');
  return topic;
}
function makeNtfyTopic(email) {
  const suffix = '-sushiroad';
  const rawPrefix = String(email || '').split('@')[0] || 'user';
  const prefix = formatNtfyTopic(rawPrefix, 8) || `user-${uuidv4().slice(0, 6)}`;
  return `${prefix}${suffix}`;
}

async function sendNtfyNotification(topic, notification) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NTFY_TIMEOUT_MS);
  try {
    const response = await fetch('https://ntfy.sh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, ...notification, click: SUSHIRO_SHORTCUT_URL }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`ntfy HTTP ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

// --- Helper: fetch from Sushiro API with timeout ---
async function sushiroFetch(urlPath, options = {}) {
  const url = urlPath.startsWith('http') ? urlPath : `${API_BASE}${urlPath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept-Encoding': 'gzip',
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    try {
      return { status: res.status, data: JSON.parse(text) };
    } catch {
      return { status: res.status, data: text };
    }
  } finally {
    clearTimeout(timeout);
  }
}

// --- Auth ---
function makeBasicAuth(email, password) {
  return Buffer.from(`${email}@${REGION}:${password}`).toString('base64');
}

function getAuthHeaders(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) return null;
  return { headers: { 'Authorization': `Basic ${session.basicAuth}` }, session };
}

function getSessionAuth(sessionId) {
  const auth = getAuthHeaders(sessionId);
  if (!auth) return null;
  return { ...auth, accountKey: accountKey(auth.session.email) };
}

// --- Auth Routes ---

app.post('/api/auth/login', async (req, res) => {
  try {
    const ip = req.ip;
    if (!checkLoginRate(ip)) return res.status(429).json({ error: '登入嘗試過於頻繁，請稍後再試' });

    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const result = await sushiroFetch('/remote/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}&region=${REGION}`,
    });

    if (result.status === 200 && result.data?.status === 'SUCCESS') {
      const sessionId = uuidv4();
      const key = accountKey(email);
      const accountSettings = getAccountSettings(key, email);
      sessions.set(sessionId, {
        basicAuth: makeBasicAuth(email, password),
        email,
        customerId: result.data.customerid,
        expiresAt: Date.now() + 24 * 3600 * 1000,
      });
      res.json({
        sessionId,
        email,
        ntfyTopic: accountSettings.settings.ntfyTopic,
        settings: accountSettings.settings,
        settingsExists: accountSettings.exists,
        success: true,
      });
    } else {
      res.status(401).json({ success: false, error: '帳號或密碼錯誤' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/session/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session || session.expiresAt < Date.now()) return res.status(401).json({ valid: false });
  const accountSettings = getAccountSettings(accountKey(session.email), session.email);
  res.json({
    valid: true,
    email: session.email,
    ntfyTopic: accountSettings.settings.ntfyTopic,
    settings: accountSettings.settings,
    settingsExists: accountSettings.exists,
  });
});

app.delete('/api/auth/session/:sessionId', (req, res) => {
  const sid = req.params.sessionId;
  sessions.delete(sid);
  res.json({ success: true });
});

// --- Account settings ---

app.get('/api/settings', (req, res) => {
  const auth = getSessionAuth(req.query.sessionId);
  if (!auth) return res.status(401).json({ error: 'Session expired' });
  const accountSettings = getAccountSettings(auth.accountKey, auth.session.email);
  res.json(accountSettings);
});

app.patch('/api/settings', (req, res) => {
  const auth = getSessionAuth(req.body?.sessionId);
  if (!auth) return res.status(401).json({ error: 'Session expired' });
  const settings = saveAccountSettings(auth.accountKey, auth.session.email, req.body?.settings || {});
  res.json({ success: true, settings });
});

// --- Store Routes ---

app.get('/api/stores', async (_req, res) => {
  try {
    const qs = new URLSearchParams({ guid: uuidv4(), region: REGION });
    const result = await sushiroFetch(`/info/storelist?${qs}`);
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stores/:id', async (req, res) => {
  try {
    const id = validInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'invalid storeid' });
    const qs = new URLSearchParams({ storeid: String(id), region: REGION });
    const result = await sushiroFetch(`/info/store?${qs}`);
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stores/:id/queue', async (req, res) => {
  try {
    const id = validInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'invalid storeid' });
    const qs = new URLSearchParams({ storeid: String(id), region: REGION });
    const result = await sushiroFetch(`/remote/storequeue?${qs}`);
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stores/:id/groupqueues', async (req, res) => {
  try {
    const id = validInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'invalid storeid' });
    const qs = new URLSearchParams({ storeid: String(id), region: REGION });
    const result = await sushiroFetch(`/remote/groupqueues?${qs}`);
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stores/:id/seatconfig', async (req, res) => {
  try {
    const id = validInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'invalid storeid' });
    const now = new Date();
    const date = req.query.date || now.toISOString().slice(0, 10).replace(/-/g, '');
    const qs = new URLSearchParams({ storeid: String(id), date, region: REGION });
    const result = await sushiroFetch(`/info/seatconfig?${qs}`);
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stores/:id/timeslots', async (req, res) => {
  try {
    const id = validInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'invalid storeid' });
    const numpersons = validInt(req.query.numpersons) || 2;
    const tabletype = req.query.tabletype === 'C' ? 'C' : 'T';
    const qs = new URLSearchParams({ storeid: String(id), numpersons: String(numpersons), guid: uuidv4(), tabletype, region: REGION });
    const result = await sushiroFetch(`/info/reservationtimeslots?${qs}`);
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Reservation ---

app.post('/api/reservation', async (req, res) => {
  try {
    const { sessionId, storeid, adult = 2, child = 0, tabletype = 'T', date, time, end } = req.body;
    if (!sessionId) return res.status(401).json({ error: 'login required' });
    const sid = validInt(storeid);
    if (sid === null || !date || !time) return res.status(400).json({ error: 'storeid, date, time required' });

    const auth = getSessionAuth(sessionId);
    if (!auth) return res.status(401).json({ error: 'Session expired' });

    const guid = uuidv4();
    const body = { storeid: sid, adult, child, tabletype, guid, region: REGION, date, time };
    if (end) body.end = end;

    const result = await sushiroFetch('/remote_auth/newreservation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth.headers },
      body: JSON.stringify(body),
    });

    // Sushiro server bug: E010 even on success. Verify via opentickets.
    if (result.data?.code === 'E010') {
      const check = await sushiroFetch(`/remote_auth/opentickets?region=${REGION}`, { headers: auth.headers });
      const created = (check.data?.RESERVATIONS || []).find(r =>
        r.TICKET_DETAIL?.storeId === String(sid) && r.TICKET_DETAIL?.start === time
      );
      if (created) {
        const reservation = {
          success: true,
          ticketId: created.TICKET_DETAIL.ticketId,
          ticketNo: created.TICKET_DETAIL.number,
          checkinCode: String(created.TICKET_DETAIL.ticketId).slice(-4),
          waitTime: created.TICKET_DETAIL.wait,
          storeName: created.STORE_INFO?.name,
          storeid: sid,
          date: created.TICKET_DETAIL.queueDate,
          time: created.TICKET_DETAIL.start,
          guid,
        };
        persistReservation(auth.accountKey, reservation);
        return res.json(reservation);
      }
    }

    if (result.data?.code === 'E052') {
      return res.json({ error: '已有預約，請先取消', code: 'E052' });
    }

    const response = { ...result.data, guid };
    if (response.ticketId || response.TICKET_DETAIL?.ticketId) {
      const detail = response.TICKET_DETAIL || response;
      persistReservation(auth.accountKey, {
        success: true,
        ticketId: detail.ticketId,
        ticketNo: detail.number || detail.ticketNo,
        checkinCode: String(detail.ticketId).slice(-4),
        waitTime: detail.wait,
        storeName: response.STORE_INFO?.name,
        storeid: sid,
        date: detail.queueDate || date,
        time: detail.start || time,
        guid,
      });
    }
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Ticket status / cancel ---

app.get('/api/ticket/status', async (req, res) => {
  try {
    const { guid, sessionId } = req.query;
    let result;
    if (sessionId) {
      const auth = getAuthHeaders(sessionId);
      if (auth) result = await sushiroFetch(`/remote_auth/opentickets?region=${REGION}`, { headers: auth.headers });
    }
    if (!result || result.status !== 200) {
      if (!guid) return res.status(400).json({ error: 'guid required' });
      const qs = new URLSearchParams({ guid, region: REGION });
      result = await sushiroFetch(`/remote/opentickets?${qs}`);
    }
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function normalizeOpenReservation(item) {
  const detail = item?.TICKET_DETAIL || item || {};
  const store = item?.STORE_INFO || {};
  const ticketId = detail.ticketId || detail.ticketID || detail.id;
  return {
    ticketId,
    ticketNo: detail.number || detail.ticketNo || detail.ticketNumber || '',
    checkinCode: ticketId ? String(ticketId).slice(-4) : '',
    waitTime: detail.wait,
    storeName: store.name || detail.storeName || '',
    storeid: detail.storeId || detail.storeid || '',
    date: detail.queueDate || detail.date || '',
    time: detail.start || detail.time || '',
    status: 'active',
  };
}

app.get('/api/reservations', async (req, res) => {
  try {
    const auth = getSessionAuth(req.query.sessionId);
    if (!auth) return res.status(401).json({ error: 'Session expired' });

    const result = await sushiroFetch(`/remote_auth/opentickets?region=${REGION}`, { headers: auth.headers });
    const remoteReservations = Array.isArray(result.data?.RESERVATIONS)
      ? result.data.RESERVATIONS.map(normalizeOpenReservation).filter(r => r.ticketId)
      : [];

    for (const reservation of remoteReservations) persistReservation(auth.accountKey, reservation);

    const remoteIds = new Set(remoteReservations.map(r => String(r.ticketId)));
    for (const reservation of Object.values(db.reservations)) {
      if (reservation.accountKey !== auth.accountKey || reservation.status === 'cancelled') continue;
      if (reservation.ticketId && !remoteIds.has(String(reservation.ticketId))) {
        reservation.status = 'closed';
        reservation.updatedAt = new Date().toISOString();
      }
    }
    saveDb();

    res.json(remoteReservations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ticket/cancel', async (req, res) => {
  try {
    const { guid, ticketNo, ticketId, storeid, sessionId } = req.body;
    if (sessionId) {
      const auth = getSessionAuth(sessionId);
      if (auth) {
        const body = { region: REGION };
        if (ticketId) body.ticketId = ticketId;
        if (guid) body.guid = guid;
        if (ticketNo) body.ticketNo = ticketNo;
        if (storeid) body.storeid = storeid;
        const result = await sushiroFetch('/remote_auth/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...auth.headers },
          body: JSON.stringify(body),
        });
        markReservationCancelled(auth.accountKey, ticketId);
        return res.json(result.data);
      }
    }
    const body = { region: REGION };
    if (ticketId) body.ticketId = ticketId;
    if (guid) body.guid = guid;
    if (ticketNo) body.ticketNo = ticketNo;
    if (storeid) body.storeid = storeid;
    const result = await sushiroFetch('/remote/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Monitor (wait-time ntfy notification) ---

app.post('/api/monitor', async (req, res) => {
  try {
    const { storeid, storeName, adult = 2, child = 0, targetTime, ntfyTopic, pollInterval = 60, earlyWindow = 10, lateWindow = 5, sessionId } = req.body;
    if (!sessionId) return res.status(401).json({ error: 'login required' });
    const auth = getSessionAuth(sessionId);
    if (!auth) return res.status(401).json({ error: 'session expired' });

    const sid = validInt(storeid);
    if (sid === null || !targetTime) return res.status(400).json({ error: 'storeid and targetTime required' });
    if (!validNtfyTopic(ntfyTopic)) return res.status(400).json({ error: 'invalid ntfyTopic (letters, numbers, underscore, hyphen; 1-64 chars)' });

    // Cap monitors per account, so multiple devices share one quota.
    let accountMonitors = 0;
    for (const [, m] of monitors) {
      const owner = m.accountKey || accountKey(m.accountEmail);
      if (owner === auth.accountKey && (m.status === 'waiting' || m.status === 'monitoring')) accountMonitors++;
    }
    if (accountMonitors >= MAX_MONITORS_PER_SESSION) {
      return res.status(429).json({ error: `最多同時 ${MAX_MONITORS_PER_SESSION} 個監控` });
    }

    const monitorId = uuidv4().slice(0, 8);
    const pi = validInt(pollInterval);
    const pollSec = pi == null ? 60 : Math.max(30, Math.min(300, pi));
    const intervalMs = pollSec * 1000;

    // Compute absolute target timestamp in Taipei timezone
    const taipeiNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const [th, tm] = targetTime.split(':').map(Number);
    const targetAt = new Date(taipeiNow);
    targetAt.setHours(th, tm, 0, 0);
    if (targetAt < taipeiNow) targetAt.setDate(targetAt.getDate() + 1);

    const early = Math.max(0, Math.min(30, validInt(earlyWindow) ?? 10));
    const late = Math.max(0, Math.min(30, validInt(lateWindow) ?? 5));

    const monitor = {
      monitorId, storeid: sid, storeName: storeName || '', adult, child, targetTime, ntfyTopic,
      sessionId,
      accountKey: auth.accountKey,
      accountEmail: auth.session.email,
      earlyWindow: early,
      lateWindow: late,
      pollInterval: pollSec,
      targetAt: targetAt.getTime(),
      status: 'waiting',
      lastWait: null,
      isRunning: false,
      createdAt: new Date().toISOString(),
      logs: [],
    };

    monitor.intervalId = setInterval(() => checkAndNotify(monitorId), intervalMs);
    monitors.set(monitorId, monitor);
    persistMonitor(monitor);

    let startNotificationSent = false;
    try {
      await sendNtfyNotification(monitor.ntfyTopic, {
        title: `壽司郎 ${monitor.storeName || `店號 ${monitor.storeid}`} - 監控已啟動`,
        message: `📡 監控已成功啟動\n⏱️ 目標時間 ${monitor.targetTime}\n🆔 監控 ID ${monitor.monitorId}\n🔔 Topic: ${monitor.ntfyTopic}`,
        priority: 3,
        tags: ['sushi', 'satellite'],
      });
      startNotificationSent = true;
      monitor.logs.push(`[${new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })}] 已發送監控啟動通知至 ${monitor.ntfyTopic}`);
    } catch (err) {
      monitor.logs.push(`[${new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })}] 監控已啟動，但啟動通知發送失敗: ${err.message}`);
    }
    persistMonitor(monitor);
    checkAndNotify(monitorId);

    res.json({ monitorId, status: 'waiting', ntfyTopic: monitor.ntfyTopic, startNotificationSent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function safeMonitor(m) {
  const { intervalId, isRunning, sessionId, accountKey, accountEmail, ...safe } = m;
  return safe;
}

app.get('/api/monitor/:id', (req, res) => {
  const m = monitors.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const auth = getSessionAuth(req.query.sessionId);
  if (!auth) return res.status(401).json({ error: 'Session expired' });
  const owner = m.accountKey || accountKey(m.accountEmail);
  if (owner && owner !== auth.accountKey) return res.status(403).json({ error: 'Forbidden' });
  res.json(safeMonitor(m));
});

app.delete('/api/monitor/:id', (req, res) => {
  const m = monitors.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const { sessionId } = req.body || req.query;
  const auth = getSessionAuth(sessionId);
  if (!auth) return res.status(401).json({ error: 'Session expired' });
  const owner = m.accountKey || accountKey(m.accountEmail);
  if (owner && owner !== auth.accountKey) return res.status(403).json({ error: 'Forbidden' });
  clearInterval(m.intervalId);
  m.status = 'cancelled';
  monitors.delete(req.params.id);
  deletePersistedMonitor(req.params.id);
  res.json(safeMonitor(m));
});

app.get('/api/monitors', (req, res) => {
  const auth = getSessionAuth(req.query.sessionId);
  if (!auth) return res.json([]);
  const list = [];
  for (const [, m] of monitors) {
    const owner = m.accountKey || accountKey(m.accountEmail);
    if (owner !== auth.accountKey) continue;
    list.push(safeMonitor(m));
  }
  res.json(list);
});

async function getMonitorStores() {
  const now = Date.now();
  if (Array.isArray(monitorStoreCache.stores) && now - monitorStoreCache.fetchedAt < MONITOR_STORE_CACHE_MS) {
    return monitorStoreCache.stores;
  }

  if (monitorStoreCache.inFlight) return monitorStoreCache.inFlight;

  monitorStoreCache.inFlight = (async () => {
    try {
      const qs = new URLSearchParams({ guid: uuidv4(), region: REGION });
      const storeResult = await sushiroFetch(`/info/storelist?${qs}`);
      if (!Array.isArray(storeResult.data)) throw new Error('invalid storelist response');
      monitorStoreCache.stores = storeResult.data;
      monitorStoreCache.fetchedAt = Date.now();
      return monitorStoreCache.stores;
    } finally {
      monitorStoreCache.inFlight = null;
    }
  })();

  return monitorStoreCache.inFlight;
}

async function checkAndNotify(monitorId) {
  const m = monitors.get(monitorId);
  if (!m || m.status === 'notified' || m.status === 'failed' || m.status === 'cancelled') {
    if (m?.intervalId) clearInterval(m.intervalId);
    return;
  }
  if (m.isRunning) return;
  m.isRunning = true;

  const now = new Date();
  const taipeiNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const minutesUntilTarget = (m.targetAt - Date.now()) / 60000;
  const ts = taipeiNow.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });

  try {
    // Re-check after await: monitor might have been cancelled
    if (!monitors.has(monitorId) || m.status === 'cancelled') return;

    const stores = await getMonitorStores();
    const store = stores.find(s => s.id === m.storeid);

    if (!store) { m.logs.push(`[${ts}] 找不到店面`); if (m.logs.length > MAX_MONITOR_LOGS) m.logs.shift(); return; }

    const waitMinutes = store.wait || 0;
    m.lastWait = waitMinutes;

    if (store.storeStatus === 'CLOSED') {
      m.status = 'waiting';
      m.logs.push(`[${ts}] ${store.name} 未營業 | 目標還有 ${Math.round(minutesUntilTarget)}分`);
      if (minutesUntilTarget < -30) {
        m.status = 'failed';
        m.logs.push(`[${ts}] 目標時間已過`);
        clearInterval(m.intervalId);
      }
      if (m.logs.length > MAX_MONITOR_LOGS) m.logs.shift();
      return;
    }

    m.status = 'monitoring';
    m.logs.push(`[${ts}] ${store.name} | 等候 ${waitMinutes}分 | 目標還有 ${Math.round(minutesUntilTarget)}分`);
    if (m.logs.length > MAX_MONITOR_LOGS) m.logs.shift();

    let shouldNotify = false;
    let notifyTitle = '';
    let notifyMessage = '';

    const earlyMin = m.earlyWindow ?? 10;
    const lateMin = m.lateWindow ?? 5;

    if (waitMinutes === 0 && minutesUntilTarget <= earlyMin && minutesUntilTarget >= -lateMin) {
      // No queue — just go eat
      shouldNotify = true;
      const arriveIn = Math.max(0, Math.round(minutesUntilTarget));
      notifyTitle = `壽司郎 ${store.name} - 現在沒人排隊！`;
      notifyMessage = `🍣 ${store.name}\n🎉 目前無需等候，直接去吃！\n👥 ${m.adult}大${m.child}小\n⏱️ 目標時間 ${m.targetTime}，約 ${arriveIn} 分鐘後`;
      m.logs.push(`[${ts}] 無人排隊，直接去吃！(目標 ${arriveIn}分後)`);
    } else if (waitMinutes > 0) {
      // Has queue — check if now + wait ≈ target
      const lowerBound = waitMinutes - earlyMin;
      const upperBound = waitMinutes + lateMin;
      if (minutesUntilTarget <= upperBound && minutesUntilTarget >= Math.max(lowerBound, -lateMin)) {
        shouldNotify = true;
        const arriveIn = Math.round(waitMinutes);
        notifyTitle = `壽司郎 ${store.name} - 現在去抽號！`;
        notifyMessage = `🍣 ${store.name}\n⏰ 目前等候 ${waitMinutes} 分鐘\n👥 ${m.adult}大${m.child}小\n⏱️ 抽號後約 ${arriveIn} 分鐘入座（目標 ${m.targetTime}）\n\n請立即打開壽司郎 APP 按「立即前往」抽號！`;
        m.logs.push(`[${ts}] 最佳時機！抽號等 ${waitMinutes}分 → 約 ${arriveIn}分後入座`);
      }
    }

    if (shouldNotify) {
      if (!monitors.has(monitorId) || m.status === 'cancelled') return;

      try {
        await sendNtfyNotification(m.ntfyTopic, {
          title: notifyTitle,
          message: notifyMessage,
          priority: 5,
          tags: ['sushi', 'bell'],
        });
        m.status = 'notified';
        m.logs.push(`[${ts}] 已發送 ntfy 通知`);
      } catch (err) {
        m.logs.push(`[${ts}] ntfy 通知失敗: ${err.message}`);
        m.status = 'failed';
      }
      clearInterval(m.intervalId);
    } else if (minutesUntilTarget < -5) {
      m.status = 'failed';
      m.logs.push(`[${ts}] 目標時間已過`);
      clearInterval(m.intervalId);
    }
  } catch (err) {
    m.logs.push(`[${ts}] 錯誤: ${err.message}`);
    if (m.logs.length > MAX_MONITOR_LOGS) m.logs.shift();
  } finally {
    m.isRunning = false;
    if (monitors.has(monitorId)) persistMonitor(m);
  }
}

// --- Cleanup ---
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(id);
  }
  for (const [id, m] of monitors) {
    if (new Date(m.createdAt).getTime() < now - 12 * 3600 * 1000 && ['notified', 'failed', 'cancelled'].includes(m.status)) {
      clearInterval(m.intervalId);
      monitors.delete(id);
      deletePersistedMonitor(id);
    }
  }
  // Clean old login attempts
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 3600000);
cleanupInterval.unref();

function restorePersistedMonitors() {
  const now = Date.now();
  for (const [id, record] of Object.entries(db.monitors)) {
    if (!record || !record.monitorId) {
      delete db.monitors[id];
      continue;
    }

    const isDone = ['notified', 'failed', 'cancelled'].includes(record.status);
    const createdAt = new Date(record.createdAt).getTime();
    if (isDone && Number.isFinite(createdAt) && createdAt < now - 12 * 3600 * 1000) {
      delete db.monitors[id];
      continue;
    }

    const pollSec = Math.max(30, Math.min(300, validInt(record.pollInterval) ?? 60));
    const monitor = {
      ...record,
      pollInterval: pollSec,
      isRunning: false,
      logs: Array.isArray(record.logs) ? record.logs.slice(-MAX_MONITOR_LOGS) : [],
    };

    if (!isDone) {
      monitor.intervalId = setInterval(() => checkAndNotify(monitor.monitorId), pollSec * 1000);
    }
    monitors.set(monitor.monitorId, monitor);
  }
  saveDb();
}

restorePersistedMonitors();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`SushiRoad server running on http://localhost:${PORT}`);
  });
}

module.exports = { app, monitors, sessions, safeMonitor, sendNtfyNotification };
