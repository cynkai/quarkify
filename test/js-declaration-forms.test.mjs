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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-js-forms-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runOn(workspace, fileName, source, extraArgs = []) {
  const srcDir = path.join(workspace, 'src');
  const outDir = path.join(workspace, 'out');
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, fileName), source, 'utf8');

  const configPath = path.join(workspace, 'config.json');
  await writeFile(configPath, JSON.stringify({
    name: 'js-forms-check',
    srcDir,
    outDir,
    sourceFiles: [fileName],
    perfData: {},
  }), 'utf8');

  const result = spawnSync(process.execPath, [cliPath, ...extraArgs, configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { result, fileQuark: path.join(outDir, 'quark', `file__${fileName}`) };
}

test('export default functions and classes are materialized', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOn(workspace, 'delay.ts', [
      'export default async function delay(ms: number): Promise<void> {',
      '  await sleep(ms);',
      '}',
      '',
      'export default class Client {',
      '  run() {}',
      '}',
      '',
      'export abstract class Base {',
      '  abstract go(): void;',
      '}',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1\/1 \(100\.0%\)/);
    assert.deepEqual((await readdir(fileQuark)).sort(), ['class__Base', 'class__Client', 'fn__delay']);
  });
});

// Neither the parser nor the audit's scan knew `function*`, so a generator
// vanished without a warning.
test('generator functions are materialized and counted', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOn(workspace, 'ids.js', [
      'export function* ids() {',
      '  yield 1;',
      '}',
      '',
      'async function *pages() {',
      '  yield 2;',
      '}',
      '',
      'const v = functionLike(1);',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    // `functionLike(` is a call, not a function named `Like`.
    assert.match(result.stdout, /2\/2 \(100\.0%\)/);
    assert.deepEqual((await readdir(fileQuark)).sort(), ['fn__ids', 'fn__pages']);
  });
});

// Most of express's public API is written this way; the audit saw 51%.
test('functions assigned to properties are materialized', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOn(workspace, 'response.js', [
      'exports.compileQueryParser = function compileQueryParser(val) {',
      '  return val;',
      '};',
      '',
      'res.status = function status(code) {',
      '  return this;',
      '};',
      '',
      'View.prototype.lookup = function lookup(name) {',
      '  return name;',
      '};',
      '',
      'req.get = req.header = function header(name) {',
      '  return name;',
      '};',
      '',
      'module.exports = function createApplication() {',
      '  return app;',
      '};',
      '',
      'exports.anonymous = function (x) {',
      '  return x;',
      '};',
      '',
      'utils.toArray = (value) => {',
      '  return [value];',
      '};',
      '',
      'app.settings = { env: "dev" };',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /5\/5 \(100\.0%\)/);
    assert.deepEqual((await readdir(fileQuark)).sort(), [
      'fn__anonymous', 'fn__compileQueryParser', 'fn__createApplication',
      'fn__header', 'fn__lookup', 'fn__status', 'fn__toArray',
    ]);
  });
});

test('typed, generic and multi-line arrow functions are materialized', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOn(workspace, 'arrows.ts', [
      'export const typed = async (a: string): Promise<void> => {',
      '  await use(a);',
      '};',
      '',
      'export const generic = <T,>(x: T): T => {',
      '  return x;',
      '};',
      '',
      'export const multiLine = async (',
      '  first: string,',
      '  second: number,',
      '): Promise<string> => {',
      '  return first;',
      '};',
      '',
      'const handler: Handler = (req) => {',
      '  return req;',
      '};',
      '',
      '// Not functions: a computed value and an immediately invoked arrow.',
      'const total = (a + b) * c;',
      'const supported = (() => {',
      '  return true;',
      '})();',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readdir(fileQuark)).sort(), ['fn__generic', 'fn__handler', 'fn__multiLine', 'fn__typed']);
  });
});
