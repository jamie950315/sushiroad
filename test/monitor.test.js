const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sushiroad-test-'));
process.env.SUSHIROAD_DB = path.join(testDir, 'db.json');

const { app, monitors, sessions, sessionStorageKey, targetTimestamp, monitorStoreCache } = require('../server');

let server;
let port;
let originalFetch;

function request(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method, port, path: route, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function futureTarget(minutes = 60) {
  const date = new Date(Date.now() + minutes * 60000);
  return {
    targetDate: date.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }),
    targetTime: date.toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }),
  };
}

function mockExternalFetch(ntfyStatus = 200, store = { id: 123, name: '測試店', wait: 0, storeStatus: 'CLOSED' }) {
  const ntfyPayloads = [];
  monitorStoreCache.stores = null;
  monitorStoreCache.fetchedAt = 0;
  monitorStoreCache.inFlight = null;
  global.fetch = async (url, options = {}) => {
    if (url === 'https://ntfy.sh') {
      ntfyPayloads.push(JSON.parse(options.body));
      return new Response('', { status: ntfyStatus });
    }
    if (String(url).includes('/info/storelist')) {
      return new Response(JSON.stringify([store]), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return ntfyPayloads;
}

function addSession(sessionId, email) {
  sessions.set(sessionStorageKey(sessionId), {
    basicAuth: 'test',
    email,
    expiresAt: Date.now() + 60000,
  });
}

async function removeMonitor(monitorId) {
  const monitor = monitors.get(monitorId);
  if (monitor?.intervalId) clearInterval(monitor.intervalId);
  monitors.delete(monitorId);
  await new Promise(resolve => setTimeout(resolve, 20));
}

before(async () => {
  originalFetch = global.fetch;
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  port = server.address().port;
});

after(async () => {
  for (const monitor of monitors.values()) clearInterval(monitor.intervalId);
  global.fetch = originalFetch;
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('monitor creation sends a start notification and exposes its topic', { concurrency: false }, async () => {
  const payloads = mockExternalFetch(200);
  addSession('session-success', 'success@example.com');
  const target = futureTarget();

  const created = await request('POST', '/api/monitor', {
    sessionId: 'session-success',
    storeid: 123,
    storeName: '測試店',
    ...target,
    ntfyTopic: 'success-sushiroad',
  });

  assert.equal(created.status, 200);
  assert.equal(created.body.ntfyTopic, 'success-sushiroad');
  assert.equal(created.body.startNotificationSent, true);
  assert.equal(payloads[0].topic, 'success-sushiroad');
  assert.equal(payloads[0].click, 'shortcuts://run-shortcut?name=Open%20Sushiro');
  assert.match(payloads[0].title, /測試店.*監控已啟動/);
  assert.match(payloads[0].message, new RegExp(created.body.monitorId));

  const listed = await request('GET', '/api/monitors?sessionId=session-success');
  assert.equal(listed.status, 200);
  assert.equal(listed.body[0].ntfyTopic, 'success-sushiroad');

  addSession('session-other', 'other@example.com');
  const otherAccount = await request('GET', '/api/monitors?sessionId=session-other');
  assert.deepEqual(otherAccount.body, []);

  await removeMonitor(created.body.monitorId);
  sessions.delete(sessionStorageKey('session-success'));
  sessions.delete(sessionStorageKey('session-other'));
});

test('ntfy HTTP errors are reported while monitoring continues', { concurrency: false }, async () => {
  const payloads = mockExternalFetch(503);
  addSession('session-failure', 'failure@example.com');
  const target = futureTarget();

  const created = await request('POST', '/api/monitor', {
    sessionId: 'session-failure',
    storeid: 123,
    storeName: '測試店',
    ...target,
    ntfyTopic: 'failure-sushiroad',
  });

  assert.equal(created.status, 200);
  assert.equal(created.body.startNotificationSent, false);
  assert.equal(payloads.length, 1);
  assert.equal(monitors.has(created.body.monitorId), true);
  assert.match(monitors.get(created.body.monitorId).logs[0], /啟動通知發送失敗: ntfy HTTP 503/);

  await removeMonitor(created.body.monitorId);
  sessions.delete(sessionStorageKey('session-failure'));
});

test('guest token can create, list, inspect, and cancel only its own monitor', { concurrency: false }, async () => {
  mockExternalFetch(200);
  const guestToken = 'A'.repeat(43);
  const otherToken = 'B'.repeat(43);
  const auth = { Authorization: `Bearer ${guestToken}` };
  const target = futureTarget();

  const created = await request('POST', '/api/monitor', {
    storeid: 123,
    storeName: '訪客測試店',
    adult: 3,
    child: 1,
    ...target,
    ntfyTopic: 'guest-topic',
  }, auth);

  assert.equal(created.status, 200);
  assert.match(created.body.monitorId, /^[A-Za-z0-9_-]{22}$/);

  const listed = await request('GET', '/api/monitors', null, auth);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].adult, 3);
  assert.equal(listed.body[0].ownerId, undefined);
  assert.equal(listed.body[0].ownerType, undefined);

  const inspected = await request('GET', `/api/monitor/${created.body.monitorId}`, null, auth);
  assert.equal(inspected.status, 200);

  const hidden = await request('GET', `/api/monitor/${created.body.monitorId}`, null, { Authorization: `Bearer ${otherToken}` });
  assert.equal(hidden.status, 404);
  const forbiddenDelete = await request('DELETE', `/api/monitor/${created.body.monitorId}`, null, { Authorization: `Bearer ${otherToken}` });
  assert.equal(forbiddenDelete.status, 404);
  assert.equal(monitors.has(created.body.monitorId), true);

  const rawDb = fs.readFileSync(process.env.SUSHIROAD_DB, 'utf8');
  assert.equal(rawDb.includes(guestToken), false);
  assert.equal(rawDb.includes('guest-monitor:v1'), false);

  const cancelled = await request('DELETE', `/api/monitor/${created.body.monitorId}`, null, auth);
  assert.equal(cancelled.status, 200);
  assert.equal(monitors.has(created.body.monitorId), false);
});

test('monitor credentials and guest input are validated', { concurrency: false }, async () => {
  mockExternalFetch(200);
  const token = 'C'.repeat(43);

  assert.equal((await request('GET', '/api/monitors')).status, 401);
  assert.equal((await request('GET', '/api/monitors', null, { Authorization: 'Bearer short' })).status, 401);

  addSession('both-session', 'both@example.com');
  const target = futureTarget();
  const both = await request('POST', '/api/monitor', {
    sessionId: 'both-session',
    storeid: 123,
    storeName: '測試店',
    adult: 2,
    child: 0,
    ...target,
    ntfyTopic: 'both-topic',
  }, { Authorization: `Bearer ${token}` });
  assert.equal(both.status, 400);
  sessions.delete(sessionStorageKey('both-session'));

  const invalid = await request('POST', '/api/monitor', {
    storeid: 123,
    storeName: '測試店',
    adult: 0,
    child: 0,
    targetDate: '2026-02-30',
    targetTime: '99:99',
    ntfyTopic: 'guest-topic',
  }, { Authorization: `Bearer ${token}` });
  assert.equal(invalid.status, 400);
});

test('explicit dates prevent silent next-day rollover and impossible wait targets', { concurrency: false }, async () => {
  const token = 'D'.repeat(43);
  const auth = { Authorization: `Bearer ${token}` };
  const payloads = mockExternalFetch(200, { id: 123, name: '測試店', wait: 130, storeStatus: 'OPEN' });

  const past = futureTarget(-60);
  const rejectedPast = await request('POST', '/api/monitor', {
    storeid: 123, storeName: '測試店', adult: 2, child: 0,
    ...past, ntfyTopic: 'date-test-topic',
  }, auth);
  assert.equal(rejectedPast.status, 400);
  assert.match(rejectedPast.body.error, /已經過/);

  const tooSoon = futureTarget(30);
  const rejectedWait = await request('POST', '/api/monitor', {
    storeid: 123, storeName: '測試店', adult: 2, child: 0,
    ...tooSoon, ntfyTopic: 'date-test-topic',
  }, auth);
  assert.equal(rejectedWait.status, 400);
  assert.match(rejectedWait.body.error, /目前等候約 130 分鐘/);
  assert.equal(payloads.length, 0);

  const tomorrow = futureTarget(24 * 60);
  const created = await request('POST', '/api/monitor', {
    storeid: 123, storeName: '測試店', adult: 2, child: 0,
    ...tomorrow, ntfyTopic: 'date-test-topic',
  }, auth);
  assert.equal(created.status, 200);
  const monitor = monitors.get(created.body.monitorId);
  assert.equal(monitor.targetDate, tomorrow.targetDate);
  assert.equal(monitor.targetAt, targetTimestamp(tomorrow.targetDate, tomorrow.targetTime));
  await removeMonitor(created.body.monitorId);
});

test('Taipei target timestamps validate calendar dates and cross midnight explicitly', () => {
  assert.equal(targetTimestamp('2026-02-30', '12:00'), null);
  assert.equal(targetTimestamp('2028-02-29', '12:00'), Date.parse('2028-02-29T12:00:00+08:00'));
  const beforeMidnight = Date.parse('2026-12-31T23:58:00+08:00');
  const afterMidnight = targetTimestamp('2027-01-01', '00:10');
  assert.equal((afterMidnight - beforeMidnight) / 60000, 12);
});
