import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  isGateEnabled,
  loadConfig,
  parseOverrideSpec,
  resolvePathConfig,
} from '../src/config.js';
import { main } from '../src/cli.js';
import { runLoc } from '../src/loc.js';
import { runMethodSize } from '../src/methodSize.js';
import { runComplexity } from '../src/complexity.js';

function fakeCtx(cwd) {
  const out = [];
  const err = [];
  return {
    cwd,
    out: { write: (s) => out.push(s) },
    err: { write: (s) => err.push(s) },
    lines: out,
    errors: err,
  };
}

function makeTempDir() {
  return mkdtempSync(path.join(tmpdir(), 'crap4js-config-'));
}

test('parseOverrideSpec parses glob, numeric keys, metric, and gate toggles', () => {
  const r = parseOverrideSpec('**/*.tsx:threshold=15,metric=cognitive,maxLines=800,gates.crap=false,gates.duplicates=true');
  assert.deepEqual(r.files, ['**/*.tsx']);
  assert.equal(r.threshold, 15);
  assert.equal(r.metric, 'cognitive');
  assert.equal(r.maxLines, 800);
  assert.deepEqual(r.gates, { crap: false, duplicates: true });

  assert.throws(() => parseOverrideSpec('no-colon'), /Invalid --override/);
  assert.throws(() => parseOverrideSpec(':threshold=10'), /Invalid --override/);
  assert.throws(() => parseOverrideSpec('**/*.ts:badpair'), /Invalid --override/);
  assert.throws(() => parseOverrideSpec('**/*.ts:metric=sonar'), /Invalid metric in --override/);
  assert.throws(() => parseOverrideSpec('**/*.ts:threshold=-1'), /Invalid threshold in --override/);
  assert.throws(() => parseOverrideSpec('**/*.ts:unknownKey=5'), /Unknown key in --override/);
  assert.throws(() => parseOverrideSpec('**/*.ts:gates.unknown=false'), /Invalid gate toggle/);
  assert.throws(() => parseOverrideSpec('**/*.ts:gates.crap=maybe'), /Invalid gate toggle/);
});

test('loadConfig reads crap4js.config.json, package.json#crap4js, or --config, and applies ESLint-style last-match-wins', () => {
  const dir = makeTempDir();
  try {
    // 1. package.json#crap4js fallback
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'demo',
        crap4js: {
          threshold: 10,
          metric: 'cyclomatic',
          overrides: [
            { files: ['**/*.tsx'], metric: 'cognitive', threshold: 15 },
            { files: ['**/i18n/**'], gates: { crap: false, duplicates: false } },
          ],
        },
      }),
    );
    const pkgCfg = loadConfig(dir, { overrides: ['src/special.tsx:threshold=20'] });
    const tsResolved = resolvePathConfig(pkgCfg, 'src/helper.ts', { threshold: 8, metric: 'cyclomatic' });
    assert.equal(tsResolved.threshold, 10);
    assert.equal(tsResolved.metric, 'cyclomatic');

    const tsxResolved = resolvePathConfig(pkgCfg, 'src/View.tsx', { threshold: 8, metric: 'cyclomatic' });
    assert.equal(tsxResolved.threshold, 15);
    assert.equal(tsxResolved.metric, 'cognitive');

    // Last match wins: CLI override after package.json override
    const specialResolved = resolvePathConfig(pkgCfg, 'src/special.tsx', { threshold: 8, metric: 'cyclomatic' });
    assert.equal(specialResolved.threshold, 20);
    assert.equal(specialResolved.metric, 'cognitive');

    assert.equal(isGateEnabled(pkgCfg, 'src/i18n/en.ts', 'crap'), false);
    assert.equal(isGateEnabled(pkgCfg, 'src/i18n/en.ts', 'duplicates'), false);
    assert.equal(isGateEnabled(pkgCfg, 'src/i18n/en.ts', 'coverage'), true);

    // 2. crap4js.config.json takes precedence over package.json
    writeFileSync(
      path.join(dir, 'crap4js.config.json'),
      JSON.stringify({
        threshold: 6,
        gates: { 'method-size': false },
        overrides: [{ files: 'src/gen/**', gates: { coverage: false } }],
      }),
    );
    const fileCfg = loadConfig(dir);
    assert.equal(resolvePathConfig(fileCfg, 'src/a.ts').threshold, 6);
    assert.equal(isGateEnabled(fileCfg, 'src/a.ts', 'method-size'), false);
    assert.equal(isGateEnabled(fileCfg, 'src/gen/x.ts', 'coverage'), false);

    // 3. Explicit --config path and error handling
    const customPath = path.join(dir, 'custom.json');
    writeFileSync(customPath, '{ invalid json ');
    assert.throws(() => loadConfig(dir, { configPath: 'custom.json' }), /failed to parse custom\.json/);
    assert.throws(() => loadConfig(dir, { configPath: 'missing.json' }), /config file not found: missing\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('per-path overrides work across main CRAP command, loc, method-size, and complexity', () => {
  const dir = makeTempDir();
  try {
    mkdirSync(path.join(dir, 'src/i18n'), { recursive: true });
    mkdirSync(path.join(dir, 'coverage'), { recursive: true });
    const logicFile = path.join(dir, 'src/logic.ts');
    const i18nFile = path.join(dir, 'src/i18n/en.ts');
    // CC=4, uncovered -> CRAP = 4^2 + 4 = 20
    writeFileSync(
      logicFile,
      'export function calc(a: number, b: number, c: number) {\n  if (a && b) return 1;\n  return c ? 2 : 3;\n}\n',
    );
    writeFileSync(
      i18nFile,
      'export function translate(a: number, b: number, c: number) {\n  if (a && b) return 1;\n  return c ? 2 : 3;\n}\n',
    );
    writeFileSync(
      path.join(dir, 'coverage/coverage-final.json'),
      JSON.stringify({
        [logicFile]: {
          path: logicFile,
          statementMap: { 0: { start: { line: 2, column: 0 }, end: { line: 3, column: 20 } } },
          s: { 0: 0 },
        },
        [i18nFile]: {
          path: i18nFile,
          statementMap: { 0: { start: { line: 2, column: 0 }, end: { line: 3, column: 20 } } },
          s: { 0: 0 },
        },
      }),
    );

    // Without overrides: fails with exit 2
    assert.equal(main([], fakeCtx(dir)), 2);

    // With overrides raising threshold on logic.ts to 25 and disabling crap on i18n: passes with exit 0!
    const passCtx = fakeCtx(dir);
    assert.equal(
      main(
        [
          '--override',
          'src/logic.ts:threshold=25',
          '--override',
          '**/i18n/**:gates.crap=false',
        ],
        passCtx,
      ),
      0,
      passCtx.errors.join(''),
    );
    assert.ok(!passCtx.lines.join('').includes('translate'), 'i18n file skipped by gates.crap=false');

    // loc gate with per-path maxLines override
    assert.equal(runLoc(['--max-lines', '2'], fakeCtx(dir)), 2);
    assert.equal(
      runLoc(['--max-lines', '2', '--override', 'src/**/*.ts:maxLines=10'], fakeCtx(dir)),
      0,
    );

    // method-size gate with per-path maxParams override
    assert.equal(runMethodSize(['--max-params', '2'], fakeCtx(dir)), 2);
    assert.equal(
      runMethodSize(['--max-params', '2', '--override', 'src/**/*.ts:maxParams=5'], fakeCtx(dir)),
      0,
    );

    // complexity gate with per-path threshold/metric override
    assert.equal(runComplexity(['--max', '2'], fakeCtx(dir)), 2);
    assert.equal(
      runComplexity(['--max', '2', '--override', 'src/**/*.ts:threshold=5'], fakeCtx(dir)),
      0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
