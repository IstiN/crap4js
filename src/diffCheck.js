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
//   4. diff-scoped `method-size`, `loc`, and `component-size` gates on touched
//      functions/files/components.
//
// Fail-closed: a missing coverage file, an unknown base ref or any tool error
// exits 1 — never a silent pass. `--warn-only` reports without failing (the
// rollout mode); exit 2 means violations.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { analyze } from './analyzer.js';
import {
  DEFAULT_MAX_COMPONENT_CALLBACKS,
  DEFAULT_MAX_COMPONENT_COMPLEXITY,
  DEFAULT_MAX_COMPONENT_LINES,
} from './componentSize.js';
import { isGateEnabled, loadConfig, resolvePathConfig } from './config.js';
import {
  COGNITIVE,
  CONFIG_OPT,
  COVERAGE,
  CRAP_GATE,
  CYCLOMATIC,
  DEFAULT_COVERAGE,
  EXCLUDE,
  EXPLAIN_OPT,
  MAX_CALLBACKS_OPT,
  MAX_COMPLEXITY_OPT,
  MAX_LINES_FLAG,
  MAX_LINES_OPT,
  MAX_PARAMS_OPT,
  METRIC_OPT,
  OVERRIDE_OPT,
  SPLIT_CALLBACKS_OPT,
  STRING,
  THRESHOLD_FLAG,
  THRESHOLD_OPT,
} from './constants.js';
import { loadCoverage } from './coverage.js';
import {
  baseCloneFingerprints,
  diffComponentSizeStep,
  diffLocStep,
  diffMethodSizeStep,
  filterDiffCheckViolations,
  filterDuplicatesFiles,
} from './diffCheckGates.js';
import { diffIntersects, parseDiffLineMap } from './diffLines.js';
import { duplicatesViolations, scanSet } from './duplicates.js';
import { formatExplanation } from './explain.js';
import { UTF8, gateFiles, toRelPath } from './files.js';
import { applyGateArg } from './gateCommon.js';
import { MAX_LINES as DEFAULT_MAX_LOC } from './loc.js';

const DEFAULTS = {
  base: 'origin/develop',
  coverage: DEFAULT_COVERAGE,
  threshold: 8,
  metric: CYCLOMATIC,
  minCoverage: 80,
  minTokens: 50,
  minLines: 5,
  maxLines: DEFAULT_MAX_LOC,
  maxMethodLines: 60,
  maxParams: 6,
  maxComplexity: DEFAULT_MAX_COMPONENT_COMPLEXITY,
  maxCallbacks: DEFAULT_MAX_COMPONENT_CALLBACKS,
  maxComponentLines: DEFAULT_MAX_COMPONENT_LINES,
};

const VALUE_FLAGS = {
  '--base': 'base',
  '--coverage': COVERAGE,
  [THRESHOLD_FLAG]: THRESHOLD_OPT,
  '--metric': METRIC_OPT,
  '--min-coverage': 'minCoverage',
  '--min-tokens': 'minTokens',
  '--min-lines': 'minLines',
  [MAX_LINES_FLAG]: MAX_LINES_OPT,
  '--max-method-lines': 'maxMethodLines',
  '--max-params': MAX_PARAMS_OPT,
  '--max-complexity': MAX_COMPLEXITY_OPT,
  '--max-callbacks': MAX_CALLBACKS_OPT,
  '--max-component-lines': 'maxComponentLines',
  '--exclude': EXCLUDE,
  '--exclude-duplicates': 'excludeDuplicates',
  '--config': CONFIG_OPT,
  '--override': OVERRIDE_OPT,
};

const NUMBER_FLAGS = new Set([
  THRESHOLD_FLAG,
  '--min-coverage',
  '--min-tokens',
  '--min-lines',
  MAX_LINES_FLAG,
  '--max-method-lines',
  '--max-params',
  '--max-complexity',
  '--max-callbacks',
  '--max-component-lines',
]);

const BOOLEAN_FLAGS = {
  '--help': 'help',
  '-h': 'help',
  '--warn-only': 'warnOnly',
  '--github': 'github',
  '--exact-clones': 'exactClones',
  '--ignore-types': 'ignoreTypes',
  '--ignore-data': 'ignoreData',
  '--new-duplicates-only': 'newDuplicatesOnly',
  '--split-callbacks': SPLIT_CALLBACKS_OPT,
  '--explain': EXPLAIN_OPT,
  '--no-coverage-gate': 'noCoverage',
  '--no-crap-gate': 'noCrap',
  '--no-duplicates-gate': 'noDuplicates',
  '--no-method-size-gate': 'noMethodSize',
  '--no-loc-gate': 'noLoc',
  '--no-component-size-gate': 'noComponentSize',
};

const VALID_METRICS = new Set([CYCLOMATIC, COGNITIVE]);

/**
 * Usage string for `crap4js diff-check --help`.
 */
export function diffCheckUsage() {
  return [
    'Usage: crap4js diff-check [options] [paths...]',
    '  --base REF                 Base git ref for merge-base (default: origin/develop)',
    '  --coverage FILE            Coverage file (default: coverage/coverage-final.json)',
    '  --min-coverage N           Min changed-lines statement coverage % (default: 80)',
    '  --threshold N              Max CRAP score on touched functions (default: 8)',
    '  --metric cyclomatic|cognitive  Complexity metric feeding CRAP (default: cyclomatic)',
    '  --split-callbacks          Measure named inner callbacks separately from parent',
    '  --explain                  Print AST constructs contributing to failing functions',
    '  --min-tokens N             Min tokens per duplicate block (default: 50)',
    '  --min-lines N              Min lines per duplicate block (default: 5)',
    '  --exclude GLOB             Exclude glob from all gates (repeatable)',
    '  --exclude-duplicates GLOB  Exclude glob from duplicates gate only (repeatable)',
    '  --ignore-types             Skip TS/Flow type/interface/enum declarations in duplicates',
    '  --ignore-data              Skip pure literal data objects/arrays in duplicates',
    '  --new-duplicates-only      Ignore clone groups whose fingerprint existed at --base',
    '  --exact-clones             Disable Type-2 normalization in duplicates',
    '  --config FILE              Path to crap4js.config.json',
    '  --override SPEC            Per-glob override (<glob>:threshold=15,metric=cognitive,...)',
    '  --no-coverage-gate         Disable changed-lines coverage gate',
    '  --no-crap-gate             Disable CRAP gate',
    '  --no-duplicates-gate       Disable duplicates gate',
    '  --no-method-size-gate      Disable diff-scoped method-size gate',
    '  --no-loc-gate              Disable diff-scoped loc gate',
    '  --no-component-size-gate   Disable diff-scoped component-size gate',
    '  --warn-only                Report violations but exit 0',
    '  --github                   Emit GitHub Actions ::error annotations',
    '  -h, --help                 Show this help message',
    '',
  ].join('\n');
}

/**
 * Parse `diff-check` arguments. Value flags accept `--flag VALUE` or
 * `--flag=VALUE`; `--exclude`, `--exclude-duplicates`, and `--override`
 * are repeatable; booleans are bare flags.
 *
 * @param {string[]} argv
 */
export function parseDiffCheckArgs(argv) {
  const opts = {
    ...DEFAULTS,
    exclude: [],
    excludeDuplicates: [],
    override: [],
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === THRESHOLD_FLAG || a.startsWith(`${THRESHOLD_FLAG}=`)) opts.explicit_threshold = true;
    if (a === '--metric' || a.startsWith('--metric=')) opts.explicit_metric = true;
    const bool = BOOLEAN_FLAGS[a];
    if (bool) opts[bool] = true;
    else i = applyGateArg(opts, a, argv, i, VALUE_FLAGS, NUMBER_FLAGS);
  }
  validateDiffCheckOpts(opts);
  return opts;
}

function validateDiffCheckOpts(opts) {
  if (typeof opts.base !== STRING || opts.base.trim() === '') {
    throw new Error('--base requires a non-empty git ref');
  }
  if (!VALID_METRICS.has(opts.metric)) {
    throw new Error(`Invalid --metric: ${opts.metric} (expected cyclomatic or cognitive)`);
  }
}

function git(cwd, args, spawn) {
  const r = spawn('git', args, { cwd, encoding: UTF8, maxBuffer: 256 * 1024 * 1024 });
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
  const count = readFileSync(abs, UTF8).split('\n').length;
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
export function coverageResult(changed, coverageMap, minCoverage, configObj = null) {
  let covered = 0;
  let total = 0;
  const skipped = [];
  const files = [];
  for (const [file, lines] of changed) {
    if (configObj && !isGateEnabled(configObj, file, COVERAGE)) continue;
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
    rule: COVERAGE,
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
    .filter((m) => m.crapScore != null && m.crapScore > (m.threshold ?? threshold))
    .filter((m) => diffIntersects(changed, m.file, m.startLine, m.endLine))
    .map((m) => {
      const limit = m.threshold ?? threshold;
      const metricTag = m.metric === COGNITIVE ? COGNITIVE : 'CC';
      return {
        rule: CRAP_GATE,
        file: m.file,
        line: m.startLine,
        methodName: m.methodName,
        metric: m.metric ?? CYCLOMATIC,
        complexity: m.complexity,
        breakdown: m.breakdown,
        message: `${m.methodName}: CRAP ${m.crapScore.toFixed(1)} > ${limit} (${metricTag} ${m.complexity}, coverage ${formatPercent(m.coverage)}) — modified functions must stay under the bar`,
      };
    });
}

function formatPercent(fraction) {
  return `${Math.round((fraction ?? 0) * 100)}%`;
}

/**
 * Rule 3: a clone group is reported once for each occurrence that overlaps
 * the changed lines, naming where the copy lives. When `baseFingerprints` is
 * provided (`--new-duplicates-only`), clones whose fingerprint already existed
 * at `--base` are returned in `preExisting` instead of `violations`.
 */
export function cloneViolations(clones, changed, baseFingerprints = null) {
  const out = [];
  for (const clone of clones) {
    for (const occ of clone.occurrences) {
      if (!diffIntersects(changed, occ.file, occ.startLine, occ.endLine)) continue;
      if (isPreExistingClone(clone, occ, baseFingerprints)) continue;
      out.push(cloneViolation(clone, occ));
    }
  }
  return out;
}

function isPreExistingClone(clone, occ, baseFingerprints) {
  if (!baseFingerprints) return false;
  return baseFingerprints.has(clone.fingerprint) || baseFingerprints.has(occ.fingerprint);
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

function dupScanOptions(opts) {
  const masks = opts.exactClones
    ? { pairwise: true }
    : {
        ignoreLocals: true,
        ignoreLiterals: true,
        ignoreImports: true,
        ignoreProperties: true,
        pairwise: true,
      };
  return {
    threshold: 1,
    minTokens: opts.minTokens,
    minLines: opts.minLines,
    report: 'clones',
    ignoreTypes: opts.ignoreTypes,
    ignoreData: opts.ignoreData,
    ...masks,
  };
}

function detectClones(opts, ctx, base, configObj) {
  const exclude = [...opts.exclude, ...opts.excludeDuplicates];
  const rawFiles = scanSet({ paths: opts.paths, source: [], exclude }, ctx.cwd);
  const files = filterDuplicatesFiles(rawFiles, ctx.cwd, configObj);
  const dupOpts = dupScanOptions(opts);
  const clones = duplicatesViolations(files, ctx.cwd, dupOpts).clones;
  const baseFp = opts.newDuplicatesOnly
    ? baseCloneFingerprints(files, base, ctx.cwd, dupOpts)
    : null;
  return { clones, baseFp };
}

function sourceCandidates(opts, ctx) {
  return gateFiles(opts.paths, ctx.cwd).map((f) => toRelPath(f, ctx.cwd));
}

function crapStep(opts, ctx, changed, configObj) {
  const topCfg = resolvePathConfig(configObj, '', opts);
  const threshold = topCfg.threshold ?? opts.threshold;
  const metric = topCfg.metric ?? opts.metric;
  const { metrics } = analyze({
    filePaths: [...changed.keys()].map((rel) => path.join(ctx.cwd, rel)),
    coveragePath: path.resolve(ctx.cwd, opts.coverage),
    projectRoot: ctx.cwd,
    metric,
    splitCallbacks: opts.splitCallbacks,
    explain: opts.explain,
    config: configObj,
  });
  return crapViolations(metrics, changed, threshold);
}

function requireCoverageFile(opts, ctx) {
  if (opts.noCoverage && opts.noCrap) return;
  const file = path.resolve(ctx.cwd, opts.coverage);
  if (!existsSync(file)) {
    throw new Error(`coverage file not found: ${opts.coverage} (run the tests with coverage first; the gate fails closed)`);
  }
}

function runGates(opts, ctx, changed, base, configObj) {
  requireCoverageFile(opts, ctx);
  const raw = [];
  let coverage = null;
  if (!opts.noCoverage) {
    const map = loadCoverage(path.resolve(ctx.cwd, opts.coverage), ctx.cwd);
    coverage = coverageResult(changed, map, opts.minCoverage, configObj);
    raw.push(...coverage.violations);
  }
  if (!opts.noCrap) raw.push(...crapStep(opts, ctx, changed, configObj));
  if (!opts.noDuplicates) {
    const { clones, baseFp } = detectClones(opts, ctx, base, configObj);
    raw.push(...cloneViolations(clones, changed, baseFp));
  }
  raw.push(...diffMethodSizeStep(opts, ctx, changed, configObj));
  raw.push(...diffLocStep(opts, ctx, changed, configObj));
  raw.push(...diffComponentSizeStep(opts, ctx, changed, configObj));
  const violations = filterDiffCheckViolations(raw, ctx.cwd);
  return { violations, coverage };
}

function summary(opts, base, changed, { violations, coverage }) {
  const by = (rule) => violations.filter((v) => v.rule === rule).length;
  const cov = coverage
    ? `changed-lines coverage ${coverage.percent.toFixed(1)}% (${coverage.covered}/${coverage.total}, need >= ${opts.minCoverage}%)`
    : 'coverage gate off';
  return `diff-check vs ${base.slice(0, 8)} (${opts.base}): ${changed.size} changed source files; ${cov}; ` +
    `${by(CRAP_GATE)} functions over CRAP ${opts.threshold}; ${by('duplication')} duplicated blocks`;
}

function report(opts, ctx, violations) {
  for (const v of violations) {
    ctx.out.write(`[${v.rule}] ${v.file}:${v.line}: ${v.message}\n`);
    if (opts.github) ctx.out.write(`::error file=${v.file},line=${v.line},title=${v.rule}::${v.message}\n`);
    if (opts.explain && v.breakdown) {
      ctx.out.write(formatExplanation(v.file, v.methodName, v.line, v.metric, v.complexity, v.breakdown));
    }
  }
}

/**
 * The `diff-check` command body. Exit codes: 0 pass (or `--warn-only` /
 * `--help`), 2 violations; tool/usage errors surface as exceptions (the CLI
 * exits 1).
 */
export function runDiffCheck(argv, ctx) {
  const opts = parseDiffCheckArgs(argv);
  if (opts.help) {
    ctx.out.write(diffCheckUsage());
    return 0;
  }
  const configObj = loadConfig(ctx.cwd, { configPath: opts.config, overrides: opts.override });
  const base = mergeBase(opts.base, ctx.cwd);
  const changed = changedLineMap(base, sourceCandidates(opts, ctx), ctx.cwd);
  if (changed.size === 0) {
    ctx.out.write(`diff-check vs ${base.slice(0, 8)}: no changed source lines.\n`);
    return 0;
  }
  const result = runGates(opts, ctx, changed, base, configObj);
  report(opts, ctx, result.violations);
  ctx.out.write(summary(opts, base, changed, result) + '\n');
  if (result.violations.length === 0) return 0;
  return opts.warnOnly ? 0 : 2;
}
