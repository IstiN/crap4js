// Cyclomatic + cognitive complexity and method extraction for
// JavaScript/JSX/Flow/TS source.
//
// Uses @babel/parser (plugins routed by file extension — flow and typescript
// cannot be enabled together) to parse, then walks the AST to find every
// function-like entry (FunctionDeclaration, class ClassMethod, assigned
// FunctionExpression or ArrowFunctionExpression) and computes its complexity
// (cyclomatic by default, or cognitive — SonarSource v1.2 — via `metric`).
//
// Cyclomatic counting rules (base 1, +1 each): IfStatement, ForStatement,
// ForInStatement, ForOfStatement, WhileStatement, DoWhileStatement,
// CatchClause, SwitchCase (including `default`), ConditionalExpression, and
// LogicalExpression (`&&`, `||`).
//
// Lambda/arrow bodies count TOWARDS the enclosing function (we descend into
// them when computing the parent's complexity). Nested NAMED
// FunctionDeclarations are skipped — they are reported as their own entries.

import { parse } from '@babel/parser';
import {
  ANON,
  ARROW_FUNCTION_EXPRESSION,
  CALL,
  CLASS_METHOD,
  CLASS_PRIVATE_METHOD,
  COGNITIVE,
  CONDITIONAL_EXPRESSION,
  CONFIG_OPT,
  CONSTRUCTOR,
  CYCLOMATIC,
  EXPLAIN_OPT,
  EXPORT_DEFAULT_DECLARATION,
  EXPORT_NAMED_DECLARATION,
  FUNCTION_DECLARATION,
  FUNCTION_EXPRESSION,
  IDENT,
  IF_STATEMENT,
  IMPORT_DECLARATION,
  LOGICAL_EXPRESSION,
  MEMBER,
  METRIC_OPT,
  NEW_EXPRESSION,
  NUMERIC_LITERAL,
  OVERRIDE_OPT,
  REGEX_LITERAL,
  SKIP_KEYS,
  SPLIT_CALLBACKS_OPT,
  STRING,
  STRING_LITERAL,
  TAGGED_TEMPLATE,
  TEMPLATE_LITERAL,
  VARIABLE_DECLARATOR,
  childrenOf,
  isNode,
  keyName,
  leftName,
} from './constants.js';
import { UTF8, gateFiles, toRelPath } from './files.js';
import { applyGateArg, runCheck } from './gateCommon.js';
import { loadConfig, resolvePathConfig } from './config.js';
import {
  explainComplexity,
  formatExplanation,
  qualifyName,
  resolveAssignedFunction,
  resolveHookEffectCallback,
} from './explain.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export {
  ANON,
  ARROW_FUNCTION_EXPRESSION,
  CALL,
  CLASS_METHOD,
  CLASS_PRIVATE_METHOD,
  COGNITIVE,
  CONSTRUCTOR,
  EXPORT_NAMED_DECLARATION,
  FUNCTION_DECLARATION,
  FUNCTION_EXPRESSION,
  IDENT,
  IMPORT_DECLARATION,
  MEMBER,
  NEW_EXPRESSION,
  NUMERIC_LITERAL,
  REGEX_LITERAL,
  SKIP_KEYS,
  STRING_LITERAL,
  TAGGED_TEMPLATE,
  TEMPLATE_LITERAL,
  childrenOf,
  isNode,
  keyName,
  leftName,
} from './constants.js';

const COMPLEXITY_TYPES = new Set([
  IF_STATEMENT,
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'CatchClause',
  'SwitchCase',
  CONDITIONAL_EXPRESSION,
]);

const LOGICAL_OPS = new Set(['&&', '||']);

const FUNCTION_LIKE = new Set([FUNCTION_EXPRESSION, ARROW_FUNCTION_EXPRESSION]);

// Shared by all plugin routes; only the type-syntax and jsx plugins differ
// because @babel/parser refuses to combine flow and typescript, and enabling
// jsx on plain `.ts` files breaks legacy `<Type>expr` angle-bracket casts.
// decorators-legacy plus decoratorAutoAccessors cover stage-3 decorator
// syntax (`accessor` fields included).
const BASE_PLUGINS = [
  'decorators-legacy', 'decoratorAutoAccessors', 'classProperties',
  'classPrivateProperties', 'classPrivateMethods', 'objectRestSpread',
  'optionalChaining', 'nullishCoalescingOperator', 'dynamicImport',
  'exportDefaultFrom', 'asyncGenerators', 'topLevelAwait',
];
const FLOW_PLUGINS = ['jsx', ...BASE_PLUGINS, 'flow'];
const TS_PLUGINS = [...BASE_PLUGINS, 'typescript'];
const TSX_PLUGINS = ['jsx', ...BASE_PLUGINS, 'typescript'];

function pluginsForExt(ext) {
  if (ext === '.ts') return TS_PLUGINS;
  if (ext === '.tsx') return TSX_PLUGINS;
  return FLOW_PLUGINS;
}

/**
 * Parse source and return every method/function entry with its complexity.
 *
 * @param {string} source  JavaScript/JSX/Flow/TypeScript source code.
 * @param {{ ext?: string, metric?: string }} [opts]  File extension used to
 *   route the flow-vs-typescript plugin (`.ts`/`.tsx` → typescript, else
 *   flow); `metric` selects `cyclomatic` (default) or `cognitive` scoring.
 * @returns {Array<{name: string, startLine: number, endLine: number, complexity: number}>}
 */
export function extractMethods(source, { ext, metric, splitCallbacks, explain } = {}) {
  // Strip the AST node reference — external callers only need the summary.
  return parseMethods(source, ext, metric, undefined, { splitCallbacks, explain }).map(({ node, ...m }) => m);
}

/**
 * Same walk as extractMethods, but each entry also keeps a reference to the
 * function AST node. Used by the `profile` command's instrumenter to wrap
 * the exact bodies the analyzer reports. `includeConstructors` adds class
 * constructors as entries (kind `constructor` on the node) — the
 * method-size gate checks their parameter count only.
 *
 * @param {string} source
 * @param {{ ext?: string, includeConstructors?: boolean, splitCallbacks?: boolean }} [opts]
 * @returns {Array<{name: string, startLine: number, endLine: number, complexity: number, node: object}>}
 */
export function extractMethodsWithNodes(source, { ext, includeConstructors, splitCallbacks } = {}) {
  return parseMethods(source, ext, undefined, includeConstructors ? SIZE_HANDLERS : undefined, { splitCallbacks });
}

function parseMethods(source, ext, metric, handlers, { splitCallbacks = false, explain = false } = {}) {
  const ast = parseSource(source, ext);
  const methods = [];
  const state = { splitCallbacks, effectCounts: new Map(), fnScope: null };
  // @babel/parser wraps the Program in a File node; the walker starts at Program.
  walkForEntries(ast.program, null, methods, handlers, state);
  const extracted = new Set(methods.map((m) => m.node));
  const scoreOpts = { extractedNodes: extracted, splitCallbacks };
  const complexityOf = metric === COGNITIVE
    ? (body) => computeCognitive(body, scoreOpts)
    : (body) => computeComplexity(body, scoreOpts);
  for (const m of methods) {
    m.complexity = complexityOf(m.node.body);
    if (explain) m.breakdown = explainComplexity(m.node.body, { metric, extractedNodes: extracted });
  }
  return methods;
}

function parseWith(source, ext, tokens) {
  const plugins = pluginsForExt(ext);
  return parse(source, {
    sourceType: 'module',
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins,
    tokens,
  });
}

/**
 * Parse source with the port's standard plugin routing. Shared by the
 * gate-check subcommands so every check sees the same AST.
 *
 * @param {string} source
 * @param {string} [ext]  File extension routing flow vs typescript plugins.
 */
export function parseSource(source, ext) {
  return parseWith(source, ext, false);
}

/**
 * Parse source with the port's standard plugin routing, keeping the whole
 * token stream plus the Program AST. Shared by tokenizeSource and the
 * duplicates gate's Type-2 normalization pass, which reads function-local
 * scopes out of the AST while masking the token lexemes.
 *
 * @param {string} source
 * @param {string} [ext]  File extension routing flow vs typescript plugins.
 * @returns {{tokens: object[], program: object}}
 */
export function parseTokenized(source, ext) {
  const ast = parseWith(source, ext, true);
  return { tokens: ast.tokens, program: ast.program };
}

// @babel/parser emits comments inside the token stream (tokens: true) as
// bare strings (`CommentLine`/`CommentBlock`), while real tokens carry a
// type object — skipped like upstream skips its CommentToken nodes.
function isCommentToken(t) {
  return typeof t.type === STRING;
}
/**
 * Tokenize source with the port's standard plugin routing: every token's
 * raw lexeme plus its start line, comments and the EOF sentinel skipped.
 * Shared by the duplicates gate, which scans lexeme windows.
 *
 * @param {string} source
 * @param {string} [ext]  File extension routing flow vs typescript plugins.
 * @returns {Array<{value: string, line: number}>}
 */
export function tokenizeSource(source, ext) {
  const { tokens } = parseTokenized(source, ext);
  return tokens
    .filter((t) => t.type.label !== 'eof' && !isCommentToken(t))
    .map((t) => ({ value: source.slice(t.start, t.end), line: t.loc.start.line }));
}

// Sentinel: a handler returns this when it has already descended into the
// node's children itself and the generic child traversal should be skipped.
const SKIP = Symbol('skip');

// One handler per AST node type that yields a method entry or controls how
// its children are traversed. Each handler is small (CC ≤ 4); walkForEntries
// is just the dispatch.
const HANDLERS = {
  FunctionDeclaration(node, className, methods, handlers, state) {
    if (!node.body) return;
    const name = qualifyName(state?.fnScope, node.id?.name ?? ANON, state?.splitCallbacks);
    return pushAndDescend(node, name, className, methods, handlers, state);
  },
  // @babel/parser names class methods ClassMethod/ClassPrivateMethod (acorn
  // called them MethodDefinition). The method node itself carries body/params,
  // so makeMethod reads loc/complexity off it directly.
  ClassMethod: classMethodHandler,
  ClassPrivateMethod: classMethodHandler,
  VariableDeclarator(node, className, methods, handlers, state) {
    const fn = resolveAssignedFunction(node.init, state?.splitCallbacks);
    if (!fn) return;
    const name = qualifyName(state?.fnScope, node.id?.name ?? ANON, state?.splitCallbacks);
    return pushAndDescend(fn, name, className, methods, handlers, state);
  },
  AssignmentExpression(node, className, methods, handlers, state) {
    const fn = resolveAssignedFunction(node.right, state?.splitCallbacks);
    if (!fn) return;
    const name = qualifyName(state?.fnScope, leftName(node.left), state?.splitCallbacks);
    return pushAndDescend(fn, name, className, methods, handlers, state);
  },
  // Object-literal shorthand `{ m() {} }` → ObjectMethod (body inline).
  ObjectMethod(node, className, methods, handlers, state) {
    if (!node.body) return;
    const name = qualifyName(state?.fnScope, keyName(node.key), state?.splitCallbacks);
    return pushAndDescend(node, name, className, methods, handlers, state);
  },
  // Object-literal keyed function `{ m: function () {} }` → ObjectProperty
  // whose value is the function (acorn called both shapes Property).
  ObjectProperty(node, className, methods, handlers, state) {
    if (!node.value?.body || !FUNCTION_LIKE.has(node.value.type)) return;
    const name = qualifyName(state?.fnScope, keyName(node.key), state?.splitCallbacks);
    return pushAndDescend(node.value, name, className, methods, handlers, state);
  },
  CallExpression(node, className, methods, handlers, state) {
    if (!state?.splitCallbacks) return;
    const hook = resolveHookEffectCallback(node);
    if (!hook) return;
    const parent = state.fnScope ?? className ?? ANON;
    const count = (state.effectCounts.get(`${parent}.${hook.hookName}`) ?? 0) + 1;
    state.effectCounts.set(`${parent}.${hook.hookName}`, count);
    return pushAndDescend(hook.fnNode, `${parent}.${hook.hookName}#${count}`, className, methods, handlers, state);
  },
  ClassDeclaration: classHandler,
  ClassExpression: classHandler,
  ExportDefaultDeclaration(node, className, methods, handlers, state) {
    // Walk the declaration inside; the export wrapper is transparent.
    if (node.declaration) walkForEntries(node.declaration, className, methods, handlers, state);
    return SKIP;
  },
  ExportNamedDeclaration(node, className, methods, handlers, state) {
    if (node.declaration) walkForEntries(node.declaration, className, methods, handlers, state);
    return SKIP;
  },
};

function pushAndDescend(fnNode, name, className, methods, handlers, state) {
  methods.push(makeMethod(name, fnNode));
  const nextState = state ? { ...state, fnScope: name } : state;
  visitChildren(fnNode, className, methods, handlers, nextState);
  return SKIP;
}

function classHandler(node, className, methods, handlers, state) {
  // Class field initialisers (PropertyDefinition) are not methods; the body
  // is the only place method entries live, so we walk it directly with the
  // class's own name as context and skip the generic traversal.
  const cn = node.id?.name ?? className;
  for (const child of node.body?.body ?? []) walkForEntries(child, cn, methods, handlers, state);
  return SKIP;
}

// Shared by ClassMethod and ClassPrivateMethod: the node itself is the function
// (Babel), so loc/complexity come straight off it. Constructors are excluded.
function classMethodHandler(node, className, methods, handlers, state) {
  if (node.kind === CONSTRUCTOR) return;
  if (!node.body) return;
  const mn = keyName(node.key);
  const name = className ? `${className}.${mn}` : mn;
  return pushAndDescend(node, name, className, methods, handlers, state);
}

// The method-size variant of classMethodHandler: constructors are entries
// too — that gate checks their parameter count only, everything else about
// them is identical.
function sizeClassMethodHandler(node, className, methods, handlers, state) {
  if (!node.body) return;
  const mn = keyName(node.key);
  const name = className ? `${className}.${mn}` : mn;
  return pushAndDescend(node, name, className, methods, handlers, state);
}

// Handler table for the size walk: HANDLERS with constructors included.
const SIZE_HANDLERS = {
  ...HANDLERS,
  ClassMethod: sizeClassMethodHandler,
  ClassPrivateMethod: sizeClassMethodHandler,
};

function walkForEntries(node, className, methods, handlers = HANDLERS, state = null) {
  if (!isNode(node)) return;
  const handler = handlers[node.type];
  if (handler?.(node, className, methods, handlers, state) === SKIP) return;
  visitChildren(node, className, methods, handlers, state);
}

function visitChildren(node, className, methods, handlers, state) {
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) {
        if (isNode(c)) walkForEntries(c, className, methods, handlers, state);
      }
    } else if (isNode(v)) {
      walkForEntries(v, className, methods, handlers, state);
    }
  }
}

function makeMethod(name, fnNode) {
  return {
    name,
    startLine: fnNode.loc.start.line,
    endLine: fnNode.loc.end.line,
    node: fnNode,
  };
}

/**
 * Cyclomatic complexity of a function body `root`.
 *
 * @param {object} root
 * @param {{ extractedNodes?: Set<object> }} [opts]
 * @returns {number}
 */
export function computeComplexity(root, { extractedNodes } = {}) {
  let cc = 1;
  const visit = (n) => {
    if (!isNode(n)) return;
    cc += complexityDelta(n);
    for (const child of childrenOf(n)) {
      // Nested NAMED FunctionDeclaration or extracted named arrow/method is
      // reported as its own entry; skip its body so its branches don't count
      // twice toward the enclosing function.
      if (!isExtractedInner(child, extractedNodes)) visit(child);
    }
  };
  visit(root);
  return cc;
}

function isExtractedInner(n, extractedNodes) {
  if (isNamedFunctionDecl(n)) return true;
  return Boolean(extractedNodes?.has(n));
}

function complexityDelta(n) {
  if (COMPLEXITY_TYPES.has(n.type)) return 1;
  if (n.type === LOGICAL_EXPRESSION && LOGICAL_OPS.has(n.operator)) return 1;
  return 0;
}

// ---------- Cognitive complexity (SonarSource v1.2) ----------

const COGNITIVE_TYPES = COMPLEXITY_TYPES;

/**
 * Cognitive complexity of a function body.
 *
 * @param {object} body  the function's body node.
 * @param {{ countLambdas?: boolean, extractedNodes?: Set<object>, splitCallbacks?: boolean }} [opts]
 * @returns {number}
 */
export function computeCognitive(body, { countLambdas = true, extractedNodes, splitCallbacks = false } = {}) {
  const s = { score: 0 };
  const visit = (n, depth, seqOp) => {
    if (!isNode(n) || isNamedFunctionDecl(n)) return;
    if (splitCallbacks && extractedNodes?.has(n)) return;
    if (lambdaBody(n, depth, countLambdas, visit, s)) return;
    cognitiveStep(s, n, depth, seqOp, visit);
  };
  visit(body, 0, undefined);
  return s.score;
}

// Lambdas deepen without incrementing; `countLambdas: false` skips them.
// Returns true when the node was a lambda (caller stops the generic step).
function lambdaBody(n, depth, countLambdas, visit) {
  if (!FUNCTION_LIKE.has(n.type)) return false;
  if (countLambdas) {
    for (const c of childrenOf(n)) visit(c, depth + 1, undefined);
  }
  return true;
}

// One flow-break increment per structural node (basic + nesting), one per
// `&&`/`||` sequence root; then descend.
function cognitiveStep(s, n, depth, seqOp, visit) {
  if (COGNITIVE_TYPES.has(n.type)) {
    structuralStep(s, n, depth, visit);
    return;
  }
  if (isLogicalSeqRoot(n, seqOp)) s.score++;
  const childOp = n.type === LOGICAL_EXPRESSION ? n.operator : undefined;
  for (const c of childrenOf(n)) visit(c, depth, childOp);
}

// Structural constructs pay basic + nesting and deepen their subtree;
// IfStatement gets its own dispatch (flat else-if chains, else increments).
function structuralStep(s, n, depth, visit) {
  s.score += 1 + depth;
  if (n.type === IF_STATEMENT) {
    visitIf(s, n, depth, visit);
    return;
  }
  for (const c of childrenOf(n)) visit(c, depth + 1, undefined);
}

// IfStatement: then and bare `else` each pay the basic-plus-nesting
// increment and deepen one level. An `else if` chain is flat: the chained
// if is visited at its originating if's depth — it increments (when its own
// turn comes) but does not nest.
function visitIf(s, n, depth, visit) {
  visit(n.test, depth + 1, undefined);
  visit(n.consequent, depth + 1, undefined);
  const alt = n.alternate;
  if (!alt) return;
  if (alt.type === IF_STATEMENT) {
    visit(alt, depth, undefined);
    return;
  }
  s.score += 1 + depth;
  visit(alt, depth + 1, undefined);
}

// Only the ROOT of a same-operator `&&`/`||` sequence increments: the
// operator of an enclosing logical expression is passed down as `seqOp`.
function isLogicalSeqRoot(n, seqOp) {
  return (
    n.type === LOGICAL_EXPRESSION && LOGICAL_OPS.has(n.operator) && seqOp !== n.operator
  );
}

function isNamedFunctionDecl(n) {
  return n.type === FUNCTION_DECLARATION && n.id;
}

// ---------- The `complexity` gate ----------

const MAX_COMPLEXITY = 10;
const CC_LABEL = 'CC';
const GATE_FLAGS = {
  '--metric': METRIC_OPT,
  '--max': 'max',
  '--config': CONFIG_OPT,
  '--override': OVERRIDE_OPT,
};
const GATE_NUMBER_FLAGS = new Set(['--max']);
const GATE_BOOL_FLAGS = {
  '--split-callbacks': SPLIT_CALLBACKS_OPT,
  '--explain': EXPLAIN_OPT,
};

/**
 * Complexity violations across files.
 *
 * @param {string[]} files  absolute paths.
 * @param {string} projectRoot
 * @param {{ metric?: string, max?: number, splitCallbacks?: boolean, explain?: boolean, configObj?: object }} [opts]
 * @returns {{violations: Array<{file, line, message}>, checked: number, explanations?: string[]}}
 */
export function complexityViolations(
  files,
  projectRoot,
  { metric = CYCLOMATIC, max = MAX_COMPLEXITY, splitCallbacks = false, explain = false, configObj = null } = {},
) {
  const violations = [];
  const explanations = [];
  let checked = 0;
  for (const file of files) {
    const rel = toRelPath(file, projectRoot);
    const resolved = configObj ? resolvePathConfig(configObj, rel, { metric, threshold: max }) : null;
    const fileMetric = resolved?.metric ?? metric;
    const fileMax = resolved?.threshold ?? max;
    const methods = extractMethods(readFileSync(file, UTF8), {
      ext: path.extname(file),
      metric: fileMetric,
      splitCallbacks,
      explain,
    });
    for (const m of methods) {
      checked++;
      if (m.complexity > fileMax) {
        violations.push({
          file: rel,
          line: m.startLine,
          message: `${m.name} ${metricLabel(fileMetric)}=${m.complexity} > max ${fileMax}`,
        });
        if (explain && m.breakdown) {
          explanations.push(formatExplanation(rel, m.name, m.startLine, fileMetric, m.complexity, m.breakdown));
        }
      }
    }
  }
  return { violations, checked, explanations };
}

// The metric label used in violation messages: CC for the cyclomatic path
// count, the metric name itself for cognitive (upstream parity).
function metricLabel(metric) {
  return metric === COGNITIVE ? COGNITIVE : CC_LABEL;
}

/**
 * One-line summary: `N/M functions over their <metric> limit <max>` on
 * violations, `M functions within their <metric> limit <max>` otherwise.
 */
export function complexitySummary({ violations, checked }, metric = CYCLOMATIC, max = MAX_COMPLEXITY) {
  return violations === 0
    ? `${checked} functions within their ${metric} limit ${max}`
    : `${violations}/${checked} functions over their ${metric} limit ${max}`;
}

/**
 * Parse `complexity` arguments into `{ metric, max, splitCallbacks,
 * explain, config, override, paths }`. Unknown flags, a metric outside
 * cyclomatic|cognitive, and non-integer maxima are usage errors.
 *
 * @param {string[]} argv
 */
export function parseComplexityArgs(argv) {
  const opts = {
    metric: CYCLOMATIC,
    max: MAX_COMPLEXITY,
    splitCallbacks: false,
    explain: false,
    config: undefined,
    override: [],
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const bool = GATE_BOOL_FLAGS[argv[i]];
    if (bool) opts[bool] = true;
    else i = applyGateArg(opts, argv[i], argv, i, GATE_FLAGS, GATE_NUMBER_FLAGS);
  }
  if (!METRIC_NAMES.has(opts.metric)) {
    throw new Error(`invalid --metric ${opts.metric}: expected ${CYCLOMATIC} or ${COGNITIVE}`);
  }
  if (!Number.isInteger(opts.max)) throw new Error(`--max must be an integer: ${opts.max}`);
  return opts;
}

const METRIC_NAMES = new Set([CYCLOMATIC, COGNITIVE]);

/**
 * The `complexity` command body. Returns exit code 2 iff violations exist.
 */
export function runComplexity(argv, ctx) {
  const opts = parseComplexityArgs(argv);
  const configObj = loadConfig(ctx.cwd, { configPath: opts.config, overrides: opts.override });
  let explanations = [];
  const code = runCheck(
    ctx,
    gateFiles(opts.paths, ctx.cwd),
    (files, root) => {
      const r = complexityViolations(files, root, { ...opts, configObj });
      explanations = r.explanations ?? [];
      return r;
    },
    (r) => complexitySummary(r, opts.metric, opts.max),
    'complexity',
  );
  if (opts.explain && explanations.length > 0) {
    ctx.out.write(explanations.join(''));
  }
  return code;
}
