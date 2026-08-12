'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

function validatePackageSpec(value) {
  const spec = String(value || '').trim();
  if (!spec || spec.length > 512 || /[\r\n\0]/.test(spec)) {
    throw new TypeError('Package specification must be a single non-empty line');
  }
  if (spec.startsWith('-')) {
    throw new TypeError('Package specification must not be a pip option');
  }
  return spec;
}

function validatePackageName(value) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new TypeError('Invalid package name');
  }
  return name;
}

function canonicalPackageName(value) {
  return String(value || '').trim().toLowerCase().replace(/[-_.]+/g, '-');
}

function firstCsvField(line) {
  if (!line.startsWith('"')) return line.split(',', 1)[0];
  let result = '';
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === '"') {
      if (line[i + 1] === '"') {
        result += '"';
        i += 1;
      } else {
        break;
      }
    } else {
      result += line[i];
    }
  }
  return result;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function findDistributionInfo(packagesRoot, packageName) {
  const wanted = canonicalPackageName(packageName);
  let entries;
  try { entries = await fs.readdir(packagesRoot, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.dist-info')) continue;
    const metadataPath = path.join(packagesRoot, entry.name, 'METADATA');
    let metadata;
    try { metadata = await fs.readFile(metadataPath, 'utf8'); } catch { continue; }
    const match = /^Name:\s*(.+)$/mi.exec(metadata);
    if (match && canonicalPackageName(match[1]) === wanted) {
      return path.join(packagesRoot, entry.name);
    }
  }
  return null;
}

async function removeManagedDistribution(packagesRoot, packageName) {
  const distInfo = await findDistributionInfo(packagesRoot, packageName);
  if (!distInfo) throw new Error(`${packageName} is not installed in the Workbench user package layer`);
  const recordPath = path.join(distInfo, 'RECORD');
  let record = '';
  try { record = await fs.readFile(recordPath, 'utf8'); } catch { /* fallback removes dist-info only */ }

  const parentDirs = new Set();
  for (const line of record.split(/\r?\n/)) {
    if (!line) continue;
    const relativeFile = firstCsvField(line);
    if (!relativeFile) continue;
    const target = path.resolve(packagesRoot, ...relativeFile.split('/'));
    if (!isInside(packagesRoot, target)) continue;
    try {
      const stat = await fs.lstat(target);
      if (stat.isFile() || stat.isSymbolicLink()) {
        await fs.unlink(target);
        let parent = path.dirname(target);
        while (isInside(packagesRoot, parent) && parent !== packagesRoot) {
          parentDirs.add(parent);
          parent = path.dirname(parent);
        }
      }
    } catch { /* file may already be gone */ }
  }

  await fs.rm(distInfo, { recursive: true, force: true });
  const dirs = [...parentDirs].sort((a, b) => b.length - a.length);
  for (const dir of dirs) {
    try { await fs.rmdir(dir); } catch { /* keep non-empty/shared directories */ }
  }
  return true;
}

function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      ...options,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const limit = 2 * 1024 * 1024;
    child.stdout.on('data', (chunk) => { if (stdout.length < limit) stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { if (stderr.length < limit) stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const result = { code, signal, stdout, stderr };
      if (code === 0) resolve(result);
      else {
        const error = new Error((stderr || stdout || `pip exited with code ${code}`).trim());
        error.result = result;
        reject(error);
      }
    });
  });
}

class ManagedPackageManager {
  constructor({ pythonExecutable, packagesRoot, baseEnv }) {
    this.pythonExecutable = pythonExecutable;
    this.packagesRoot = packagesRoot;
    this.baseEnv = { ...(baseEnv || {}) };
  }

  async ensureRoot() {
    await fs.mkdir(this.packagesRoot, { recursive: true });
  }

  environment() {
    const env = {
      ...this.baseEnv,
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      PIP_NO_INPUT: '1',
    };
    // pip --target/--path operate on packagesRoot explicitly. Do not add that
    // directory to pip's own import path, so user packages cannot shadow pip
    // or bundled runtime modules while package management is running.
    delete env.PYTHONPATH;
    return env;
  }

  async list() {
    await this.ensureRoot();
    const result = await runProcess(this.pythonExecutable, [
      '-m', 'pip', 'list', '--format=json', '--path', this.packagesRoot,
    ], { env: this.environment() });
    const parsed = JSON.parse(result.stdout || '[]');
    return Array.isArray(parsed)
      ? parsed.map((item) => ({ name: String(item.name), version: String(item.version) }))
      : [];
  }

  async install(specification) {
    const spec = validatePackageSpec(specification);
    await this.ensureRoot();
    const result = await runProcess(this.pythonExecutable, [
      '-m', 'pip', 'install', '--upgrade', '--no-warn-script-location',
      '--target', this.packagesRoot, '--', spec,
    ], { env: this.environment() });
    return { specification: spec, output: (result.stdout + result.stderr).trim(), packages: await this.list() };
  }

  async uninstall(packageName) {
    const name = validatePackageName(packageName);
    await this.ensureRoot();
    await removeManagedDistribution(this.packagesRoot, name);
    return {
      name,
      output: `${name} was removed from the Workbench user package layer. Restart the kernel if it was already imported.`,
      packages: await this.list(),
    };
  }
}

module.exports = {
  ManagedPackageManager,
  canonicalPackageName,
  findDistributionInfo,
  firstCsvField,
  isInside,
  removeManagedDistribution,
  runProcess,
  validatePackageName,
  validatePackageSpec,
};