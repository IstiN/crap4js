import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extractMethods, runComplexity } from '../src/complexity.js';
import { formatExplainLine, formatExplanation } from '../src/explain.js';
import { main } from '../src/cli.js';

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

test('explain: cyclomatic breakdown attributes constructs and inner arrows (Issue #4)', () => {
  const src = [
    'export const Screen = ({ a, b, list }) => {',
    '  const onPress = useCallback(() => {',
    '    try { doWork(); }',
    '    catch (e) { handle(e); }',
    '  }, []);',
    '  const handlers = {',
    '    onTap: () => (a && b ? 1 : 2),',
    '  };',
    '  let fn;',
    '  fn = () => (a || b);',
    '  function innerNamed() {',
    '    if (a) return 1;',
    '  }',
    '  switch (a) {',
    '    case 1: break;',
    '    default: break;',
    '  }',
    '  return list.map((x) => (x ? 1 : 0));',
    '};',
  ].join('\n');

  // Default mode: const onPress = useCallback(...) is not extracted as a separate entry,
  // so its catch is attributed to Screen with `(in arrow onPress at :2)`.
  // handlers.onTap IS extracted as its own entry (`onTap`), so it is NOT in Screen.
  const methods = extractMethods(src, { ext: '.tsx', explain: true });
  const screen = methods.find((m) => m.name === 'Screen');
  assert.ok(screen?.breakdown);
  const formatted = formatExplanation('src/Screen.tsx', screen.name, screen.startLine, 'cyclomatic', screen.complexity, screen.breakdown);
  assert.match(formatted, /src\/Screen\.tsx:1 Screen CC=/);
  assert.match(formatted, /\+1 base/);
  assert.match(formatted, /\+1 :4 catch\s+\(in arrow onPress at :2\)/);
  assert.match(formatted, /\+1 :15 case/);
  assert.match(formatted, /\+1 :16 default/);
  assert.match(formatted, /\+1 :18 \?:\s+\(in arrow at :18\)/);
});

test('explain: cognitive breakdown includes nesting and else / logical sequence roots', () => {
  const src = [
    'export function process(a, b, c) {',
    '  if (a && b && c) {',
    '    for (const x of [1, 2]) {',
    '      if (x > 1) return x;',
    '    }',
    '  } else if (b) {',
    '    return 2;',
    '  } else {',
    '    const helper = { run: () => (a ? 1 : 0) };',
    '    let cb;',
    '    cb = () => (b || c);',
    '    return [1, 2].map((item) => (item > 1 ? item : 0));',
    '  }',
    '}',
  ].join('\n');

  // With countLambdas: true, cognitive breakdown records nesting penalties
  const methods = extractMethods(src, { ext: '.js', metric: 'cognitive', explain: true });
  const proc = methods.find((m) => m.name === 'process');
  assert.ok(proc?.breakdown);
  const text = formatExplanation('src/proc.js', proc.name, proc.startLine, 'cognitive', proc.complexity, proc.breakdown);
  assert.match(text, /src\/proc\.js:1 process cognitive=/);
  assert.match(text, /\+1 :2 if/);
  assert.match(text, /\+1 :2 &&/);
  assert.match(text, /\+2 :3 for\.\.\.of \(nesting \+1\)/);
  assert.match(text, /\+3 :4 if \(nesting \+2\)/);
  assert.match(text, /\+1 :6 if/);
  assert.match(text, /\+1 :8 else/);
});

test('formatExplainLine handles long construct lines and named/unnamed arrows', () => {
  const longLine = formatExplainLine({
    delta: 4,
    line: 12345,
    label: 'for...of',
    nesting: 12,
    arrow: { name: 'myVeryLongCallbackName', line: 120 },
  });
  assert.match(longLine, /\+4 :12345 for\.\.\.of \(nesting \+12\) \(in arrow myVeryLongCallbackName at :120\)/);
});

test('--explain works on main CRAP command and complexity subcommand', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'crap4js-explain-cli-'));
  try {
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    mkdirSync(path.join(dir, 'coverage'), { recursive: true });
    const f = path.join(dir, 'src/a.js');
    writeFileSync(f, 'export function f(a, b) {\n  if (a && b) return 1;\n  return 0;\n}\n');
    writeFileSync(
      path.join(dir, 'coverage/coverage-final.json'),
      JSON.stringify({
        [f]: {
          path: f,
          statementMap: { 0: { start: { line: 2, column: 0 }, end: { line: 3, column: 10 } } },
          s: { 0: 1 },
        },
      }),
    );

    const crapCtx = fakeCtx(dir);
    assert.equal(main(['--explain'], crapCtx), 0);
    assert.match(crapCtx.lines.join(''), /src\/a\.js:1 f CC=3/);
    assert.match(crapCtx.lines.join(''), /\+1 :2 if/);
    assert.match(crapCtx.lines.join(''), /\+1 :2 &&/);

    const compCtx = fakeCtx(dir);
    assert.equal(runComplexity(['--max', '1', '--explain'], compCtx), 2);
    assert.match(compCtx.lines.join(''), /src\/a\.js:1 f CC=3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
