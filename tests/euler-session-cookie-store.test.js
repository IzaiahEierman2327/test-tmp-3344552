'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  EulerSessionCookieStore,
  cookieSetDetails,
  isProjectEulerCookie,
} = require('../src/euler-session-cookie-store');

function fakeSafeStorage() {
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptStringAsync: async (buffer) => ({
      result: String(buffer).replace(/^encrypted:/, ''),
      shouldReEncrypt: false,
    }),
  };
}

function fakeSession(initialCookies = []) {
  const events = new EventEmitter();
  const state = {
    cookies: [...initialCookies],
    setCalls: [],
    flushCount: 0,
    storageFlushCount: 0,
  };
  const cookies = {
    get: async (filter = {}) => state.cookies.filter((cookie) => {
      if (filter.session === true && cookie.session !== true) return false;
      if (filter.domain && !String(cookie.domain || '').replace(/^\./, '').endsWith(filter.domain)) return false;
      return true;
    }),
    set: async (details) => {
      state.setCalls.push({ ...details });
    },
    flushStore: async () => { state.flushCount += 1; },
    on: (...args) => events.on(...args),
    removeListener: (...args) => events.removeListener(...args),
    emit: (...args) => events.emit(...args),
  };
  return {
    cookies,
    flushStorageData: async () => { state.storageFlushCount += 1; },
    state,
  };
}

function eulerCookie(overrides = {}) {
  return {
    name: 'session-token',
    value: 'very-secret-auth-value',
    domain: '.projecteuler.net',
    hostOnly: false,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    session: true,
    ...overrides,
  };
}

test('Project Euler domain matching excludes unrelated cookies', () => {
  assert.equal(isProjectEulerCookie({ domain: 'projecteuler.net' }), true);
  assert.equal(isProjectEulerCookie({ domain: '.projecteuler.net' }), true);
  assert.equal(isProjectEulerCookie({ domain: 'sub.projecteuler.net' }), true);
  assert.equal(isProjectEulerCookie({ domain: 'notprojecteuler.net' }), false);
  assert.equal(isProjectEulerCookie({ domain: 'example.com' }), false);
});

test('cookie restore details preserve host-only and domain-cookie semantics', () => {
  const hostOnly = cookieSetDetails(eulerCookie({ domain: 'projecteuler.net', hostOnly: true }));
  assert.equal(hostOnly.url, 'https://projecteuler.net/');
  assert.equal(Object.hasOwn(hostOnly, 'domain'), false);

  const domainCookie = cookieSetDetails(eulerCookie({ domain: '.projecteuler.net', hostOnly: false }));
  assert.equal(domainCookie.domain, '.projecteuler.net');
  assert.equal(domainCookie.secure, true);
  assert.equal(domainCookie.httpOnly, true);
  assert.equal(domainCookie.sameSite, 'lax');
});

test('session cookies are encrypted on disk and restored before navigation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'euler-session-cookie-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'euler-session-cookies.json');
  const source = fakeSession([
    eulerCookie(),
    eulerCookie({ name: 'persistent-preference', value: 'not-session', session: false, expirationDate: 4_102_444_800 }),
    eulerCookie({ name: 'third-party', value: 'outside-secret', domain: '.example.com' }),
  ]);
  const store = new EulerSessionCookieStore({
    session: source,
    safeStorage: fakeSafeStorage(),
    filePath,
  });

  assert.equal(await store.save(), true);
  const raw = await fs.readFile(filePath, 'utf8');
  assert.doesNotMatch(raw, /very-secret-auth-value/);
  assert.doesNotMatch(raw, /outside-secret/);
  assert.doesNotMatch(raw, /persistent-preference/);

  const target = fakeSession();
  const restoredStore = new EulerSessionCookieStore({
    session: target,
    safeStorage: fakeSafeStorage(),
    filePath,
  });
  assert.equal(await restoredStore.restore(), 1);
  assert.equal(target.state.setCalls.length, 1);
  assert.equal(target.state.setCalls[0].name, 'session-token');
  assert.equal(target.state.setCalls[0].value, 'very-secret-auth-value');
  assert.equal(Object.hasOwn(target.state.setCalls[0], 'expirationDate'), false);
});

test('logging out removes the encrypted session snapshot instead of reviving stale auth', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'euler-session-logout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'euler-session-cookies.json');
  const current = fakeSession([eulerCookie()]);
  const store = new EulerSessionCookieStore({
    session: current,
    safeStorage: fakeSafeStorage(),
    filePath,
    autosaveDelayMs: 5,
  });

  await store.save();
  await fs.access(filePath);

  store.startAutoSave();
  current.state.cookies = [];
  current.cookies.emit('changed', {}, eulerCookie(), 'explicit', true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(() => fs.access(filePath), { code: 'ENOENT' });
  await store.shutdown();
  assert.equal(current.state.flushCount, 1);
  assert.equal(current.state.storageFlushCount, 1);
});

test('secure-storage unavailability never falls back to plaintext cookie storage', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'euler-session-no-crypto-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'euler-session-cookies.json');
  const current = fakeSession([eulerCookie()]);
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => false,
    encryptStringAsync: async () => { throw new Error('must not be called'); },
  };
  const store = new EulerSessionCookieStore({ session: current, safeStorage, filePath });
  assert.equal(await store.save(), false);
  await assert.rejects(() => fs.access(filePath), { code: 'ENOENT' });
});
