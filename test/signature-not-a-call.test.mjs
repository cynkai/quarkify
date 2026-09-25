import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'quarkify.mjs');

async function withTempWorkspace(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-self-call-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runOnSource(workspace, fileName, source) {
  const srcDir = path.join(workspace, 'src');
  const outDir = path.join(workspace, 'out');
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, fileName), source, 'utf8');

  const configPath = path.join(workspace, 'config.json');
  await writeFile(configPath, JSON.stringify({
    name: 'self-call-check',
    srcDir,
    outDir,
    sourceFiles: [fileName],
    perfData: {},
  }), 'utf8');

  const result = spawnSync(process.execPath, [cliPath, configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { result, fileQuark: path.join(outDir, 'quark', `file__${fileName}`) };
}

async function listRelativeEntries(root) {
  const found = [];
  const walk = async (dir, prefix) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      found.push(rel);
      await walk(path.join(dir, entry.name), rel);
    }
  };
  await walk(root, '');
  return found;
}

// The AI context guide finds callers with `fd call__NAME`. When the signature
// was split as a statement, every definition answered that search too.
const callsUnder = (entries, fnFolder) => entries
  .filter((e) => e.startsWith(`${fnFolder}/`) && /\/call__[^/]+$/.test(e))
  .map((e) => e.slice(e.lastIndexOf('/call__') + '/call__'.length));

test('a C function does not list itself as a call', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnSource(workspace, 'sample.cpp', [
      'int add(int a, int b) {',
      '    return a + b;',
      '}',
      '',
      'int twice(int x) {',
      '    return add(x, x);',
      '}',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.deepEqual(callsUnder(entries, 'fn__add'), [], entries.join('\n'));
    assert.deepEqual(callsUnder(entries, 'fn__twice'), ['add'], entries.join('\n'));
  });
});

test('a JS function does not list itself as a call, but recursion still shows', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnSource(workspace, 'sample.js', [
      'function first() { return 1; }',
      '',
      'function fact(n) {',
      '  return n ? n * fact(n - 1) : 1;',
      '}',
      '',
      // Braces in the parameter list are not the body.
      'function pick({ a } = {}) {',
      '  return lookup(a);',
      '}',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    const listing = entries.join('\n');
    assert.deepEqual(callsUnder(entries, 'fn__first'), [], listing);
    assert.deepEqual(callsUnder(entries, 'fn__fact'), ['fact'], listing);
    assert.deepEqual(callsUnder(entries, 'fn__pick'), ['lookup'], listing);
  });
});

// Without a brace body there is no signature/body split to make, so the
// expression is handled exactly as before.
test('an expression-bodied arrow function keeps its calls', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnSource(workspace, 'sample.js', [
      'const double = (x) => twice(x);',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.deepEqual(callsUnder(entries, 'fn__double'), ['twice'], entries.join('\n'));
  });
});
