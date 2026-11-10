// Orchestrates parsing + coverage attribution to produce MethodMetric[].
//
// MethodMetric = {
//   methodName: string,
//   file: string,          // project-relative
//   startLine: number,     // kept for stable tie-breaking
//   endLine: number,       // last line of the function (diff-scoped gates)
//   complexity: number,
//   coverage: number|null, // fraction [0,1]
//   crapScore: number|null
// }

import { UTF8, toRelPath } from './files.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { extractMethods } from './complexity.js';
import { isGateEnabled, resolvePathConfig } from './config.js';
import { CRAP_GATE } from './constants.js';
import { loadCoverage, coverageForMethod } from './coverage.js';
import { diffIntersects } from './diffLines.js';
import { crapScore } from './crapScore.js';

/**
 * Analyze a set of source files, combining complexity and coverage.
 *
 * @param {{ filePaths: string[], coveragePath: string|null, projectRoot: string, metric?: string, strict?: boolean, diffLines?: Map<string, Set<number>>, splitCallbacks?: boolean, explain?: boolean, config?: object }} opts
 *   `metric` selects the complexity scoring: `cyclomatic` (default) or
 *   `cognitive` (SonarSource v1.2); the chosen value feeds the CRAP formula.
 *   A coverage input that is missing, unparseable, or contains no records
 *   throws (fail-closed — a CRAP score without coverage is meaningless).
 *   `strict` treats a selected file with no coverage entry as 0.0% covered
 *   instead of N/A.
 *   `diffLines` (a parseDiffLineMap result) restricts the report to the
 *   functions whose line range intersects an added/changed line; files with
 *   no intersecting function contribute nothing.
 * @returns {{ metrics: Array<object>, parseFailures: string[] }}
 *   Sorted MethodMetric array plus relative paths of files that failed to parse.
 */
export function analyze({ filePaths, coveragePath, projectRoot, metric, strict, diffLines, splitCallbacks, explain, config }) {
  const warn = (msg) => process.stderr.write(`Warning: ${msg}\n`);
  const coverageMap = loadCoverageMap(coveragePath, projectRoot);
  const fileOpts = { metric, strict, diffLines, splitCallbacks, explain, config };

  const metrics = [];
  const parseFailures = [];
  for (const file of filePaths) {
    const { metrics: fileMetrics, failures } = analyzeFile(
      file,
      projectRoot,
      coverageMap,
      warn,
      fileOpts,
    );
    metrics.push(...fileMetrics);
    parseFailures.push(...failures);
  }

  metrics.sort(compareMetrics);
  return { metrics, parseFailures };
}

function loadCoverageMap(coveragePath, projectRoot) {
  // null coverage input is the caller opting out (the `profile` subcommand's
  // coverage-free method inventory); the CRAP command always resolves a path.
  if (!coveragePath) return null;
  if (!existsSync(coveragePath)) {
    throw coverageError(`coverage file not found at ${coveragePath}`);
  }
  let map;
  try {
    map = loadCoverage(coveragePath, projectRoot);
  } catch (e) {
    throw coverageError(`failed to parse coverage file ${coveragePath}: ${e.message}`);
  }
  if (map.size === 0) {
    throw coverageError(`coverage file has no records for this project: ${coveragePath}`);
  }
  return map;
}

// Every coverage-input problem gates the run: the CLI's tryStep turns the
// throw into exit 1 with the message on stderr and no report. Unit-test
// coverage is required — a CRAP score without coverage is meaningless.
function coverageError(message) {
  return new Error(
    `${message}. Generate unit-test coverage with \`npx c8 --reporter=json node --test\`.`,
  );
}

// Diff-scoped runs keep only the functions whose line range intersects an
// added/changed line; a file whose functions all miss the diff selects
// nothing (null), so it contributes no metrics at all.
function inDiffSelection(diffLines, rel, methods) {
  if (!diffLines) return methods;
  const selected = methods.filter((m) => diffIntersects(diffLines, rel, m.startLine, m.endLine));
  return selected.length === 0 ? null : selected;
}

function analyzeFile(file, projectRoot, coverageMap, warn, opts) {
  const rel = toRelPath(file, projectRoot);
  if (opts.config && !isGateEnabled(opts.config, rel, CRAP_GATE)) {
    return { metrics: [], failures: [] };
  }
  const pathCfg = opts.config ? resolvePathConfig(opts.config, rel, { metric: opts.metric }) : null;
  const fileMetric = pathCfg?.metric ?? opts.metric;
  const methods = parseFileMethods(file, rel, fileMetric, opts, warn);
  if (!methods) return { metrics: [], failures: [rel] };
  const selected = inDiffSelection(opts.diffLines, rel, methods);
  if (selected === null) return { metrics: [], failures: [] };
  return {
    metrics: mapFileMetrics(selected, rel, coverageMap, opts.strict, fileMetric, pathCfg),
    failures: [],
  };
}

function mapFileMetrics(methods, rel, coverageMap, strict, fileMetric, pathCfg) {
  const fileCoverage = coverageMap ? coverageMap.get(rel) : null;
  const uncovered = strict && coverageMap && !coverageMap.has(rel);
  return methods.map((m) => buildMetric(m, rel, fileCoverage, uncovered, fileMetric, pathCfg));
}

function parseFileMethods(file, rel, fileMetric, opts, warn) {
  try {
    return extractMethods(readFileSync(file, UTF8), {
      ext: path.extname(file),
      metric: fileMetric,
      splitCallbacks: opts.splitCallbacks,
      explain: opts.explain,
    });
  } catch (e) {
    warn(`failed to parse ${rel}: ${e.message}`);
    return null;
  }
}

function buildMetric(m, rel, fileCoverage, uncovered, fileMetric, pathCfg) {
  const coverage = uncovered ? 0 : coverageForMethod(fileCoverage, m.startLine, m.endLine);
  const entry = {
    methodName: m.name,
    file: rel,
    startLine: m.startLine,
    endLine: m.endLine,
    complexity: m.complexity,
    coverage,
    crapScore: crapScore(m.complexity, coverage),
  };
  if (fileMetric) entry.metric = fileMetric;
  if (pathCfg?.threshold !== undefined) entry.threshold = pathCfg.threshold;
  if (m.breakdown) entry.breakdown = m.breakdown;
  return entry;
}

/**
 * Comparator sorting MethodMetric rows by CRAP score descending, with N/A
 * last and file+startLine tie-breaking.
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function compareMetrics(a, b) {
  const aNull = a.crapScore == null;
  const bNull = b.crapScore == null;
  if (aNull && bNull) return tieBreak(a, b);
  if (aNull) return 1;
  if (bNull) return -1;
  if (b.crapScore !== a.crapScore) return b.crapScore - a.crapScore;
  return tieBreak(a, b);
}

function tieBreak(a, b) {
  // `<` vs `<=` is mutation-equivalent here: the ternary evaluates only
  // after the `!==` guard, so the files always differ when it runs
  // (mutation-verified — both spellings pass the full suite).
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.startLine - b.startLine;
}
