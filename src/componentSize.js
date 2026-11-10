// `component-size` subcommand: flags React function components (PascalCase
// function/arrow declarations returning JSX) that exceed configurable limits
// on summed complexity (WMC-style, default 40), inner callback + hook count
// (default 10), or component body length (default 200 lines). Analogue of
// `class-size` for React function components (Issue #1).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UTF8, gateFiles, toRelPath } from './files.js';
import { applyGateArg, runCheck } from './gateCommon.js';
import { isGateEnabled, loadConfig, resolvePathConfig } from './config.js';
import {
  ARROW_FUNCTION_EXPRESSION,
  CALL,
  COMPONENT_SIZE_GATE,
  CONFIG_OPT,
  FUNCTION_DECLARATION,
  FUNCTION_EXPRESSION,
  MAX_CALLBACKS_OPT,
  MAX_COMPLEXITY_OPT,
  MAX_LINES_FLAG,
  MAX_LINES_OPT,
  OVERRIDE_OPT,
  VARIABLE_DECLARATOR,
  childrenOf,
  isNode,
} from './constants.js';
import { computeComplexity, parseSource } from './complexity.js';
import { calleeIdentifier } from './explain.js';

export const DEFAULT_MAX_COMPONENT_COMPLEXITY = 40;
export const DEFAULT_MAX_COMPONENT_CALLBACKS = 10;
export const DEFAULT_MAX_COMPONENT_LINES = 200;

const FUNCTION_LIKE = new Set([FUNCTION_EXPRESSION, ARROW_FUNCTION_EXPRESSION]);
const JSX_TYPES = new Set(['JSXElement', 'JSXFragment']);
const PASCAL_CASE_RE = /^[A-Z][A-Za-z0-9]*$/;
const HOOK_CALL_RE = /^use[A-Z0-9]/;

const VALUE_FLAGS = {
  '--max-complexity': MAX_COMPLEXITY_OPT,
  '--max-callbacks': MAX_CALLBACKS_OPT,
  [MAX_LINES_FLAG]: MAX_LINES_OPT,
  '--config': CONFIG_OPT,
  '--override': OVERRIDE_OPT,
};
const NUMBER_FLAGS = new Set(['--max-complexity', '--max-callbacks', MAX_LINES_FLAG]);

/**
 * Find every React function component (PascalCase function/arrow returning
 * JSX) in a parsed `program` and compute its WMC complexity, inner callback +
 * hook count, and line span.
 *
 * @param {object} program  parsed Program node.
 * @returns {Array<{name: string, line: number, startLine: number, endLine: number, lines: number, callbacks: number, complexity: number}>}
 */
export function componentTotals(program) {
  const components = [];
  for (const { name, fnNode } of candidateFunctions(program)) {
    if (!PASCAL_CASE_RE.test(name) || !containsJsx(fnNode.body)) continue;
    components.push(measureComponent(name, fnNode));
  }
  return components;
}

function candidateFunctions(program) {
  const out = [];
  const visit = (n) => {
    if (!isNode(n)) return;
    const cand = extractCandidate(n);
    if (cand) out.push(cand);
    for (const c of childrenOf(n)) visit(c);
  };
  visit(program);
  return out;
}

function extractCandidate(n) {
  if (n.type === FUNCTION_DECLARATION && n.id?.name && n.body) {
    return { name: n.id.name, fnNode: n };
  }
  if (n.type === VARIABLE_DECLARATOR && n.id?.name) {
    const fnNode = unwrapComponentFn(n.init);
    if (fnNode) return { name: n.id.name, fnNode };
  }
  return null;
}

function unwrapComponentFn(init) {
  if (!init) return null;
  if (init.body && FUNCTION_LIKE.has(init.type)) return init;
  if (init.type === CALL && init.arguments?.length > 0) {
    return unwrapComponentFn(init.arguments[0]);
  }
  return null;
}

function containsJsx(node) {
  if (!isNode(node)) return false;
  if (JSX_TYPES.has(node.type)) return true;
  return childrenOf(node).some(containsJsx);
}

function measureComponent(name, fnNode) {
  const startLine = fnNode.loc.start.line;
  const endLine = fnNode.loc.end.line;
  const lines = endLine - startLine + 1;
  const { callbacks, complexity } = scanComponentBody(fnNode.body);
  return { name, line: startLine, startLine, endLine, lines, callbacks, complexity };
}

function scanComponentBody(body) {
  let callbacks = 0;
  let complexity = computeComplexity(body);
  const visit = (n) => {
    if (!isNode(n)) return;
    if (isInnerFunction(n)) {
      callbacks++;
      complexity += nestedDeclComplexity(n);
    } else if (isBareHookCall(n)) {
      callbacks++;
    }
    for (const c of childrenOf(n)) visit(c);
  };
  visit(body);
  return { callbacks, complexity };
}

function nestedDeclComplexity(n) {
  return n.type === FUNCTION_DECLARATION && n.id && n.body ? computeComplexity(n.body) : 0;
}

function isInnerFunction(n) {
  return (n.type === FUNCTION_DECLARATION || FUNCTION_LIKE.has(n.type)) && Boolean(n.body);
}

function isBareHookCall(n) {
  if (n.type !== CALL) return false;
  const name = calleeIdentifier(n.callee);
  return Boolean(name && HOOK_CALL_RE.test(name) && !n.arguments.some(isInnerFunction));
}

/**
 * Component-size violations across files.
 *
 * @param {string[]} files  absolute paths.
 * @param {string} projectRoot
 * @param {{ maxComplexity?: number, maxCallbacks?: number, maxLines?: number, configObj?: object, resolveLimits?: (rel: string) => object }} [opts]
 * @returns {{violations: Array<{file, line, startLine, endLine, message}>, checked: number}}
 */
export function componentSizeViolations(files, projectRoot, opts = {}) {
  const violations = [];
  let checked = 0;
  for (const file of files) {
    const rel = toRelPath(file, projectRoot);
    if (opts.configObj && !isGateEnabled(opts.configObj, rel, COMPONENT_SIZE_GATE)) continue;
    const limits = resolveComponentLimits(rel, opts);
    const ast = parseSource(readFileSync(file, UTF8), path.extname(file));
    for (const c of componentTotals(ast.program)) {
      checked++;
      pushComponentViolations(c, rel, limits, violations);
    }
  }
  return { violations, checked };
}

function resolveComponentLimits(rel, opts) {
  if (opts.resolveLimits) return opts.resolveLimits(rel);
  if (!opts.configObj) return opts;
  return resolvePathConfig(opts.configObj, rel, opts);
}

function pushComponentViolations(c, file, limits = {}, out) {
  const maxComplexity = limits.maxComplexity ?? DEFAULT_MAX_COMPONENT_COMPLEXITY;
  const maxCallbacks = limits.maxCallbacks ?? DEFAULT_MAX_COMPONENT_CALLBACKS;
  const maxLines = limits.maxComponentLines ?? limits.maxLines ?? DEFAULT_MAX_COMPONENT_LINES;
  const span = { file, line: c.line, startLine: c.startLine, endLine: c.endLine };
  if (c.complexity > maxComplexity) {
    out.push({ ...span, message: `${c.name} complexity=${c.complexity} > max ${maxComplexity}` });
  }
  if (c.callbacks > maxCallbacks) {
    out.push({ ...span, message: `${c.name} has ${c.callbacks} callbacks/hooks > max ${maxCallbacks}` });
  }
  if (c.lines > maxLines) {
    out.push({ ...span, message: `${c.name} has ${c.lines} lines > max ${maxLines}` });
  }
}

/**
 * One-line summary for `component-size`.
 *
 * @param {{ violations: number, checked: number }} counts
 * @param {object} [opts]
 * @returns {string}
 */
export function componentSizeSummary({ violations, checked }, opts = {}) {
  const maxC = opts.maxComplexity ?? DEFAULT_MAX_COMPONENT_COMPLEXITY;
  const maxCb = opts.maxCallbacks ?? DEFAULT_MAX_COMPONENT_CALLBACKS;
  const maxL = opts.maxLines ?? DEFAULT_MAX_COMPONENT_LINES;
  const spec = `${maxCb} callbacks/complexity ${maxC}/${maxL} lines`;
  return violations === 0
    ? `${checked} components within ${spec}`
    : `${violations} violations in ${checked} components over ${spec}`;
}

/**
 * Parse `component-size` arguments.
 *
 * @param {string[]} argv
 * @returns {object}
 */
export function parseComponentSizeArgs(argv) {
  const opts = {
    maxComplexity: DEFAULT_MAX_COMPONENT_COMPLEXITY,
    maxCallbacks: DEFAULT_MAX_COMPONENT_CALLBACKS,
    maxLines: DEFAULT_MAX_COMPONENT_LINES,
    config: undefined,
    override: [],
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(opts, argv[i], argv, i, VALUE_FLAGS, NUMBER_FLAGS);
  }
  for (const flag of NUMBER_FLAGS) {
    const key = VALUE_FLAGS[flag];
    if (!Number.isInteger(opts[key])) throw new Error(`${flag} must be an integer: ${opts[key]}`);
  }
  return opts;
}

/**
 * The `component-size` command body. Returns exit code 2 iff violations exist.
 *
 * @param {string[]} argv
 * @param {object} ctx
 * @returns {number}
 */
export function runComponentSize(argv, ctx) {
  const opts = parseComponentSizeArgs(argv);
  const configObj = loadConfig(ctx.cwd, { configPath: opts.config, overrides: opts.override });
  return runCheck(
    ctx,
    gateFiles(opts.paths, ctx.cwd),
    (files, root) => componentSizeViolations(files, root, { ...opts, configObj }),
    (r) => componentSizeSummary(r, opts),
    COMPONENT_SIZE_GATE,
  );
}
