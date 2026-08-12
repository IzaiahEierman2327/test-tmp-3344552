'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { AIManager, parseCompletionText } = require('../src/ai-manager');

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (buffer) => String(buffer).replace(/^encrypted:/, ''),
  };
}

async function startMockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
  };
}

test('AI settings never persist plaintext API keys and remembered keys can be reused', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'euler-ai-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new AIManager({ settingsRoot: root, safeStorage: fakeSafeStorage() });

  await manager.saveConfig({
    endpoint: 'https://example.invalid/v1/chat/completions',
    model: 'custom-model',
    temperature: 0.4,
    apiKey: 'super-secret-key',
    rememberKey: true,
  });
  const raw = await fs.readFile(path.join(root, 'ai.json'), 'utf8');
  assert.doesNotMatch(raw, /super-secret-key/);
  const loaded = await manager.loadConfig({ includeSecret: true });
  assert.equal(loaded.apiKey, 'super-secret-key');
  assert.equal(loaded.storedKeyAvailable, true);

  await manager.saveConfig({
    endpoint: loaded.endpoint,
    model: 'custom-model-2',
    temperature: 0.2,
    apiKey: '',
    rememberKey: true,
  });
  assert.equal((await manager.loadConfig({ includeSecret: true })).apiKey, 'super-secret-key');
});

test('AI manager calls a user-provided OpenAI-compatible completion endpoint', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'euler-ai-endpoint-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let received = null;
  let authorization = null;
  const mock = await startMockServer(async (request, response) => {
    authorization = request.headers.authorization;
    let body = '';
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: '# Analysis\n\nUser-derived explanation.' } }] }));
  });
  t.after(() => new Promise((resolve) => mock.server.close(resolve)));

  const manager = new AIManager({ settingsRoot: root, safeStorage: fakeSafeStorage() });
  await manager.saveConfig({
    endpoint: mock.url,
    model: 'local-model',
    apiKey: 'abc123',
    rememberKey: false,
    temperature: 0.3,
  });
  const result = await manager.generateArticle({
    problemId: 3,
    sourceText: '```python\nanswer = 6857\n```',
    instruction: 'Explain the factorization idea.',
  });
  assert.equal(authorization, 'Bearer abc123');
  assert.equal(received.model, 'local-model');
  assert.equal(received.messages.length, 2);
  assert.match(received.messages[0].content, /Use only information supported/);
  assert.match(received.messages[1].content, /answer = 6857/);
  assert.match(result.text, /User-derived explanation/);
});

test('AI requests time out instead of hanging indefinitely', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'euler-ai-timeout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const mock = await startMockServer(() => {
    // Intentionally never write a response. The client must abort the request.
  });
  t.after(() => {
    mock.server.closeAllConnections?.();
    return new Promise((resolve) => mock.server.close(resolve));
  });

  const manager = new AIManager({
    settingsRoot: root,
    safeStorage: fakeSafeStorage(),
    requestTimeoutMs: 100,
  });
  await manager.saveConfig({
    endpoint: mock.url,
    model: 'slow-model',
    apiKey: '',
    rememberKey: false,
    temperature: 0,
  });

  const started = Date.now();
  await assert.rejects(() => manager.testConnection(), /timed out after 100 ms/);
  assert.ok(Date.now() - started < 2_000, 'timeout should fail promptly');
});

test('completion text parser accepts common compatible response shapes', () => {
  assert.equal(parseCompletionText({ choices: [{ message: { content: 'chat' } }] }), 'chat');
  assert.equal(parseCompletionText({ choices: [{ text: 'legacy' }] }), 'legacy');
  assert.equal(parseCompletionText({ output_text: 'responses-style' }), 'responses-style');
});
