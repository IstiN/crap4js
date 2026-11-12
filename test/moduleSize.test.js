import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  buildModuleBaseline,
  judgeModule,
  measureModule,
  moduleSizeViolations,
  parseModuleSizeArgs,
  runModuleSize,
} from '../src/moduleSize.js';
import { main } from '../src/cli.js';

function fakeCtx(cwd) {
  const out = [];
  const err = [];
  return { cwd, out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) }, lines: out, errors: err };
}

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-modsize-'));
  mkdirSync(path.join(root, 'src'));
  for (const [name, source] of Object.entries(files)) writeFileSync(path.join(root, 'src', name), source);
  return root;
}

const fns = (n) => Array.from({ length: n }, (_, i) => `function f${i}() { return ${i}; }`).join('\n') + '\n';

test('measureModule counts lines and top-level functions only', () => {
  const src = [
    'function a() { function nested() {} return nested; }',
    'export function b() {}',
    'export default function () {}',
    'const c = () => 1, d = 2, e = function () {};',
    'var obj = { m() {} };',
    'class K { x() {} }',
  ].join('\n') + '\n';
  assert.deepEqual(measureModule(src, '.js'), { lines: 6, functions: 5 });
});

test('judgeModule: limits, pins and improvements', () => {
  const lim = { maxLines: 10, maxFunctions: 2 };
  assert.deepEqual(judgeModule({ lines: 10, functions: 2 }, undefined, lim), {});
  assert.match(judgeModule({ lines: 11, functions: 2 }, undefined, lim).violation, /11 lines > max 10/);
  assert.match(judgeModule({ lines: 5, functions: 3 }, undefined, lim).violation, /3 top-level functions > max 2/);
  const pin = { lines: 20, functions: 5 };
  assert.deepEqual(judgeModule({ lines: 20, functions: 5 }, pin, lim), {});
  assert.match(judgeModule({ lines: 21, functions: 5 }, pin, lim).violation, /grew above pin: 21 lines > max 20/);
  assert.match(judgeModule({ lines: 20, functions: 6 }, pin, lim).violation, /6 top-level functions > max 5/);
  assert.match(judgeModule({ lines: 19, functions: 5 }, pin, lim).improved, /19\/5 below pin 20\/5/);
});

test('moduleSizeViolations / buildModuleBaseline', () => {
  const sizes = new Map([['a.js', { lines: 900, functions: 1 }], ['b.js', { lines: 1, functions: 1 }]]);
  const lim = { maxLines: 800, maxFunctions: 40 };
  const improved = [];
  const r = moduleSizeViolations(sizes, { ...lim, pins: {}, onImproved: (f) => improved.push(f) });
  assert.equal(r.checked, 2);
  assert.deepEqual(r.violations.map((v) => v.file), ['a.js']);
  const doc = buildModuleBaseline(sizes, lim);
  assert.deepEqual(doc.modules, { 'a.js': { lines: 900, functions: 1 } });
  const r2 = moduleSizeViolations(new Map([['a.js', { lines: 850, functions: 1 }]]), { ...lim, pins: doc.modules, onImproved: (f) => improved.push(f) });
  assert.equal(r2.violations.length, 0);
  assert.deepEqual(improved, ['a.js']);
});

test('parseModuleSizeArgs validates flags', () => {
  assert.deepEqual(parseModuleSizeArgs(['--max-lines', '5', '--max-functions=3', 'src']), {
    maxLines: 5, maxFunctions: 3, exclude: [], baseline: undefined, writeBaseline: false, paths: ['src'],
  });
  assert.throws(() => parseModuleSizeArgs(['--write-baseline']), /requires --baseline/);
  assert.throws(() => parseModuleSizeArgs(['--bogus']), /unknown flag/);
});

test('runModuleSize: write baseline, ratchet pass, growth fails, exclude', () => {
  const root = fixture({ 'big.js': fns(3), 'ok.js': fns(1) });
  try {
    let ctx = fakeCtx(root);
    assert.equal(runModuleSize(['--max-functions', '2'], ctx), 2);
    assert.match(ctx.lines.join(''), /src\/big\.js: 3 top-level functions > max 2/);
    ctx = fakeCtx(root);
    assert.equal(runModuleSize(['--max-functions', '2', '--exclude', 'src/big.js'], ctx), 0);
    ctx = fakeCtx(root);
    assert.equal(runModuleSize(['--max-functions', '2', '--baseline', 'mb.json', '--write-baseline'], ctx), 0);
    const doc = JSON.parse(readFileSync(path.join(root, 'mb.json'), 'utf8'));
    assert.deepEqual(doc.modules, { 'src/big.js': { lines: 3, functions: 3 } });
    ctx = fakeCtx(root);
    assert.equal(runModuleSize(['--max-functions', '2', '--baseline', 'mb.json'], ctx), 0);
    writeFileSync(path.join(root, 'src', 'big.js'), fns(4));
    ctx = fakeCtx(root);
    assert.equal(runModuleSize(['--max-functions', '2', '--baseline', 'mb.json'], ctx), 2);
    assert.match(ctx.lines.join(''), /grew above pin/);
    writeFileSync(path.join(root, 'src', 'big.js'), fns(2) + '\n');
    ctx = fakeCtx(root);
    assert.equal(runModuleSize(['--max-functions', '2', '--baseline', 'mb.json'], ctx), 0);
    assert.match(ctx.lines.join(''), /improved {4}src\/big\.js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli: module-size subcommand is wired and a bad baseline is a usage error', () => {
  const root = fixture({ 'ok.js': fns(1) });
  try {
    const out = [];
    const err = [];
    const streams = { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) }, cwd: root };
    const prev = process.cwd();
    process.chdir(root);
    try {
      assert.equal(main(['module-size'], streams), 0);
      assert.match(out.join(''), /1 modules within 800 lines \/ 40 top-level functions/);
      assert.equal(main(['module-size', '--baseline', 'missing.json'], streams), 1);
    } finally {
      process.chdir(prev);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
