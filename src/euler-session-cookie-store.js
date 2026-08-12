'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const PROJECT_EULER_DOMAIN = 'projecteuler.net';
const SNAPSHOT_SCHEMA_VERSION = 1;
const AUTOSAVE_DELAY_MS = 250;
const ALLOWED_SAME_SITE = new Set(['unspecified', 'no_restriction', 'lax', 'strict']);

function normalizeDomain(value) {
  return String(value || '').trim().toLowerCase().replace(/^\./, '');
}

function isProjectEulerCookie(cookie) {
  const domain = normalizeDomain(cookie?.domain);
  return domain === PROJECT_EULER_DOMAIN || domain.endsWith(`.${PROJECT_EULER_DOMAIN}`);
}

function cookieSetDetails(cookie) {
  if (!cookie || typeof cookie !== 'object') throw new TypeError('Invalid cookie snapshot');
  const host = normalizeDomain(cookie.domain);
  if (!host || !isProjectEulerCookie(cookie)) throw new TypeError('Cookie is outside Project Euler');

  const cookiePath = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
  const details = {
    url: `https://${host}${cookiePath}`,
    name: String(cookie.name || ''),
    value: String(cookie.value || ''),
    path: cookiePath,
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };

  // Electron does not accept hostOnly in cookies.set(). Omitting domain is how
  // a host-only cookie is preserved; domain cookies explicitly carry domain.
  if (!cookie.hostOnly && cookie.domain) details.domain = String(cookie.domain);
  if (ALLOWED_SAME_SITE.has(cookie.sameSite)) details.sameSite = cookie.sameSite;
  return details;
}

function snapshotCookie(cookie) {
  return {
    name: String(cookie.name || ''),
    value: String(cookie.value || ''),
    domain: String(cookie.domain || ''),
    hostOnly: Boolean(cookie.hostOnly),
    path: typeof cookie.path === 'string' ? cookie.path : '/',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: ALLOWED_SAME_SITE.has(cookie.sameSite) ? cookie.sameSite : 'unspecified',
  };
}

class EulerSessionCookieStore {
  constructor({ session, safeStorage, filePath, log = console, autosaveDelayMs = AUTOSAVE_DELAY_MS }) {
    if (!session?.cookies) throw new TypeError('Electron session with cookies is required');
    if (!filePath) throw new TypeError('Cookie snapshot file path is required');
    this.session = session;
    this.safeStorage = safeStorage || null;
    this.filePath = filePath;
    this.log = log;
    this.autosaveDelayMs = autosaveDelayMs;
    this._writeChain = Promise.resolve();
    this._autosaveTimer = null;
    this._cookieListener = null;
  }

  async _encrypt(plainText) {
    if (!this.safeStorage) return null;
    if (typeof this.safeStorage.encryptStringAsync === 'function') {
      if (typeof this.safeStorage.isAsyncEncryptionAvailable === 'function') {
        const available = await this.safeStorage.isAsyncEncryptionAvailable();
        if (!available) return null;
      }
      return Buffer.from(await this.safeStorage.encryptStringAsync(plainText));
    }
    if (typeof this.safeStorage.isEncryptionAvailable === 'function' &&
        this.safeStorage.isEncryptionAvailable() &&
        typeof this.safeStorage.encryptString === 'function') {
      return Buffer.from(this.safeStorage.encryptString(plainText));
    }
    return null;
  }

  async _decrypt(buffer) {
    if (!this.safeStorage) return null;
    if (typeof this.safeStorage.decryptStringAsync === 'function') {
      if (typeof this.safeStorage.isAsyncEncryptionAvailable === 'function') {
        const available = await this.safeStorage.isAsyncEncryptionAvailable();
        if (!available) return null;
      }
      const decrypted = await this.safeStorage.decryptStringAsync(buffer);
      return {
        text: String(decrypted?.result ?? ''),
        shouldReEncrypt: Boolean(decrypted?.shouldReEncrypt),
      };
    }
    if (typeof this.safeStorage.isEncryptionAvailable === 'function' &&
        this.safeStorage.isEncryptionAvailable() &&
        typeof this.safeStorage.decryptString === 'function') {
      return { text: String(this.safeStorage.decryptString(buffer)), shouldReEncrypt: false };
    }
    return null;
  }

  async _writeEncrypted(plainText) {
    const encrypted = await this._encrypt(plainText);
    if (!encrypted) {
      // Never leave a stale login snapshot around when secure storage is not
      // available; falling back to plaintext would expose authentication data.
      await fs.rm(this.filePath, { force: true });
      return false;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const wrapper = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      ciphertext: encrypted.toString('base64'),
    };
    await fs.writeFile(tempPath, `${JSON.stringify(wrapper)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, this.filePath);
    return true;
  }

  save() {
    // Serialize the read as well as the write. If a login-cookie read is slow
    // while a later logout event is fast, allowing the reads to race could let
    // the stale login snapshot write last and resurrect authentication.
    this._writeChain = this._writeChain.then(async () => {
      const cookies = await this.session.cookies.get({ domain: PROJECT_EULER_DOMAIN, session: true });
      const sessionCookies = (cookies || [])
        .filter((cookie) => cookie?.session !== false && isProjectEulerCookie(cookie))
        .map(snapshotCookie);

      if (!sessionCookies.length) {
        // This is important for explicit logout: removing the live auth cookie
        // also removes the encrypted snapshot instead of reviving an old login.
        await fs.rm(this.filePath, { force: true });
        return false;
      }
      return this._writeEncrypted(JSON.stringify({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        cookies: sessionCookies,
      }));
    });
    return this._writeChain;
  }

  async restore() {
    let wrapper;
    try {
      wrapper = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log.warn?.(`[euler-session] could not read cookie snapshot: ${error.message}`);
      return 0;
    }

    if (wrapper?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || typeof wrapper?.ciphertext !== 'string') {
      this.log.warn?.('[euler-session] ignoring invalid cookie snapshot');
      return 0;
    }

    try {
      const decrypted = await this._decrypt(Buffer.from(wrapper.ciphertext, 'base64'));
      if (!decrypted?.text) return 0;
      const snapshot = JSON.parse(decrypted.text);
      if (snapshot?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || !Array.isArray(snapshot.cookies)) return 0;

      let restored = 0;
      for (const cookie of snapshot.cookies) {
        if (!isProjectEulerCookie(cookie)) continue;
        await this.session.cookies.set(cookieSetDetails(cookie));
        restored += 1;
      }

      if (decrypted.shouldReEncrypt) await this._writeEncrypted(decrypted.text);
      return restored;
    } catch (error) {
      this.log.warn?.(`[euler-session] could not restore cookie snapshot: ${error.message}`);
      // A corrupt or undecryptable snapshot should not keep failing forever.
      await fs.rm(this.filePath, { force: true }).catch(() => {});
      return 0;
    }
  }

  startAutoSave() {
    if (this._cookieListener) return;
    this._cookieListener = (_event, cookie) => {
      if (!isProjectEulerCookie(cookie)) return;
      if (this._autosaveTimer) clearTimeout(this._autosaveTimer);
      this._autosaveTimer = setTimeout(() => {
        this._autosaveTimer = null;
        this.save().catch((error) => this.log.warn?.(`[euler-session] autosave failed: ${error.message}`));
      }, this.autosaveDelayMs);
    };
    this.session.cookies.on('changed', this._cookieListener);
  }

  async shutdown() {
    if (this._autosaveTimer) {
      clearTimeout(this._autosaveTimer);
      this._autosaveTimer = null;
    }
    if (this._cookieListener && typeof this.session.cookies.removeListener === 'function') {
      this.session.cookies.removeListener('changed', this._cookieListener);
      this._cookieListener = null;
    }

    await this.save();
    await this._writeChain;
    await this.session.cookies.flushStore?.();
    await this.session.flushStorageData?.();
  }
}

module.exports = {
  AUTOSAVE_DELAY_MS,
  EulerSessionCookieStore,
  PROJECT_EULER_DOMAIN,
  cookieSetDetails,
  isProjectEulerCookie,
  snapshotCookie,
};
