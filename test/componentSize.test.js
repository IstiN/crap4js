import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  componentSizeSummary,
  componentSizeViolations,
  componentTotals,
  parseComponentSizeArgs,
  runComponentSize,
} from '../src/componentSize.js';
import { parseSource } from '../src/complexity.js';
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

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-comp-size-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    const abs = path.join(root, 'src', name);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

test('componentTotals identifies PascalCase functions/arrows returning JSX and ignores helpers', () => {
  const src = `
import React, { useState, useCallback, useEffect } from 'react';

export function plainHelper(x) {
  return x ? 1 : 2;
}

export const NotJsx = () => {
  return 42;
};

export const MyWidget = React.memo(({ a, b }) => {
  const [count, setCount] = useState(0);
  const onTap = useCallback(() => {
    if (a) setCount(count + 1);
  }, [a, count]);
  useEffect(() => {
    if (b) onTap();
  }, [b, onTap]);
  function renderSub() {
    return a && b ? <span>ok</span> : null;
  }
  return <div onClick={() => a && onTap()}>{renderSub()}</div>;
});

export function SimpleCard({ title }) {
  return <><h1>{title}</h1></>;
}
`;
  const ast = parseSource(src, '.tsx');
  const totals = componentTotals(ast.program);
  assert.deepEqual(
    totals.map((c) => c.name),
    ['MyWidget', 'SimpleCard'],
  );
  const widget = totals[0];
  // Callbacks/hooks: useState(1) + useCallback arrow(1) + useEffect arrow(1) + renderSub(1) + inline onClick arrow(1) = 5
  assert.equal(widget.callbacks, 5);
  assert.ok(widget.complexity >= 6);
  assert.ok(widget.lines > 10);
});

test('componentSizeViolations flags components exceeding maxComplexity, maxCallbacks, or maxLines', () => {
  const src = `
export const BigScreen = ({ a, b, c }) => {
  const [x] = useState(0);
  const [y] = React.useState(1);
  const h1 = () => (a ? 1 : 2);
  const h2 = () => (b ? 3 : 4);
  return <div>{c ? h1() : h2()}</div>;
};
`;
  const root = fixture({ 'BigScreen.tsx': src });
  try {
    const file = path.join(root, 'src', 'BigScreen.tsx');
    const r = componentSizeViolations([file], root, {
      maxComplexity: 2,
      maxCallbacks: 2,
      maxLines: 5,
    });
    assert.equal(r.checked, 1);
    assert.equal(r.violations.length, 3);
    assert.match(r.violations[0].message, /BigScreen complexity=4 > max 2/);
    assert.match(r.violations[1].message, /BigScreen has 4 callbacks\/hooks > max 2/);
    assert.match(r.violations[2].message, /BigScreen has \d+ lines > max 5/);
  } finally {
    cleanup(root);
  }
});

test('runComponentSize CLI and per-path config / override', () => {
  const src = `
export function Card({ active }) {
  const h1 = () => (active ? 1 : 0);
  const h2 = () => (!active ? 1 : 0);
  return <div>{h1() + h2()}</div>;
}
`;
  const root = fixture({ 'Card.tsx': src });
  try {
    const okCtx = fakeCtx(root);
    assert.equal(runComponentSize([], okCtx), 0);
    assert.match(okCtx.lines.join(''), /1 components within 10 callbacks\/complexity 40\/200 lines/);

    const failCtx = fakeCtx(root);
    assert.equal(main(['component-size', '--max-callbacks', '1'], failCtx), 2);
    assert.match(failCtx.lines.join(''), /Card has 2 callbacks\/hooks > max 1/);
    assert.match(failCtx.lines.join(''), /1 violations in 1 components over 1 callbacks/);

    // Disable componentSize gate via --override
    const skipCtx = fakeCtx(root);
    assert.equal(
      runComponentSize(['--max-callbacks', '1', '--override', '**/*.tsx:gates.componentSize=false'], skipCtx),
      0,
    );
  } finally {
    cleanup(root);
  }
});

test('parseComponentSizeArgs validates integer flags and rejects unknown flags', () => {
  const d = parseComponentSizeArgs(['--max-complexity=25', '--max-callbacks', '6', '--max-lines', '120', 'src']);
  assert.equal(d.maxComplexity, 25);
  assert.equal(d.maxCallbacks, 6);
  assert.equal(d.maxLines, 120);
  assert.deepEqual(d.paths, ['src']);
  assert.throws(() => parseComponentSizeArgs(['--max-lines', '2.5']), /must be an integer/);
  assert.throws(() => parseComponentSizeArgs(['--unknown']), /unknown flag: --unknown/);
  assert.equal(
    componentSizeSummary({ violations: 2, checked: 3 }, { maxComplexity: 30, maxCallbacks: 8, maxLines: 150 }),
    '2 violations in 3 components over 8 callbacks/complexity 30/150 lines',
  );
});
