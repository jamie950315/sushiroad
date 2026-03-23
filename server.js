const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3737;

const API_BASE = 'https://crm-tw.akindo-sushiro.co.jp/api/2.0';
const REGION = 'TW';
const UA = 'Dart/3.6 (dart:io)';
const FETCH_TIMEOUT_MS = 12000;
const MAX_MONITORS_PER_SESSION = 3;
const MAX_MONITOR_LOGS = 100;

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

// --- Validation helpers ---
function validInt(v) { if (!/^\d+$/.test(String(v))) return null; const n = Number(v); return Number.isInteger(n) ? n : null; }
function validNtfyTopic(t) { return typeof t === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(t); }

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
      sessions.set(sessionId, {
        basicAuth: makeBasicAuth(email, password),
        email,
        customerId: result.data.customerid,
        expiresAt: Date.now() + 24 * 3600 * 1000,
      });
      res.json({ sessionId, email, success: true });
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
  res.json({ valid: true, email: session.email });
});

app.delete('/api/auth/session/:sessionId', (req, res) => {
  const sid = req.params.sessionId;
  sessions.delete(sid);
  // Cancel orphan monitors for this session
  for (const [id, m] of monitors) {
    if (m.sessionId === sid && (m.status === 'waiting' || m.status === 'monitoring')) {
      clearInterval(m.intervalId);
      m.status = 'cancelled';
      monitors.delete(id);
    }
  }
  res.json({ success: true });
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

    const auth = getAuthHeaders(sessionId);
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
        return res.json({
          success: true,
          ticketId: created.TICKET_DETAIL.ticketId,
          ticketNo: created.TICKET_DETAIL.number,
          checkinCode: String(created.TICKET_DETAIL.ticketId).slice(-4),
          waitTime: created.TICKET_DETAIL.wait,
          storeName: created.STORE_INFO?.name,
          date: created.TICKET_DETAIL.queueDate,
          time: created.TICKET_DETAIL.start,
          guid,
        });
      }
    }

    if (result.data?.code === 'E052') {
      return res.json({ error: '已有預約，請先取消', code: 'E052' });
    }

    res.json({ ...result.data, guid });
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

app.post('/api/ticket/cancel', async (req, res) => {
  try {
    const { guid, ticketNo, ticketId, storeid, sessionId } = req.body;
    if (sessionId) {
      const auth = getAuthHeaders(sessionId);
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
    const { storeid, storeName, adult = 2, child = 0, targetTime, ntfyTopic, pollInterval = 60, sessionId } = req.body;
    if (!sessionId) return res.status(401).json({ error: 'login required' });
    if (!getAuthHeaders(sessionId)) return res.status(401).json({ error: 'session expired' });

    const sid = validInt(storeid);
    if (sid === null || !targetTime) return res.status(400).json({ error: 'storeid and targetTime required' });
    if (!validNtfyTopic(ntfyTopic)) return res.status(400).json({ error: 'invalid ntfyTopic (alphanumeric, 1-64 chars)' });

    // Cap monitors per session
    let sessionMonitors = 0;
    for (const [, m] of monitors) {
      if (m.sessionId === sessionId && (m.status === 'waiting' || m.status === 'monitoring')) sessionMonitors++;
    }
    if (sessionMonitors >= MAX_MONITORS_PER_SESSION) {
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

    const monitor = {
      monitorId, storeid: sid, storeName: storeName || '', adult, child, targetTime, ntfyTopic,
      sessionId,
      targetAt: targetAt.getTime(),
      status: 'waiting',
      lastWait: null,
      isRunning: false,
      createdAt: new Date().toISOString(),
      logs: [],
    };

    monitor.intervalId = setInterval(() => checkAndNotify(monitorId), intervalMs);
    monitors.set(monitorId, monitor);
    checkAndNotify(monitorId);

    res.json({ monitorId, status: 'waiting' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function safeMonitor(m) {
  const { intervalId, isRunning, sessionId, ntfyTopic, ...safe } = m;
  return safe;
}

app.get('/api/monitor/:id', (req, res) => {
  const m = monitors.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const { sessionId } = req.query;
  if (m.sessionId && sessionId !== m.sessionId) return res.status(403).json({ error: 'Forbidden' });
  res.json(safeMonitor(m));
});

app.delete('/api/monitor/:id', (req, res) => {
  const m = monitors.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const { sessionId } = req.body || req.query;
  if (m.sessionId && sessionId !== m.sessionId) return res.status(403).json({ error: 'Forbidden' });
  clearInterval(m.intervalId);
  m.status = 'cancelled';
  monitors.delete(req.params.id);
  res.json(safeMonitor(m));
});

app.get('/api/monitors', (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.json([]);
  const list = [];
  for (const [, m] of monitors) {
    if (m.sessionId !== sessionId) continue;
    list.push(safeMonitor(m));
  }
  res.json(list);
});

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

    const qs = new URLSearchParams({ guid: uuidv4(), region: REGION });
    const storeResult = await sushiroFetch(`/info/storelist?${qs}`);
    const stores = storeResult.data;
    const store = Array.isArray(stores) ? stores.find(s => s.id === m.storeid) : null;

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

    if (waitMinutes === 0 && minutesUntilTarget <= 15 && minutesUntilTarget >= -5) {
      // No queue — just go eat
      shouldNotify = true;
      notifyTitle = `壽司郎 ${store.name} - 現在沒人排隊！`;
      notifyMessage = `🍣 ${store.name}\n🎉 目前無需等候，直接去吃！\n👥 ${m.adult}大${m.child}小`;
      m.logs.push(`[${ts}] 無人排隊，直接去吃！`);
    } else if (waitMinutes > 0) {
      // Has queue — check if now + wait ≈ target
      const lowerBound = waitMinutes - 10;
      const upperBound = waitMinutes + 5;
      if (minutesUntilTarget <= upperBound && minutesUntilTarget >= Math.max(lowerBound, -5)) {
        shouldNotify = true;
        notifyTitle = `壽司郎 ${store.name} - 現在去抽號！`;
        notifyMessage = `🍣 ${store.name}\n⏰ 目前等候 ${waitMinutes} 分鐘\n👥 ${m.adult}大${m.child}小\n\n請立即打開壽司郎 APP 按「立即前往」抽號！`;
        m.logs.push(`[${ts}] 最佳時機！現在抽號等 ${waitMinutes}分 → 剛好趕上目標時間`);
      }
    }

    if (shouldNotify) {
      if (!monitors.has(monitorId) || m.status === 'cancelled') return;

      try {
        await fetch(`https://ntfy.sh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topic: m.ntfyTopic,
            title: notifyTitle,
            message: notifyMessage,
            priority: 5,
            tags: ['sushi', 'bell'],
          }),
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
  }
}

// --- Cleanup ---
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt < now) {
      sessions.delete(id);
      // Cancel orphan monitors
      for (const [mid, m] of monitors) {
        if (m.sessionId === id && (m.status === 'waiting' || m.status === 'monitoring')) {
          clearInterval(m.intervalId);
          m.status = 'cancelled';
          monitors.delete(mid);
        }
      }
    }
  }
  for (const [id, m] of monitors) {
    if (new Date(m.createdAt).getTime() < now - 12 * 3600 * 1000 && ['notified', 'failed', 'cancelled'].includes(m.status)) {
      clearInterval(m.intervalId);
      monitors.delete(id);
    }
  }
  // Clean old login attempts
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 3600000);

app.listen(PORT, () => {
  console.log(`SushiRoad server running on http://localhost:${PORT}`);
});
