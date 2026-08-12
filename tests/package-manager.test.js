'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  canonicalPackageName,
  removeManagedDistribution,
  runProcess,
  validatePackageName,
  validatePackageSpec,
} = require('../src/package-manager');

test('package specifications reject control characters and pip options while package names are constrained', () => {
  assert.equal(validatePackageSpec('pandas==2.3.1'), 'pandas==2.3.1');
  assert.equal(validatePackageSpec('git+https://example.invalid/demo.git'), 'git+https://example.invalid/demo.git');
  assert.throws(() => validatePackageSpec('pandas\n--target=/tmp'), /single non-empty line/);
  assert.throws(() => validatePackageSpec('--target=/tmp'), /must not be a pip option/);
  assert.throws(() => validatePackageSpec('-r=requirements.txt'), /must not be a pip option/);
  assert.equal(validatePackageName('my-package_2'), 'my-package_2');
  assert.throws(() => validatePackageName('../base-runtime'), /Invalid package name/);
  assert.equal(canonicalPackageName('My_Package.Name'), 'my-package-name');
});

test('managed subprocesses are terminated after the configured timeout', async () => {
  const started = Date.now();
  await assert.rejects(
    () => runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 100 }),
    /Process timed out after 100 ms/
  );
  assert.ok(Date.now() - started < 2_000, 'stalled process should be terminated promptly');
});

test('managed uninstall deletes only files described by a distribution inside packagesRoot', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'euler-pip-layer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packagesRoot = path.join(root, 'python-packages');
  const moduleDir = path.join(packagesRoot, 'demo_pkg');
  const distInfo = path.join(packagesRoot, 'demo_pkg-1.0.dist-info');
  const outside = path.join(root, 'outside.txt');
  await fs.mkdir(moduleDir, { recursive: true });
  await fs.mkdir(distInfo, { recursive: true });
  await fs.writeFile(path.join(moduleDir, '__init__.py'), 'VALUE = 1\n');
  await fs.writeFile(path.join(distInfo, 'METADATA'), 'Metadata-Version: 2.1\nName: demo-pkg\nVersion: 1.0\n');
  await fs.writeFile(outside, 'must survive\n');
  await fs.writeFile(path.join(distInfo, 'RECORD'), [
    'demo_pkg/__init__.py,,',
    'demo_pkg-1.0.dist-info/METADATA,,',
    'demo_pkg-1.0.dist-info/RECORD,,',
    '../outside.txt,,',
    '',
  ].join('\n'));

  await removeManagedDistribution(packagesRoot, 'Demo_Pkg');
  await assert.rejects(() => fs.access(path.join(moduleDir, '__init__.py')));
  await assert.rejects(() => fs.access(distInfo));
  assert.equal(await fs.readFile(outside, 'utf8'), 'must survive\n');
});

test('managed uninstall refuses packages absent from the user package layer', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'euler-pip-empty-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(root, { recursive: true });
  await assert.rejects(() => removeManagedDistribution(root, 'numpy'), /not installed in the Workbench user package layer/);
});
