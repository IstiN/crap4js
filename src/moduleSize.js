// `module-size` subcommand: fails modules longer than --max-lines physical
// lines (default 800) or declaring more than --max-functions top-level
// functions (default 40). A god module hides split responsibilities even
// when every function in it is small, so the per-function CRAP ratchet
// alone never flags it.
//
// Top-level functions are the Program body's function declarations
// (including export-wrapped ones) plus top-level variable declarators
// initialized with a function or arrow expression.
//
// Ratchet mode (`--baseline FILE`): modules already over a limit are pinned
// in FILE as `{ "modules": { "<rel>": { "lines": N, "functions": N } } }`;
// a pinned module fails only when it GROWS above its pin (either metric),
// an unpinned module is held to the limits. `--write-baseline` records the
// current offenders and passes. Shrinking modules are reported as
// `improved` so the pin can be lowered.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { UTF8, gateFiles, toRelPath } from './files.js';
import { applyGateArg, runCheck } from './gateCommon.js';
import { globToRegExp } from './bannedImports.js';
import { parseSource } from './complexity.js';
import { lineCount } from './loc.js';
import {
  ARROW_FUNCTION_EXPRESSION,
  EXCLUDE,
  EXPORT_DEFAULT_DECLARATION,
  EXPORT_NAMED_DECLARATION,
  FUNCTION_DECLARATION,
  FUNCTION_EXPRESSION,
  MAX_LINES_FLAG,
  MAX_LINES_OPT,
  VARIABLE_DECLARATION,
} from './constants.js';

export const MODULE_MAX_LINES = 800;
export const MODULE_MAX_FUNCTIONS = 40;
export const MODULE_SIZE_GATE = 'module-size';

const GATE_FLAGS = {
  [MAX_LINES_FLAG]: MAX_LINES_OPT,
  '--max-functions': 'maxFunctions',
  '--exclude': EXCLUDE,
  '--baseline': 'baseline',
};
const NUMBER_FLAGS = new Set([MAX_LINES_FLAG, '--max-functions']);
const FN_INIT = new Set([FUNCTION_EXPRESSION, ARROW_FUNCTION_EXPRESSION]);

/**
 * Count top-level functions of a parsed Program.
 *
 * @param {object} program  Babel Program node.
 * @returns {number}
 */
export function topLevelFunctionCount(program) {
  let n = 0;
  for (const stmt of program.body) {
    const s = unwrapExport(stmt);
    if (!s) continue;
    if (s.type === FUNCTION_DECLARATION) n++;
    else if (s.type === VARIABLE_DECLARATION) n += s.declarations.filter((d) => d.init && FN_INIT.has(d.init.type)).length;
  }
  return n;
}

function unwrapExport(stmt) {
  if (stmt.type === EXPORT_NAMED_DECLARATION || stmt.type === EXPORT_DEFAULT_DECLARATION) {
    return stmt.declaration ?? null;
  }
  return stmt;
}

/**
 * Size of one module source: physical lines and top-level functions.
 *
 * @param {string} source
 * @param {string} [ext]
 * @returns {{lines: number, functions: number}}
 */
export function measureModule(source, ext) {
  const ast = parseSource(source, ext);
  return { lines: lineCount(source), functions: topLevelFunctionCount(ast.program) };
}

/**
 * Verdict for one module against the limits and its optional pin.
 * Returns `{ violation?: string, improved?: string }`.
 */
export function judgeModule(size, pin, limits) {
  const over = overLimits(size, pinnedLimits(pin, limits));
  if (over.length) return { violation: (pin ? 'grew above pin: ' : '') + over.join(', ') };
  return shrankBelow(size, pin) ? { improved: `${size.lines}/${size.functions} below pin ${pin.lines}/${pin.functions}` } : {};
}

// Effective limits: a pin can only raise a limit, never lower it.
function pinnedLimits(pin, { maxLines, maxFunctions }) {
  if (!pin) return { maxLines, maxFunctions };
  return { maxLines: Math.max(pin.lines, maxLines), maxFunctions: Math.max(pin.functions, maxFunctions) };
}

function overLimits(size, { maxLines, maxFunctions }) {
  const over = [];
  if (size.lines > maxLines) over.push(`${size.lines} lines > max ${maxLines}`);
  if (size.functions > maxFunctions) over.push(`${size.functions} top-level functions > max ${maxFunctions}`);
  return over;
}

function shrankBelow(size, pin) {
  return Boolean(pin) && (size.lines < pin.lines || size.functions < pin.functions);
}

/**
 * Measure every selected module (exclude globs applied).
 *
 * @returns {Map<string, {lines: number, functions: number}>}  rel → size.
 */
export function measureModules(files, projectRoot, exclude = []) {
  const globs = exclude.map(globToRegExp);
  const sizes = new Map();
  for (const file of files) {
    const rel = toRelPath(file, projectRoot);
    if (globs.some((g) => g.test(rel))) continue;
    sizes.set(rel, measureModule(readFileSync(file, UTF8), path.extname(file)));
  }
  return sizes;
}

/**
 * Module-size violations across files.
 *
 * @param {Map<string, {lines, functions}>} sizes
 * @param {{maxLines: number, maxFunctions: number, pins?: object, onImproved?: Function}} opts
 * @returns {{violations: Array<{file, message}>, checked: number}}
 */
export function moduleSizeViolations(sizes, opts) {
  const violations = [];
  const pins = opts.pins ?? {};
  for (const [rel, size] of sizes) {
    const v = judgeModule(size, pins[rel], opts);
    if (v.violation) violations.push({ file: rel, message: v.violation });
    else if (v.improved && opts.onImproved) opts.onImproved(rel, v.improved);
  }
  return { violations, checked: sizes.size };
}

/** Baseline document pinning every module currently over a limit. */
export function buildModuleBaseline(sizes, { maxLines, maxFunctions }) {
  const modules = {};
  for (const rel of [...sizes.keys()].sort()) {
    const s = sizes.get(rel);
    if (s.lines > maxLines || s.functions > maxFunctions) modules[rel] = { lines: s.lines, functions: s.functions };
  }
  return { version: 1, maxLines, maxFunctions, modules };
}

/** Read and validate a module-size baseline file. */
export function readModuleBaseline(file) {
  const doc = JSON.parse(readFileSync(file, UTF8));
  if (!doc || typeof doc.modules !== 'object' || doc.modules === null) {
    throw new Error(`Invalid module-size baseline ${file}: missing "modules"`);
  }
  return doc;
}

export function moduleSizeSummary({ violations, checked }, { maxLines, maxFunctions }) {
  return violations === 0
    ? `${checked} modules within ${maxLines} lines / ${maxFunctions} top-level functions`
    : `${violations}/${checked} modules over ${maxLines} lines / ${maxFunctions} top-level functions (or above their pin)`;
}

/**
 * Parse `module-size` arguments.
 *
 * @param {string[]} argv
 */
export function parseModuleSizeArgs(argv) {
  const opts = {
    maxLines: MODULE_MAX_LINES,
    maxFunctions: MODULE_MAX_FUNCTIONS,
    exclude: [],
    baseline: undefined,
    writeBaseline: false,
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write-baseline') {
      opts.writeBaseline = true;
      continue;
    }
    i = applyGateArg(opts, argv[i], argv, i, GATE_FLAGS, NUMBER_FLAGS);
  }
  if (Array.isArray(opts.baseline)) opts.baseline = opts.baseline[opts.baseline.length - 1];
  if (opts.writeBaseline && !opts.baseline) throw new Error('--write-baseline requires --baseline <file>');
  return opts;
}

/**
 * The `module-size` command body. Exit 2 iff violations exist.
 */
export function runModuleSize(argv, ctx) {
  const opts = parseModuleSizeArgs(argv);
  const files = gateFiles(opts.paths, ctx.cwd);
  if (opts.writeBaseline) {
    const doc = buildModuleBaseline(measureModules(files, ctx.cwd, opts.exclude), opts);
    writeFileSync(path.resolve(ctx.cwd, opts.baseline), JSON.stringify(doc, null, 2) + '\n');
    ctx.out.write(`Baseline written: ${opts.baseline} (${Object.keys(doc.modules).length} modules pinned)\n`);
    return 0;
  }
  const pins = opts.baseline ? readModuleBaseline(path.resolve(ctx.cwd, opts.baseline)).modules : {};
  const onImproved = (rel, msg) => ctx.out.write(`improved    ${rel}: ${msg}\n`);
  return runCheck(
    ctx,
    files,
    (fs, root) => moduleSizeViolations(measureModules(fs, root, opts.exclude), { ...opts, pins, onImproved }),
    (r) => moduleSizeSummary(r, opts),
    MODULE_SIZE_GATE,
  );
}
