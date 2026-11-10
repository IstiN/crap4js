// Helper steps for `diff-check`: diff-scoped `method-size`, `loc`,
// `component-size`, ignore-comment filtering, and `--new-duplicates-only`
// base-revision clone fingerprint comparison (Issues #1, #2, #3, #4, #6).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { componentSizeViolations } from './componentSize.js';
import { isGateEnabled } from './config.js';
import {
  COMPONENT_SIZE_GATE,
  CRAP_GATE,
  DUPLICATES_GATE,
  METHOD_SIZE_GATE,
} from './constants.js';
import { diffIntersects } from './diffLines.js';
import { duplicatesViolations } from './duplicates.js';
import { UTF8, toRelPath } from './files.js';
import { filterIgnored } from './ignoreFilter.js';
import { locViolations } from './loc.js';
import { methodSizeViolations } from './methodSize.js';

const RULE_GATE_MAP = {
  [CRAP_GATE]: CRAP_GATE,
  duplication: DUPLICATES_GATE,
  [METHOD_SIZE_GATE]: METHOD_SIZE_GATE,
  loc: 'loc',
  [COMPONENT_SIZE_GATE]: COMPONENT_SIZE_GATE,
};

/**
 * Filter a list of diff-check violations through `ignoreFilter` according to
 * each violation's rule id.
 *
 * @param {object[]} violations
 * @param {string} projectRoot
 * @returns {object[]}
 */
export function filterDiffCheckViolations(violations, projectRoot) {
  return violations.filter((v) => {
    const gateId = RULE_GATE_MAP[v.rule];
    if (!gateId) return true;
    return filterIgnored({ violations: [v] }, gateId, projectRoot).violations.length > 0;
  });
}

/**
 * Diff-scoped `method-size` gate: checks only functions whose line range
 * intersects `changed`.
 *
 * @param {object} opts
 * @param {object} ctx
 * @param {Map<string, Set<number>>} changed
 * @param {object} configObj
 * @returns {object[]}
 */
export function diffMethodSizeStep(opts, ctx, changed, configObj) {
  if (opts.noMethodSize) return [];
  const files = [...changed.keys()].map((rel) => path.join(ctx.cwd, rel));
  const { violations } = methodSizeViolations(files, ctx.cwd, {
    maxLines: opts.maxMethodLines,
    maxParams: opts.maxParams,
    configObj,
    splitCallbacks: opts.splitCallbacks,
  });
  return violations
    .filter((v) => diffIntersects(changed, v.file, v.startLine ?? v.line, v.endLine ?? v.line))
    .map((v) => ({ rule: METHOD_SIZE_GATE, file: v.file, line: v.line, message: v.message }));
}

/**
 * Diff-scoped `loc` gate: checks only files present in `changed`.
 *
 * @param {object} opts
 * @param {object} ctx
 * @param {Map<string, Set<number>>} changed
 * @param {object} configObj
 * @returns {object[]}
 */
export function diffLocStep(opts, ctx, changed, configObj) {
  if (opts.noLoc) return [];
  const files = [...changed.keys()].map((rel) => path.join(ctx.cwd, rel));
  const { violations } = locViolations(files, ctx.cwd, {
    maxLines: opts.maxLines,
    configObj,
  });
  return violations.map((v) => ({
    rule: 'loc',
    file: v.file,
    line: 1,
    message: v.message,
  }));
}

/**
 * Diff-scoped `component-size` gate: checks only React function components
 * whose line range intersects `changed`.
 *
 * @param {object} opts
 * @param {object} ctx
 * @param {Map<string, Set<number>>} changed
 * @param {object} configObj
 * @returns {object[]}
 */
export function diffComponentSizeStep(opts, ctx, changed, configObj) {
  if (opts.noComponentSize) return [];
  const files = [...changed.keys()].map((rel) => path.join(ctx.cwd, rel));
  const { violations } = componentSizeViolations(files, ctx.cwd, {
    maxComplexity: opts.maxComplexity,
    maxCallbacks: opts.maxCallbacks,
    maxLines: opts.maxComponentLines,
    configObj,
  });
  return violations
    .filter((v) => diffIntersects(changed, v.file, v.startLine ?? v.line, v.endLine ?? v.line))
    .map((v) => ({ rule: COMPONENT_SIZE_GATE, file: v.file, line: v.line, message: v.message }));
}

/**
 * Compute the set of clone fingerprints that already existed at `base`
 * revision (`git show <base>:<rel>`), so `--new-duplicates-only` can treat
 * touched pre-existing duplicates as informational instead of failing.
 *
 * @param {string[]} files
 * @param {string} base
 * @param {string} cwd
 * @param {object} dupOpts
 * @param {Function} [spawn]
 * @returns {Set<string>}
 */
export function baseCloneFingerprints(files, base, cwd, dupOpts, spawn = spawnSync) {
  const reader = (absFile) => readFileAtRef(toRelPath(absFile, cwd), base, cwd, spawn);
  const { clones = [] } = duplicatesViolations(files, cwd, {
    ...dupOpts,
    readSource: reader,
  });
  return collectFingerprints(clones);
}

function collectFingerprints(clones) {
  const set = new Set();
  for (const c of clones) {
    if (c.fingerprint) set.add(c.fingerprint);
    for (const occ of c.occurrences) {
      addOccurrenceFingerprints(set, occ);
    }
  }
  return set;
}

function addOccurrenceFingerprints(set, occ) {
  if (occ.fingerprint) set.add(occ.fingerprint);
  for (const w of occ.windows ?? []) set.add(w);
}

function readFileAtRef(rel, ref, cwd, spawn) {
  const r = spawn('git', ['show', `${ref}:${rel}`], {
    cwd,
    encoding: UTF8,
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 && !r.error ? r.stdout : null;
}

/**
 * Filter `files` to those where the `duplicates` gate is enabled in `configObj`.
 *
 * @param {string[]} files
 * @param {string} cwd
 * @param {object} configObj
 * @returns {string[]}
 */
export function filterDuplicatesFiles(files, cwd, configObj) {
  if (!configObj) return files;
  return files.filter((f) => isGateEnabled(configObj, toRelPath(f, cwd), DUPLICATES_GATE));
}
