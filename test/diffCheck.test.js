import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  changedLineCoverage,
  changedLineMap,
  cloneViolations,
  coverageResult,
  crapViolations,
  formatRanges,
  mergeBase,
  parseDiffCheckArgs,
  runDiffCheck,
} from '../src/diffCheck.js';

const lines = (...n) => new Set(n);

function stmt(line) {
  return { start: { line, column: 0 }, end: { line, column: 5 } };
}

function fileCov(hitsByLine) {
  const statementMap = {};
  const s = {};
  Object.entries(hitsByLine).forEach(([line, hits], i) => {
    statementMap[i] = stmt(Number(line));
    s[i] = hits;
  });
  return { statementMap, s };
}

test('parseDiffCheckArgs: defaults, flags, repeatable exclude, bad base', () => {
  const d = parseDiffCheckArgs([]);
  assert.equal(d.base, 'origin/develop');
  assert.equal(d.minCoverage, 80);
  assert.equal(d.threshold, 8);
  const o = parseDiffCheckArgs([
    '--base=origin/rc', '--min-coverage', '90', '--threshold=5', '--exclude', 'a/**', '--exclude=b/**',
    '--warn-only', '--github', '--exact-clones', '--no-crap-gate', 'src',
  ]);
  assert.equal(o.base, 'origin/rc');
  assert.equal(o.minCoverage, 90);
  assert.equal(o.threshold, 5);
  assert.deepEqual(o.exclude, ['a/**', 'b/**']);
  assert.deepEqual(o.paths, ['src']);
  assert.ok(o.warnOnly && o.github && o.exactClones && o.noCrap);
  assert.throws(() => parseDiffCheckArgs(['--base', '  ']), /non-empty git ref/);
  assert.throws(() => parseDiffCheckArgs(['--min-coverage', 'x']), /Invalid --min-coverage/);
});

test('changedLineCoverage: counts statements starting on changed lines only', () => {
  const fc = fileCov({ 1: 1, 2: 0, 3: 1, 4: 0, 5: 0 });
  const r = changedLineCoverage(fc, lines(2, 3, 4));
  assert.deepEqual(r, { covered: 1, total: 3, uncovered: [2, 4] });
  assert.deepEqual(changedLineCoverage(fc, lines(9)), { covered: 0, total: 0, uncovered: [] });
  assert.deepEqual(changedLineCoverage({}, lines(1)), { covered: 0, total: 0, uncovered: [] });
});

test('formatRanges: collapses consecutive lines', () => {
  assert.equal(formatRanges([3, 4, 5, 9, 11, 12]), '3-5,9,11-12');
  assert.equal(formatRanges([]), '');
  assert.equal(formatRanges([7]), '7');
});

test('coverageResult: percent over all changed statements, threshold boundary, skipped files', () => {
  const changed = new Map([
    ['src/a.ts', lines(1, 2, 3, 4)],
    ['src/b.ts', lines(1)],
    ['src/types.ts', lines(1)],
  ]);
  const cov = new Map([
    ['src/a.ts', fileCov({ 1: 1, 2: 1, 3: 1, 4: 0 })],
    ['src/b.ts', fileCov({ 1: 1 })],
  ]);
  const ok = coverageResult(changed, cov, 80);
  assert.equal(ok.covered, 4);
  assert.equal(ok.total, 5);
  assert.equal(ok.percent, 80);
  assert.equal(ok.failed, false, 'exactly at the bar passes');
  assert.deepEqual(ok.violations, []);
  assert.deepEqual(ok.skipped, ['src/types.ts']);
  const bad = coverageResult(changed, cov, 81);
  assert.equal(bad.failed, true);
  assert.equal(bad.violations.length, 1);
  assert.match(bad.violations[0].message, /not covered by tests: 4 \(3\/4 statements/);
  assert.equal(bad.violations[0].line, 4);
});

test('coverageResult: nothing executable changed is 100%', () => {
  const r = coverageResult(new Map([['src/a.ts', lines(1)]]), new Map([['src/a.ts', fileCov({})]]), 80);
  assert.equal(r.percent, 100);
  assert.equal(r.failed, false);
});

test('crapViolations: only modified functions over the threshold', () => {
  const m = (name, file, startLine, endLine, crapScore) => ({
    methodName: name, file, startLine, endLine, crapScore, complexity: 9, coverage: 0.5,
  });
  const metrics = [
    m('touchedBad', 'src/a.ts', 10, 20, 30.5),
    m('touchedOk', 'src/a.ts', 30, 40, 8),
    m('untouchedBad', 'src/a.ts', 50, 60, 99),
    m('na', 'src/a.ts', 12, 14, null),
  ];
  const v = crapViolations(metrics, new Map([['src/a.ts', lines(15, 35)]]), 8);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 10);
  assert.match(v[0].message, /touchedBad: CRAP 30\.5 > 8 \(CC 9, coverage 50%\)/);
});

test('cloneViolations: flags changed occurrences and names the other side', () => {
  const clones = [{
    tokens: 60, lines: 7,
    occurrences: [
      { file: 'src/a.ts', startLine: 10, endLine: 16 },
      { file: 'src/b.ts', startLine: 5, endLine: 11 },
      { file: 'src/c.ts', startLine: 1, endLine: 7 },
      { file: 'src/d.ts', startLine: 1, endLine: 7 },
      { file: 'src/e.ts', startLine: 1, endLine: 7 },
    ],
  }];
  const none = cloneViolations(clones, new Map([['src/a.ts', lines(1, 2)]]));
  assert.deepEqual(none, [], 'touching other lines of the file is fine');
  const v = cloneViolations(clones, new Map([['src/a.ts', lines(12)]]));
  assert.equal(v.length, 1);
  assert.equal(v[0].file, 'src/a.ts');
  assert.match(v[0].message, /60 tokens \/ 7 lines\) also at src\/b\.ts:5-11; src\/c\.ts:1-7; src\/d\.ts:1-7 \(\+1 more\)/);
});

test('mergeBase / changedLineMap: git argv and failure hints', () => {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status: 0, stdout: 'abc123\n', stderr: '' };
  };
  assert.equal(mergeBase('origin/develop', '/x', spawn), 'abc123');
  assert.deepEqual(calls[0], ['git', 'merge-base', 'origin/develop', 'HEAD']);
  const fail = () => ({ status: 1, stdout: '', stderr: 'fatal: bad ref' });
  assert.throws(() => mergeBase('nope', '/x', fail), /bad ref[\s\S]*fetch-depth: 0/);
  assert.throws(() => mergeBase('x', '/x', () => ({ error: new Error('ENOENT'), status: null })), /ENOENT/);
});

// ── end-to-end on a real git repository ────────────────────────────────

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-diffcheck-'));
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 't@t');
  sh(root, 'config', 'user.name', 't');
  write(root, 'src/old.js', 'export function old(a) {\n  return a + 1;\n}\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'base');
  sh(root, 'checkout', '-q', '-b', 'feature');
  return root;
}

function coverageJson(root, rel, hitsByLine) {
  const fc = fileCov(hitsByLine);
  write(root, 'coverage/coverage-final.json', JSON.stringify({ [path.join(root, rel)]: fc }));
}

function run(root, flags) {
  const out = [];
  const code = runDiffCheck(['--base', 'main', ...flags], { cwd: root, out: { write: (s) => out.push(s) } });
  return { code, text: out.join('') };
}

// CC 6 (five branches): CRAP 6 at full coverage, 36 at none. Every line is distinct so the
// fixture is not a clone of itself.
const complexFn = (name) => `export function ${name}(a, b) {
  if (a > 1) { return b * 2; }
  if (a < -3) { return b - 7; }
  if (b === 4) { return a + 11; }
  if (a % 5 === 0) { return Math.max(a, b); }
  if (b > a) { return [a, b].join('-'); }
  return a;
}
`;

test('runDiffCheck e2e: no changes passes; uncovered complex change fails; covered passes', () => {
  const root = repo();
  try {
    const none = run(root, []);
    assert.equal(none.code, 0);
    assert.match(none.text, /no changed source lines/);

    write(root, 'src/new.js', complexFn('branchy'));
    coverageJson(root, 'src/new.js', { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 });
    const bad = run(root, ['--no-duplicates-gate']);
    assert.equal(bad.code, 2);
    assert.match(bad.text, /\[coverage\] src\/new\.js:2: changed lines not covered/);
    assert.match(bad.text, /\[crap\] src\/new\.js:1: branchy: CRAP/);
    assert.match(bad.text, /changed-lines coverage 0\.0% \(0\/6, need >= 80%\)/);

    const warn = run(root, ['--no-duplicates-gate', '--warn-only']);
    assert.equal(warn.code, 0, 'warn-only reports but passes');
    assert.match(warn.text, /\[crap\]/);

    coverageJson(root, 'src/new.js', { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 });
    const good = run(root, ['--no-duplicates-gate']);
    assert.equal(good.code, 0, good.text);
    assert.match(good.text, /100\.0%/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runDiffCheck e2e: legacy untouched code is ignored, committed + staged changes count', () => {
  const root = repo();
  try {
    write(root, 'src/legacy.js', complexFn('legacyBad'));
    sh(root, 'add', '-A');
    sh(root, 'commit', '-q', '-m', 'legacy on feature');
    // Compare against the feature's own base: legacy is part of the diff here, so branch again.
    sh(root, 'branch', '-f', 'main', 'HEAD');
    coverageJson(root, 'src/legacy.js', { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 });
    write(root, 'src/small.js', 'export const x = 1;\nexport function f() {\n  return x;\n}\n');
    const r = run(root, ['--no-duplicates-gate', '--no-coverage-gate']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /1 changed source files/);
    assert.match(r.text, /0 functions over CRAP/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runDiffCheck e2e: duplication touching changed lines is flagged with the other side', () => {
  const root = repo();
  try {
    write(root, 'src/orig.js', complexFn('first'));
    sh(root, 'add', '-A');
    sh(root, 'commit', '-q', '-m', 'orig');
    sh(root, 'branch', '-f', 'main', 'HEAD');
    write(root, 'src/copy.js', complexFn('second'));
    const r = run(root, ['--no-coverage-gate', '--no-crap-gate']);
    assert.equal(r.code, 2, r.text);
    assert.match(r.text, /\[duplication\] src\/copy\.js:\d+: duplicated code \(\d+ tokens \/ \d+ lines\) also at src\/orig\.js:/);
    const clean = run(root, ['--no-coverage-gate', '--no-crap-gate', '--exclude', 'src/copy.js']);
    assert.equal(clean.code, 0, 'excluded paths are not scanned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runDiffCheck e2e: fails closed on missing coverage and unknown base', () => {
  const root = repo();
  try {
    write(root, 'src/new.js', 'export const y = 2;\n');
    assert.throws(() => run(root, []), /coverage file not found/);
    assert.throws(
      () => runDiffCheck(['--base', 'does-not-exist'], { cwd: root, out: { write() {} } }),
      /merge-base does-not-exist HEAD failed[\s\S]*fetch-depth: 0/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runDiffCheck: --help prints usage and exits 0; unknown flag throws usage error (Issue #5)', () => {
  const root = repo();
  try {
    const out = [];
    const code = runDiffCheck(['--help'], { cwd: root, out: { write: (s) => out.push(s) } });
    assert.equal(code, 0);
    assert.match(out.join(''), /Usage: crap4js diff-check/);
    assert.throws(() => parseDiffCheckArgs(['--treshold', '8']), /unknown flag: --treshold/);
    assert.throws(() => parseDiffCheckArgs(['--metric', 'invalid']), /Invalid --metric/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runDiffCheck e2e: --metric cognitive, --explain, --github, and ignore markers (Issues #2, #3, #4)', () => {
  const root = repo();
  try {
    write(root, 'src/cog.js', complexFn('cogFn'));
    coverageJson(root, 'src/cog.js', { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 });
    const r = run(root, ['--no-duplicates-gate', '--no-coverage-gate', '--metric', 'cognitive', '--explain', '--github']);
    assert.equal(r.code, 2);
    assert.match(r.text, /\[crap\] src\/cog\.js:1: cogFn: CRAP 30\.0 > 8 \(cognitive 5, coverage 0%\)/);
    assert.match(r.text, /::error file=src\/cog\.js,line=1,title=crap::/);
    assert.match(r.text, /src\/cog\.js:1 cogFn cognitive=5/);
    assert.match(r.text, /\+1 :2 if/);

    // Suppress via // ignore-file:crap
    write(root, 'src/cog.js', '// ignore-file:crap\n' + complexFn('cogFn'));
    const suppressed = run(root, ['--no-duplicates-gate', '--no-coverage-gate', '--metric', 'cognitive']);
    assert.equal(suppressed.code, 0, suppressed.text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runDiffCheck e2e: --exclude-duplicates, --ignore-data, and --new-duplicates-only (Issue #3)', () => {
  const root = repo();
  try {
    // Commit pre-existing duplicate at base (`main`)
    write(root, 'src/dupA.js', complexFn('dupOne'));
    write(root, 'src/dupB.js', complexFn('dupTwo'));
    sh(root, 'add', '-A');
    sh(root, 'commit', '-q', '-m', 'pre-existing duplicate');
    sh(root, 'branch', '-f', 'main', 'HEAD');

    // Touch a line INSIDE dupOne without changing its normalized clone structure (literal masked)
    write(root, 'src/dupA.js', complexFn('dupOne').replace('return b * 2;', 'return b * 3;'));
    const strictRes = run(root, ['--no-coverage-gate', '--no-crap-gate']);
    assert.equal(strictRes.code, 2, 'strict default flags touched pre-existing duplicate');

    const newOnlyRes = run(root, ['--no-coverage-gate', '--no-crap-gate', '--new-duplicates-only']);
    assert.equal(newOnlyRes.code, 0, 'new-duplicates-only ignores pre-existing duplicate from base');

    const exclDupRes = run(root, ['--no-coverage-gate', '--no-crap-gate', '--exclude-duplicates', 'src/dupA.js']);
    assert.equal(exclDupRes.code, 0, 'exclude-duplicates skips file from duplication gate');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runDiffCheck e2e: diff-scoped method-size, loc, and component-size gates (Issues #1, #6)', () => {
  const root = repo();
  try {
    const bigComponent = [
      'export function HugeCard(a, b, c, d, e, f, g) {',
      '  const h1 = () => (a ? 1 : 0);',
      '  const h2 = () => (b ? 1 : 0);',
      '  return <div>{h1() + h2()}</div>;',
      '}',
    ].join('\n') + '\n';
    write(root, 'src/HugeCard.tsx', bigComponent);
    const r = run(root, [
      '--no-coverage-gate',
      '--no-crap-gate',
      '--no-duplicates-gate',
      '--max-params', '4',
      '--max-lines', '3',
      '--max-callbacks', '1',
    ]);
    assert.equal(r.code, 2);
    assert.match(r.text, /\[method-size\] src\/HugeCard\.tsx:1: HugeCard has 7 params > max 4/);
    assert.match(r.text, /\[loc\] src\/HugeCard\.tsx:1: 5 lines > max 3/);
    assert.match(r.text, /\[component-size\] src\/HugeCard\.tsx:1: HugeCard has 2 callbacks\/hooks > max 1/);

    // Disable the new gates with --no-*-gate flags
    const off = run(root, [
      '--no-coverage-gate',
      '--no-crap-gate',
      '--no-duplicates-gate',
      '--no-method-size-gate',
      '--no-loc-gate',
      '--no-component-size-gate',
      '--max-params', '4',
      '--max-lines', '3',
      '--max-callbacks', '1',
    ]);
    assert.equal(off.code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

