// `method-size` subcommand: fails methods longer than --max-lines body
// lines (default 60) or with more than --max-params parameters (default 6).
// Port of crap4dart's method_size gate (0.5.x) with the config flattened to
// CLI flags. Constructors are checked for the parameter count only
// (upstream rule); top-level functions and every other function-like entry
// are checked like methods. Body lines are `endLine - startLine + 1` and
// the violation carries the method's start line.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UTF8, gateFiles, toRelPath } from './files.js';
import { applyGateArg, runCheck } from './gateCommon.js';
import { isGateEnabled, loadConfig, resolvePathConfig } from './config.js';
import { CONSTRUCTOR, extractMethodsWithNodes } from './complexity.js';
import {
  CONFIG_OPT,
  MAX_LINES_FLAG,
  MAX_LINES_OPT,
  MAX_PARAMS_OPT,
  METHOD_SIZE_GATE,
  OVERRIDE_OPT,
} from './constants.js';

const MAX_LINES = 60;
const MAX_PARAMS = 6;

const GATE_FLAGS = {
  [MAX_LINES_FLAG]: MAX_LINES_OPT,
  '--max-params': MAX_PARAMS_OPT,
  '--config': CONFIG_OPT,
  '--override': OVERRIDE_OPT,
};
const NUMBER_FLAGS = new Set([MAX_LINES_FLAG, '--max-params']);

/**
 * Method-size violations across files.
 *
 * @param {string[]} files  absolute paths.
 * @param {string} projectRoot
 * @param {{ maxLines?: number, maxParams?: number, configObj?: object, splitCallbacks?: boolean }} [opts]
 * @returns {{violations: Array<{file, line, startLine, endLine, message}>, checked: number}}
 */
export function methodSizeViolations(
  files,
  projectRoot,
  { maxLines = MAX_LINES, maxParams = MAX_PARAMS, configObj = null, splitCallbacks = false } = {},
) {
  const violations = [];
  let checked = 0;
  for (const file of files) {
    const rel = toRelPath(file, projectRoot);
    if (configObj && !isGateEnabled(configObj, rel, 'methodSize')) continue;
    const limits = resolveMethodLimits(configObj, rel, maxLines, maxParams);
    const source = readFileSync(file, UTF8);
    const methods = extractMethodsWithNodes(source, {
      ext: path.extname(file),
      includeConstructors: true,
      splitCallbacks,
    });
    for (const m of methods) {
      checked++;
      pushSize(violations, rel, m, m.node.kind === CONSTRUCTOR, limits.maxLines, limits.maxParams);
    }
  }
  return { violations, checked };
}

function resolveMethodLimits(configObj, rel, maxLines, maxParams) {
  if (!configObj) return { maxLines, maxParams };
  const resolved = resolvePathConfig(configObj, rel, { maxMethodLines: maxLines, maxParams });
  return {
    maxLines: resolved.maxMethodLines ?? maxLines,
    maxParams: resolved.maxParams ?? maxParams,
  };
}

// One entry, two limits: a constructor skips the line check (upstream
// checks constructors for parameters only), everything over the param
// count is flagged at the method's start line.
function pushSize(out, rel, m, isConstructor, maxLines, maxParams) {
  const span = { file: rel, line: m.startLine, startLine: m.startLine, endLine: m.endLine };
  if (!isConstructor) {
    const lines = m.endLine - m.startLine + 1;
    if (lines > maxLines) {
      out.push({ ...span, message: `${m.name} has ${lines} lines > max ${maxLines}` });
    }
  }
  const params = m.node.params.length;
  if (params > maxParams) {
    out.push({ ...span, message: `${m.name} has ${params} params > max ${maxParams}` });
  }
}

/**
 * One-line summary: `N violations in M methods over their size limits` on
 * violations, `M methods within their size limits` otherwise.
 */
export function methodSizeSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} methods within their size limits`
    : `${violations} violations in ${checked} methods over their size limits`;
}

/**
 * Parse `method-size` arguments into `{ maxLines, maxParams, config,
 * override, paths }`. Unknown flags and non-integer limits are usage errors.
 *
 * @param {string[]} argv
 */
export function parseMethodSizeArgs(argv) {
  const opts = { maxLines: MAX_LINES, maxParams: MAX_PARAMS, config: undefined, override: [], paths: [] };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(opts, argv[i], argv, i, GATE_FLAGS, NUMBER_FLAGS);
  }
  if (!Number.isInteger(opts.maxLines)) throw new Error(`--max-lines must be an integer: ${opts.maxLines}`);
  if (!Number.isInteger(opts.maxParams)) throw new Error(`--max-params must be an integer: ${opts.maxParams}`);
  return opts;
}

/**
 * The `method-size` command body. Returns exit code 2 iff violations exist.
 */
export function runMethodSize(argv, ctx) {
  const opts = parseMethodSizeArgs(argv);
  const configObj = loadConfig(ctx.cwd, { configPath: opts.config, overrides: opts.override });
  return runCheck(
    ctx,
    gateFiles(opts.paths, ctx.cwd),
    (files, root) => methodSizeViolations(files, root, { ...opts, configObj }),
    methodSizeSummary,
    METHOD_SIZE_GATE,
  );
}
