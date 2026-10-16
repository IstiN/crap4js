// CRAP baseline ratchet.
//
// A baseline is a JSON snapshot of per-function CRAP scores. Comparing a fresh
// analysis against it lets a project freeze today's debt and only ever go down:
//   - a function present in the baseline fails if its CRAP grows (beyond a
//     small epsilon that absorbs float noise);
//   - a function absent from the baseline (new or renamed) fails if its CRAP
//     exceeds the threshold;
//   - functions whose CRAP dropped are reported as improvements.
//
// Keys are `file::name`; duplicate names within a file get a `#n` suffix in
// source order, so the key survives line shifts but not reordering of
// same-named functions (acceptable — those are rare and fail safe as "new").

import { readFileSync, writeFileSync } from 'node:fs';

export const BASELINE_VERSION = 1;
// Absorbs rounding/float noise only; any real change in complexity or coverage moves CRAP by more.
const EPSILON = 0.5;

/** Stable key per metric: file::name with #n for repeated names in a file. */
export function keyMetrics(metrics) {
  const byFile = new Map();
  const sorted = [...metrics].sort((a, b) =>
    a.file === b.file ? a.startLine - b.startLine : a.file < b.file ? -1 : 1,
  );
  const out = [];
  for (const m of sorted) {
    const seen = byFile.get(m.file) || new Map();
    byFile.set(m.file, seen);
    const n = seen.get(m.methodName) || 0;
    seen.set(m.methodName, n + 1);
    out.push({ key: `${m.file}::${m.methodName}${n ? `#${n + 1}` : ''}`, metric: m });
  }
  return out;
}

const round = (x) => Math.round(x * 10) / 10;

/**
 * Builds the baseline document from analyzed metrics (numeric CRAP only).
 *
 * With a `threshold` only functions ABOVE it are recorded: a function that is absent from the
 * baseline is already held to `--threshold` by the ratchet, so recording the (thousands of)
 * compliant ones adds size and merge conflicts without adding protection. Trade-off: a compliant
 * function may drift up to the threshold; omit the threshold to ratchet every function.
 */
export function buildBaseline(metrics, threshold) {
  const functions = {};
  let max = 0;
  for (const { key, metric } of keyMetrics(metrics)) {
    if (metric.crapScore == null) continue;
    if (metric.crapScore > max) max = metric.crapScore;
    if (threshold != null && metric.crapScore <= threshold) continue;
    functions[key] = round(metric.crapScore);
  }
  const sortedKeys = Object.keys(functions).sort();
  const ordered = {};
  for (const k of sortedKeys) ordered[k] = functions[k];
  return { version: BASELINE_VERSION, maxCrap: round(max), functions: ordered };
}

export function readBaseline(path) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (!doc || typeof doc.functions !== 'object') {
    throw new Error(`Invalid baseline file ${path}: missing "functions"`);
  }
  return doc;
}

export function writeBaseline(path, doc) {
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
}

/**
 * Compares metrics against a baseline.
 * @returns {{ regressions: object[], newOverThreshold: object[], improvements: object[], removed: string[] }}
 */
export function compareBaseline(metrics, baseline, threshold) {
  const regressions = [];
  const newOverThreshold = [];
  const improvements = [];
  const present = new Set();
  for (const { key, metric } of keyMetrics(metrics)) {
    if (metric.crapScore == null) continue;
    present.add(key);
    const score = round(metric.crapScore);
    const before = baseline.functions[key];
    if (before === undefined) {
      if (score > threshold) newOverThreshold.push({ key, score });
    } else if (score > before + EPSILON) {
      regressions.push({ key, before, score });
    } else if (score < before - EPSILON) {
      improvements.push({ key, before, score });
    }
  }
  const removed = Object.keys(baseline.functions).filter((k) => !present.has(k));
  return { regressions, newOverThreshold, improvements, removed };
}

/** Human-readable ratchet verdict block. */
export function formatComparison(result, threshold) {
  const lines = ['', 'CRAP Ratchet', '============'];
  const { regressions, newOverThreshold, improvements, removed } = result;
  for (const r of regressions) lines.push(`REGRESSION  ${r.key}: ${r.before} -> ${r.score}`);
  for (const n of newOverThreshold) lines.push(`NEW > ${threshold}  ${n.key}: ${n.score}`);
  for (const i of improvements) lines.push(`improved    ${i.key}: ${i.before} -> ${i.score}`);
  lines.push(
    `${regressions.length} regression(s), ${newOverThreshold.length} new over threshold, ` +
      `${improvements.length} improvement(s), ${removed.length} removed`,
  );
  if (!regressions.length && !newOverThreshold.length && (improvements.length || removed.length)) {
    lines.push('Ratchet passed with improvements — re-run with --write-baseline to lock them in.');
  }
  return lines.join('\n') + '\n';
}

/**
 * Ratchets a baseline DOWN. Blocked (nothing to write) when the code regressed against it or has a
 * new function over the threshold. Otherwise each remaining function keeps min(old, now) — jitter
 * inside the compare epsilon never raises it — and functions that are gone or now at/below the
 * threshold are dropped (the threshold holds them). Never adds an entry.
 *
 * @returns {{ blocked: boolean, result: object, doc?: object, changed?: boolean }}
 */
export function ratchetDown(metrics, baseline, threshold) {
  const result = compareBaseline(metrics, baseline, threshold);
  if (result.regressions.length || result.newOverThreshold.length) return { blocked: true, result };
  const current = new Map();
  for (const { key, metric } of keyMetrics(metrics)) {
    if (metric.crapScore != null) current.set(key, round(metric.crapScore));
  }
  const functions = {};
  let max = 0;
  for (const key of Object.keys(baseline.functions).sort()) {
    const now = current.get(key);
    if (now === undefined || now <= threshold) continue;
    const value = Math.min(baseline.functions[key], now);
    functions[key] = value;
    if (value > max) max = value;
  }
  const doc = { version: BASELINE_VERSION, maxCrap: round(max), functions };
  const changed = JSON.stringify(doc.functions) !== JSON.stringify(baseline.functions);
  return { blocked: false, result, doc, changed };
}
