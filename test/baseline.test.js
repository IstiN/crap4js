import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildBaseline, compareBaseline, keyMetrics, formatComparison, ratchetDown } from '../src/baseline.js';
import { main } from '../src/cli.js';

const m = (file, methodName, startLine, crapScore) => ({ file, methodName, startLine, crapScore });

test('keyMetrics disambiguates repeated names by source order', () => {
  const keys = keyMetrics([m('a.js', 'f', 20, 1), m('a.js', 'f', 5, 2), m('b.js', 'f', 1, 3)]).map((x) => x.key);
  assert.deepEqual(keys, ['a.js::f', 'a.js::f#2', 'b.js::f']);
});

test('buildBaseline skips N/A scores and records the max', () => {
  const b = buildBaseline([m('a.js', 'f', 1, 12.34), m('a.js', 'g', 9, null), m('b.js', 'h', 1, 3)]);
  assert.deepEqual(b.functions, { 'a.js::f': 12.3, 'b.js::h': 3 });
  assert.equal(b.maxCrap, 12.3);
});

test('buildBaseline with a threshold records only functions above it (compliant ones are held by the threshold)', () => {
  const b = buildBaseline([m('a.js', 'big', 1, 30), m('a.js', 'edge', 9, 8), m('a.js', 'small', 20, 2)], 8);
  assert.deepEqual(b.functions, { 'a.js::big': 30 });
  assert.equal(b.maxCrap, 30);
  const r = compareBaseline([m('a.js', 'big', 1, 30), m('a.js', 'small', 20, 7), m('a.js', 'grown', 30, 9)], b, 8);
  assert.deepEqual(r.newOverThreshold, [{ key: 'a.js::grown', score: 9 }]);
  assert.equal(r.regressions.length, 0);
});

test('compareBaseline flags growth, new-over-threshold, improvements and removals', () => {
  const baseline = { functions: { 'a.js::f': 10, 'a.js::g': 50, 'a.js::gone': 4 } };
  const r = compareBaseline([m('a.js', 'f', 1, 12), m('a.js', 'g', 9, 40), m('a.js', 'n', 20, 9), m('a.js', 'ok', 30, 2)], baseline, 8);
  assert.deepEqual(r.regressions, [{ key: 'a.js::f', before: 10, score: 12 }]);
  assert.deepEqual(r.newOverThreshold, [{ key: 'a.js::n', score: 9 }]);
  assert.deepEqual(r.improvements, [{ key: 'a.js::g', before: 50, score: 40 }]);
  assert.deepEqual(r.removed, ['a.js::gone']);
  assert.match(formatComparison(r, 8), /1 regression\(s\), 1 new over threshold/);
});

test('compareBaseline ignores float noise within epsilon', () => {
  const r = compareBaseline([m('a.js', 'f', 1, 10.4)], { functions: { 'a.js::f': 10 } }, 8);
  assert.equal(r.regressions.length, 0);
  assert.equal(r.improvements.length, 0);
});

// Zero-hit coverage for line 1 so f gets a numeric CRAP (CC^2 + CC at 0%).
function writeCoverage(dir) {
  const file = path.join(dir, 'src', 'a.js');
  mkdirSync(path.join(dir, 'coverage'), { recursive: true });
  writeFileSync(path.join(dir, 'coverage', 'coverage-final.json'), JSON.stringify({
    [file]: { path: file, statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } } }, s: { 0: 0 } },
  }));
}

function project(src) {
  const dir = mkdtempSync(path.join(tmpdir(), 'crap-baseline-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'a.js'), src);
  writeCoverage(dir);
  return dir;
}

const sink = () => { let s = ''; return { write: (x) => { s += x; }, get text() { return s; } }; };
const SIMPLE = 'export function f(x) { return x + 1; }\n';
const BRANCHY = 'export function f(x) { if (x) { if (x > 1) { return 1; } return 2; } return 3; }\n';

test('cli: --write-baseline records, unchanged code passes, worse code fails with 2', () => {
  const dir = project(SIMPLE);
  const out = sink();
  // threshold 0 => every function is recorded (full ratchet); the default threshold would skip the compliant f
  assert.equal(main(['--baseline', 'crap-baseline.json', '--write-baseline', '--threshold', '0'], { cwd: dir, out, err: sink() }), 0);
  const doc = JSON.parse(readFileSync(path.join(dir, 'crap-baseline.json'), 'utf8'));
  assert.ok('src/a.js::f' in doc.functions);
  assert.equal(main(['--baseline', 'crap-baseline.json', '--threshold', '0'], { cwd: dir, out: sink(), err: sink() }), 0);
  writeFileSync(path.join(dir, 'src', 'a.js'), BRANCHY);
  const err = sink();
  assert.equal(main(['--baseline', 'crap-baseline.json', '--threshold', '0'], { cwd: dir, out: sink(), err }), 2);
  assert.match(err.text, /may only decrease/);
});

test('cli: --write-baseline without --baseline is a usage error', () => {
  assert.equal(main(['--write-baseline'], { cwd: project(SIMPLE), out: sink(), err: sink() }), 1);
});

test('cli entrypoint delivers the full report and the ratchet verdict through a pipe', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = project(SIMPLE);
  const many = Array.from({ length: 3000 }, (_, i) => `export function fn${i}(x) { return x + ${i}; }\n`).join('');
  writeFileSync(path.join(dir, 'src', 'a.js'), many);
  const cli = path.resolve('src/cli.js');
  const write = spawnSync(process.execPath, [cli, '--baseline', 'b.json', '--write-baseline'], { cwd: dir, encoding: 'utf8' });
  assert.equal(write.status, 0);
  // `| cat` forces a pipe — the case where process.exit() used to drop buffered stdout
  const r = spawnSync('sh', ['-c', `"${process.execPath}" "${cli}" --baseline b.json | cat`], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.match(r.stdout, /CRAP Ratchet/);
  assert.match(r.stdout, /0 regression\(s\)/);
});

test('ratchetDown keeps min(old, now), drops fixed/removed functions and never adds', () => {
  const baseline = { version: 1, maxCrap: 50, functions: { 'a.js::big': 50, 'a.js::mid': 20, 'a.js::fixed': 12, 'a.js::gone': 9 } };
  const r = ratchetDown([m('a.js', 'big', 1, 40), m('a.js', 'mid', 5, 20.3), m('a.js', 'fixed', 9, 3), m('a.js', 'ok', 30, 2)], baseline, 8);
  assert.equal(r.blocked, false);
  assert.deepEqual(r.doc.functions, { 'a.js::big': 40, 'a.js::mid': 20 });
  assert.equal(r.doc.maxCrap, 40);
  assert.equal(r.changed, true);
});

test('ratchetDown is blocked by a regression or a new function over the threshold', () => {
  const baseline = { version: 1, maxCrap: 20, functions: { 'a.js::f': 20 } };
  assert.equal(ratchetDown([m('a.js', 'f', 1, 25)], baseline, 8).blocked, true);
  assert.equal(ratchetDown([m('a.js', 'f', 1, 20), m('a.js', 'n', 9, 12)], baseline, 8).blocked, true);
  const same = ratchetDown([m('a.js', 'f', 1, 20)], baseline, 8);
  assert.equal(same.blocked, false);
  assert.equal(same.changed, false);
});

test('cli --update-baseline lowers the file after an improvement and refuses after a regression', () => {
  const dir = project(BRANCHY);
  assert.equal(main(['--baseline', 'b.json', '--write-baseline', '--threshold', '0'], { cwd: dir, out: sink(), err: sink() }), 0);
  const before = JSON.parse(readFileSync(path.join(dir, 'b.json'), 'utf8'));
  writeFileSync(path.join(dir, 'src', 'a.js'), SIMPLE);
  const out = sink();
  assert.equal(main(['--baseline', 'b.json', '--update-baseline', '--threshold', '0'], { cwd: dir, out, err: sink() }), 0);
  const after = JSON.parse(readFileSync(path.join(dir, 'b.json'), 'utf8'));
  assert.ok(after.functions['src/a.js::f'] < before.functions['src/a.js::f']);
  assert.match(out.text, /Baseline updated/);
  writeFileSync(path.join(dir, 'src', 'a.js'), BRANCHY);
  const err = sink();
  assert.equal(main(['--baseline', 'b.json', '--update-baseline', '--threshold', '0'], { cwd: dir, out: sink(), err }), 2);
  assert.match(err.text, /NOT updated/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'b.json'), 'utf8')), after);
});

test('cli: --update-baseline needs --baseline and excludes --write-baseline', () => {
  assert.equal(main(['--update-baseline'], { cwd: project(SIMPLE), out: sink(), err: sink() }), 1);
  assert.equal(main(['--baseline', 'b.json', '--update-baseline', '--write-baseline'], { cwd: project(SIMPLE), out: sink(), err: sink() }), 1);
});
