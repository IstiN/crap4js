// `diff-check` subcommand: diff-scoped quality gate ("Clean as You Code").
//
// Nothing is stored and nothing is compared with a global number: every rule
// is computed from the current code plus `git diff <merge-base>`:
//
//   1. changed-lines coverage >= --min-coverage (Codecov "patch coverage"),
//      from the Istanbul statement map of the current coverage run;
//   2. every new or modified function has CRAP <= --threshold (boy-scout
//      rule: touch it, bring it under the bar; untouched legacy is ignored);
//   3. no clone group has an occurrence overlapping the changed lines. The
//      detector is crap4js' own AST-aware one (renamed locals, masked
//      literals, ignored imports) over the whole project, so the other side
//      of a copy-paste is found even when it lives in an untouched file.
//
// Fail-closed: a missing coverage file, an unknown base ref or any tool error
// exits 1 — never a silent pass. `--warn-only` reports without failing (the
// rollout mode); exit 2 means violations.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { analyze } from './analyzer.js';
import { loadCoverage } from './coverage.js';
import { diffIntersects, parseDiffLineMap } from './diffLines.js';
import { duplicatesViolations, scanSet } from './duplicates.js';
import { gateFiles, toRelPath } from './files.js';
import { applyGateArg } from './gateCommon.js';

const DEFAULTS = {
  base: 'origin/develop',
  coverage: 'coverage/coverage-final.json',
  threshold: 8,
  minCoverage: 80,
  minTokens: 50,
  minLines: 5,
};

const VALUE_FLAGS = {
  '--base': 'base',
  '--coverage': 'coverage',
  '--threshold': 'threshold',
  '--min-coverage': 'minCoverage',
  '--min-tokens': 'minTokens',
  '--min-lines': 'minLines',
  '--exclude': 'exclude',
};
const NUMBER_FLAGS = new Set(['--threshold', '--min-coverage', '--min-tokens', '--min-lines']);
const BOOLEAN_FLAGS = {
  '--warn-only': 'warnOnly',
  '--github': 'github',
  '--exact-clones': 'exactClones',
  '--no-coverage-gate': 'noCoverage',
  '--no-crap-gate': 'noCrap',
  '--no-duplicates-gate': 'noDuplicates',
};

/**
 * Parse `diff-check` arguments. Value flags accept `--flag VALUE` or
 * `--flag=VALUE`; `--exclude` is repeatable; booleans are bare flags.
 *
 * @param {string[]} argv
 */
export function parseDiffCheckArgs(argv) {
  const opts = { ...DEFAULTS, exclude: [], paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const bool = BOOLEAN_FLAGS[argv[i]];
    if (bool) opts[bool] = true;
    else i = applyGateArg(opts, argv[i], argv, i, VALUE_FLAGS, NUMBER_FLAGS);
  }
  if (typeof opts.base !== 'string' || opts.base.trim() === '') {
    throw new Error('--base requires a non-empty git ref');
  }
  return opts;
}

function git(cwd, args, spawn) {
  const r = spawn('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : (r.stderr ?? '').trim();
    throw new Error(`git ${args.join(' ')} failed: ${why}`);
  }
  return r.stdout.trim();
}

/**
 * The commit the PR branched from: `git merge-base <base> HEAD`. A shallow
 * clone (no history for the base) fails closed with a fetch-depth hint.
 */
export function mergeBase(base, cwd, spawn = spawnSync) {
  try {
    return git(cwd, ['merge-base', base, 'HEAD'], spawn);
  } catch (e) {
    throw new Error(`${e.message}\n(is the base ref fetched? CI needs actions/checkout fetch-depth: 0)`);
  }
}

/**
 * Project-relative path -> Set of added/changed lines, between the merge-base
 * and the working tree (committed + staged + unstaged), restricted to
 * `relFiles`. Untracked files count as fully changed.
 *
 * @param {string} base  merge-base commit
 * @param {string[]} relFiles  project-relative candidate source files
 * @param {string} cwd
 * @param {Function} [spawn]  injectable for tests
 * @returns {Map<string, Set<number>>}
 */
export function changedLineMap(base, relFiles, cwd, spawn = spawnSync) {
  const wanted = new Set(relFiles);
  const diff = parseDiffLineMap(git(cwd, ['diff', '--unified=0', base, '--'], spawn));
  const map = new Map([...diff].filter(([file]) => wanted.has(file)));
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard'], spawn).split('\n');
  for (const file of untracked.filter((f) => wanted.has(f))) {
    map.set(file, allLines(path.join(cwd, file)));
  }
  return map;
}

function allLines(abs) {
  const count = readFileSync(abs, 'utf8').split('\n').length;
  return new Set(Array.from({ length: count }, (_, i) => i + 1));
}

/**
 * Statement coverage restricted to the changed lines of one file: a statement
 * counts when it STARTS on a changed line.
 *
 * @returns {{ covered: number, total: number, uncovered: number[] }}
 */
export function changedLineCoverage(fileCoverage, lines) {
  const hits = fileCoverage.s ?? {};
  const uncovered = new Set();
  let total = 0;
  let covered = 0;
  for (const [id, stmt] of Object.entries(fileCoverage.statementMap ?? {})) {
    const line = stmt?.start?.line;
    if (line == null || !lines.has(line)) continue;
    total++;
    if (hits[id] > 0) covered++;
    else uncovered.add(line);
  }
  return { covered, total, uncovered: [...uncovered].sort((a, b) => a - b) };
}

/** `[3,4,5,9]` -> `3-5,9`. */
export function formatRanges(lines) {
  const out = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
    out.push(j > i ? `${lines[i]}-${lines[j]}` : `${lines[i]}`);
    i = j + 1;
  }
  return out.join(',');
}

/**
 * Rule 1: the covered share of all executable changed statements must reach
 * `minCoverage` percent. Changed files absent from the coverage run (types,
 * barrels excluded by collectCoverageFrom) are skipped and listed in `skipped`.
 */
export function coverageResult(changed, coverageMap, minCoverage) {
  let covered = 0;
  let total = 0;
  const skipped = [];
  const files = [];
  for (const [file, lines] of changed) {
    const fc = coverageMap.get(file);
    if (!fc) {
      skipped.push(file);
      continue;
    }
    const r = changedLineCoverage(fc, lines);
    covered += r.covered;
    total += r.total;
    if (r.uncovered.length > 0) files.push({ file, ...r });
  }
  const percent = total === 0 ? 100 : (covered / total) * 100;
  const violations = percent >= minCoverage ? [] : files.map(coverageViolation);
  return { covered, total, percent, skipped, files, failed: percent < minCoverage, violations };
}

function coverageViolation({ file, uncovered, covered, total }) {
  return {
    rule: 'coverage',
    file,
    line: uncovered[0],
    message: `changed lines not covered by tests: ${formatRanges(uncovered)} (${covered}/${total} statements covered)`,
  };
}

/**
 * Rule 2: every function whose line range intersects the diff must have
 * CRAP <= threshold. Functions with unknown coverage (N/A) are skipped.
 */
export function crapViolations(metrics, changed, threshold) {
  return metrics
    .filter((m) => m.crapScore != null && m.crapScore > threshold)
    .filter((m) => diffIntersects(changed, m.file, m.startLine, m.endLine))
    .map((m) => ({
      rule: 'crap',
      file: m.file,
      line: m.startLine,
      message: `${m.methodName}: CRAP ${m.crapScore.toFixed(1)} > ${threshold} (CC ${m.complexity}, coverage ${formatPercent(m.coverage)}) — modified functions must stay under the bar`,
    }));
}

function formatPercent(fraction) {
  return `${Math.round((fraction ?? 0) * 100)}%`;
}

/**
 * Rule 3: a clone group is reported once for each occurrence that overlaps
 * the changed lines, naming where the copy lives.
 */
export function cloneViolations(clones, changed) {
  const out = [];
  for (const clone of clones) {
    for (const occ of clone.occurrences) {
      if (!diffIntersects(changed, occ.file, occ.startLine, occ.endLine)) continue;
      out.push(cloneViolation(clone, occ));
    }
  }
  return out;
}

function cloneViolation(clone, occ) {
  const others = clone.occurrences
    .filter((o) => o !== occ)
    .map((o) => `${o.file}:${o.startLine}-${o.endLine}`);
  return {
    rule: 'duplication',
    file: occ.file,
    line: occ.startLine,
    message: `duplicated code (${clone.tokens} tokens / ${clone.lines} lines) also at ${others.slice(0, 3).join('; ')}${others.length > 3 ? ` (+${others.length - 3} more)` : ''}`,
  };
}

function detectClones(opts, ctx) {
  const files = scanSet({ paths: opts.paths, source: [], exclude: opts.exclude }, ctx.cwd);
  const masks = opts.exactClones
    ? { pairwise: true }
    : { ignoreLocals: true, ignoreLiterals: true, ignoreImports: true, ignoreProperties: true, pairwise: true };
  return duplicatesViolations(files, ctx.cwd, {
    threshold: 1,
    minTokens: opts.minTokens,
    minLines: opts.minLines,
    report: 'clones',
    ...masks,
  }).clones;
}

function sourceCandidates(opts, ctx) {
  return gateFiles(opts.paths, ctx.cwd).map((f) => toRelPath(f, ctx.cwd));
}

function crapStep(opts, ctx, changed) {
  const { metrics } = analyze({
    filePaths: [...changed.keys()].map((rel) => path.join(ctx.cwd, rel)),
    coveragePath: path.resolve(ctx.cwd, opts.coverage),
    projectRoot: ctx.cwd,
  });
  return crapViolations(metrics, changed, opts.threshold);
}

function requireCoverageFile(opts, ctx) {
  if (opts.noCoverage && opts.noCrap) return;
  const file = path.resolve(ctx.cwd, opts.coverage);
  if (!existsSync(file)) {
    throw new Error(`coverage file not found: ${opts.coverage} (run the tests with coverage first; the gate fails closed)`);
  }
}

function runGates(opts, ctx, changed) {
  requireCoverageFile(opts, ctx);
  const violations = [];
  let coverage = null;
  if (!opts.noCoverage) {
    const map = loadCoverage(path.resolve(ctx.cwd, opts.coverage), ctx.cwd);
    coverage = coverageResult(changed, map, opts.minCoverage);
    violations.push(...coverage.violations);
  }
  if (!opts.noCrap) violations.push(...crapStep(opts, ctx, changed));
  if (!opts.noDuplicates) violations.push(...cloneViolations(detectClones(opts, ctx), changed));
  return { violations, coverage };
}

function summary(opts, base, changed, { violations, coverage }) {
  const by = (rule) => violations.filter((v) => v.rule === rule).length;
  const cov = coverage
    ? `changed-lines coverage ${coverage.percent.toFixed(1)}% (${coverage.covered}/${coverage.total}, need >= ${opts.minCoverage}%)`
    : 'coverage gate off';
  return `diff-check vs ${base.slice(0, 8)} (${opts.base}): ${changed.size} changed source files; ${cov}; ` +
    `${by('crap')} functions over CRAP ${opts.threshold}; ${by('duplication')} duplicated blocks`;
}

function report(opts, ctx, violations) {
  for (const v of violations) {
    ctx.out.write(`[${v.rule}] ${v.file}:${v.line}: ${v.message}\n`);
    if (opts.github) ctx.out.write(`::error file=${v.file},line=${v.line},title=${v.rule}::${v.message}\n`);
  }
}

/**
 * The `diff-check` command body. Exit codes: 0 pass (or `--warn-only`),
 * 2 violations; tool errors surface as exceptions (the CLI exits 1).
 */
export function runDiffCheck(argv, ctx) {
  const opts = parseDiffCheckArgs(argv);
  const base = mergeBase(opts.base, ctx.cwd);
  const changed = changedLineMap(base, sourceCandidates(opts, ctx), ctx.cwd);
  if (changed.size === 0) {
    ctx.out.write(`diff-check vs ${base.slice(0, 8)}: no changed source lines.\n`);
    return 0;
  }
  const result = runGates(opts, ctx, changed);
  report(opts, ctx, result.violations);
  ctx.out.write(summary(opts, base, changed, result) + '\n');
  if (result.violations.length === 0) return 0;
  return opts.warnOnly ? 0 : 2;
}
