const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sushiroad-session-test-'));
const dbPath = path.join(testDir, 'db.json');
process.env.SUSHIROAD_DB = dbPath;
process.env.SUSHIROAD_SESSION_SECRET = 'session-test-secret-with-at-least-32-bytes';

const { app, sessions, SESSION_TTL_MS, sessionStorageKey } = require('../server');

let server;
let port;
let originalFetch;

function request(targetPort, method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: targetPort,
      path: route,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, res => {
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

function startFreshServer() {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, '..', 'test-support', 'server-process.js'), {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        SUSHIROAD_DB: dbPath,
        SUSHIROAD_SESSION_SECRET: process.env.SUSHIROAD_SESSION_SECRET,
      },
      silent: true,
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('fresh server did not start'));
    }, 5000);
    child.once('error', reject);
    child.once('message', message => {
      clearTimeout(timeout);
      resolve({ child, port: message.port });
    });
  });
}

function stopFreshServer(child) {
  return new Promise(resolve => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}

function startWithWrongKey() {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, '..', 'test-support', 'server-process.js'), {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        SUSHIROAD_DB: dbPath,
        SUSHIROAD_SESSION_SECRET: 'a-different-session-key-that-cannot-decrypt',
      },
      silent: true,
    });
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
}

before(async () => {
  originalFetch = global.fetch;
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  port = server.address().port;
});

after(async () => {
  global.fetch = originalFetch;
  if (server.listening) await new Promise(resolve => server.close(resolve));
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('login persists an encrypted one-year session across server restarts', { concurrency: false }, async () => {
  const password = 'unique-test-password';
  const basicAuth = Buffer.from(`person@example.com@TW:${password}`).toString('base64');
  global.fetch = async url => {
    if (String(url).includes('/remote/login')) {
      return new Response(JSON.stringify({ status: 'SUCCESS', customerid: 'customer-1' }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const beforeLogin = Date.now();
  const loggedIn = await request(port, 'POST', '/api/auth/login', {
    email: 'person@example.com',
    password,
  });
  const afterLogin = Date.now();

  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.body.success, true);
  assert.match(loggedIn.body.sessionId, /^[A-Za-z0-9_-]{43}$/);

  const storageKey = sessionStorageKey(loggedIn.body.sessionId);
  const session = sessions.get(storageKey);
  assert.ok(session);
  assert.ok(session.expiresAt >= beforeLogin + SESSION_TTL_MS);
  assert.ok(session.expiresAt <= afterLogin + SESSION_TTL_MS);

  const rawDb = fs.readFileSync(dbPath, 'utf8');
  const storedDb = JSON.parse(rawDb);
  assert.equal(storedDb.version, 3);
  assert.ok(storedDb.sessions[storageKey]?.encryptedAuth?.ciphertext);
  assert.equal(rawDb.includes(loggedIn.body.sessionId), false);
  assert.equal(rawDb.includes(password), false);
  assert.equal(rawDb.includes(basicAuth), false);
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);

  assert.notEqual(await startWithWrongKey(), 0);
  assert.equal(fs.readFileSync(dbPath, 'utf8'), rawDb);

  const fresh = await startFreshServer();
  try {
    const restored = await request(fresh.port, 'GET', `/api/auth/session/${loggedIn.body.sessionId}`);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.valid, true);
    assert.equal(restored.body.email, 'person@example.com');
  } finally {
    await stopFreshServer(fresh.child);
  }

  const loggedOut = await request(port, 'DELETE', `/api/auth/session/${loggedIn.body.sessionId}`);
  assert.equal(loggedOut.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(dbPath, 'utf8')).sessions[storageKey], undefined);

  const afterLogoutRestart = await startFreshServer();
  try {
    const invalid = await request(afterLogoutRestart.port, 'GET', `/api/auth/session/${loggedIn.body.sessionId}`);
    assert.equal(invalid.status, 401);
    assert.equal(invalid.body.valid, false);
  } finally {
    await stopFreshServer(afterLogoutRestart.child);
  }
});

test('expired sessions are rejected and removed from persistent storage', { concurrency: false }, async () => {
  global.fetch = async url => {
    if (String(url).includes('/remote/login')) {
      return new Response(JSON.stringify({ status: 'SUCCESS', customerid: 'customer-2' }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const loggedIn = await request(port, 'POST', '/api/auth/login', {
    email: 'expired@example.com',
    password: 'expired-password',
  });
  const storageKey = sessionStorageKey(loggedIn.body.sessionId);
  sessions.get(storageKey).expiresAt = Date.now() - 1;

  const expired = await request(port, 'GET', `/api/auth/session/${loggedIn.body.sessionId}`);
  assert.equal(expired.status, 401);
  assert.equal(expired.body.valid, false);
  assert.equal(sessions.has(storageKey), false);
  assert.equal(JSON.parse(fs.readFileSync(dbPath, 'utf8')).sessions[storageKey], undefined);
});
