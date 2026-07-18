const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sushiroad-test-'));
process.env.SUSHIROAD_DB = path.join(testDir, 'db.json');

const { app, monitors, sessions } = require('../server');

let server;
let port;
let originalFetch;

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method, port, path: route, headers: body ? { 'Content-Type': 'application/json' } : {} }, res => {
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

function mockExternalFetch(ntfyStatus = 200) {
  const ntfyPayloads = [];
  global.fetch = async (url, options = {}) => {
    if (url === 'https://ntfy.sh') {
      ntfyPayloads.push(JSON.parse(options.body));
      return new Response('', { status: ntfyStatus });
    }
    if (String(url).includes('/info/storelist')) {
      return new Response(JSON.stringify([{ id: 123, name: '測試店', wait: 0, storeStatus: 'CLOSED' }]), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return ntfyPayloads;
}

function addSession(sessionId, email) {
  sessions.set(sessionId, {
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

  const created = await request('POST', '/api/monitor', {
    sessionId: 'session-success',
    storeid: 123,
    storeName: '測試店',
    targetTime: '20:00',
    ntfyTopic: 'success-sushiroad',
  });

  assert.equal(created.status, 200);
  assert.equal(created.body.ntfyTopic, 'success-sushiroad');
  assert.equal(created.body.startNotificationSent, true);
  assert.equal(payloads[0].topic, 'success-sushiroad');
  assert.match(payloads[0].title, /測試店.*監控已啟動/);
  assert.match(payloads[0].message, new RegExp(created.body.monitorId));

  const listed = await request('GET', '/api/monitors?sessionId=session-success');
  assert.equal(listed.status, 200);
  assert.equal(listed.body[0].ntfyTopic, 'success-sushiroad');

  addSession('session-other', 'other@example.com');
  const otherAccount = await request('GET', '/api/monitors?sessionId=session-other');
  assert.deepEqual(otherAccount.body, []);

  await removeMonitor(created.body.monitorId);
  sessions.delete('session-success');
  sessions.delete('session-other');
});

test('ntfy HTTP errors are reported while monitoring continues', { concurrency: false }, async () => {
  const payloads = mockExternalFetch(503);
  addSession('session-failure', 'failure@example.com');

  const created = await request('POST', '/api/monitor', {
    sessionId: 'session-failure',
    storeid: 123,
    storeName: '測試店',
    targetTime: '20:00',
    ntfyTopic: 'failure-sushiroad',
  });

  assert.equal(created.status, 200);
  assert.equal(created.body.startNotificationSent, false);
  assert.equal(payloads.length, 1);
  assert.equal(monitors.has(created.body.monitorId), true);
  assert.match(monitors.get(created.body.monitorId).logs[0], /啟動通知發送失敗: ntfy HTTP 503/);

  await removeMonitor(created.body.monitorId);
  sessions.delete('session-failure');
});
