// Explainability + callback-splitting helpers for cyclomatic and cognitive
// complexity (Issues #1 and #4).

import {
  ANON,
  ARROW_FUNCTION_EXPRESSION,
  CALL,
  COGNITIVE,
  CONDITIONAL_EXPRESSION,
  FUNCTION_DECLARATION,
  FUNCTION_EXPRESSION,
  IDENT,
  IF_STATEMENT,
  LOGICAL_EXPRESSION,
  MEMBER,
  VARIABLE_DECLARATOR,
  childrenOf,
  isNode,
  keyName,
  leftName,
} from './constants.js';

const FUNCTION_LIKE = new Set([FUNCTION_EXPRESSION, ARROW_FUNCTION_EXPRESSION]);

const HOOK_WRAPPER_NAMES = new Set([
  'useCallback',
  'useMemo',
]);

const HOOK_CALL_NAMES = new Set([
  'useEffect',
  'useLayoutEffect',
  'useInsertionEffect',
]);

const CONSTRUCT_LABELS = {
  [IF_STATEMENT]: 'if',
  ForStatement: 'for',
  ForInStatement: 'for...in',
  ForOfStatement: 'for...of',
  WhileStatement: 'while',
  DoWhileStatement: 'do...while',
  CatchClause: 'catch',
  SwitchCase: 'case',
  [CONDITIONAL_EXPRESSION]: '?:',
};

/**
 * Unwrap `useCallback(() => {}, deps)` / `useMemo(() => {}, deps)` to its
 * inner function expression/arrow when `splitCallbacks` is active; returns
 * the direct function init otherwise.
 *
 * @param {object} init  VariableDeclarator.init or AssignmentExpression.right
 * @param {boolean} [splitCallbacks]
 * @returns {object|null}
 */
export function resolveAssignedFunction(init, splitCallbacks = false) {
  if (!init) return null;
  if (init.body && FUNCTION_LIKE.has(init.type)) return init;
  if (!splitCallbacks || init.type !== CALL) return null;
  const callee = calleeIdentifier(init.callee);
  const firstArg = init.arguments?.[0];
  return isHookCallback(callee, firstArg) ? firstArg : null;
}

function isHookCallback(callee, firstArg) {
  return HOOK_WRAPPER_NAMES.has(callee) && Boolean(firstArg?.body) && FUNCTION_LIKE.has(firstArg.type);
}

/**
 * Identifier name of a call's callee (`fn()` or `React.fn()`).
 *
 * @param {object} callee
 * @returns {string|null}
 */
export function calleeIdentifier(callee) {
  if (!callee) return null;
  if (callee.type === IDENT) return callee.name;
  if (callee.type === MEMBER && !callee.computed && callee.property?.type === IDENT) {
    return callee.property.name;
  }
  return null;
}

/**
 * Extract a hook callback from `useEffect(() => {}, deps)` (and
 * `useLayoutEffect` / `useInsertionEffect`) when `splitCallbacks` is active.
 *
 * @param {object} callNode  CallExpression node
 * @returns {{ hookName: string, fnNode: object } | null}
 */
export function resolveHookEffectCallback(callNode) {
  if (callNode?.type !== CALL) return null;
  const hookName = calleeIdentifier(callNode.callee);
  const firstArg = callNode.arguments?.[0];
  if (HOOK_CALL_NAMES.has(hookName) && firstArg?.body && FUNCTION_LIKE.has(firstArg.type)) {
    return { hookName, fnNode: firstArg };
  }
  return null;
}

/**
 * Qualifying a child function name with its enclosing scope (`Parent.child`)
 * when `splitCallbacks` is active and `scopeName` is a function name.
 *
 * @param {string|undefined} scopeName
 * @param {string} name
 * @param {boolean} [splitCallbacks]
 * @returns {string}
 */
export function qualifyName(scopeName, name, splitCallbacks) {
  return splitCallbacks && scopeName ? `${scopeName}.${name}` : name;
}

/**
 * Explain the complexity contributors inside `body`, skipping any AST nodes
 * in `extractedNodes` (and nested named FunctionDeclarations).
 *
 * @param {object} body  function body AST node
 * @param {{ metric?: string, extractedNodes?: Set<object>, countLambdas?: boolean }} [opts]
 * @returns {Array<{ delta: number, line?: number, label: string, arrow?: { name: string|null, line: number } }>}
 */
export function explainComplexity(body, { metric, extractedNodes = new Set(), countLambdas = true } = {}) {
  if (metric === COGNITIVE) {
    return explainCognitive(body, extractedNodes, countLambdas);
  }
  return explainCyclomatic(body, extractedNodes);
}

function explainCyclomatic(body, extractedNodes) {
  const items = [{ delta: 1, label: 'base' }];
  const visit = (n, arrowCtx) => {
    if (!isNode(n) || isSkippedSubtree(n, extractedNodes)) return;
    const label = cyclomaticLabel(n);
    if (label) items.push(makeItem(1, n.loc?.start?.line, label, arrowCtx));
    const nextArrow = arrowContextFor(n, arrowCtx, extractedNodes);
    for (const c of childrenOf(n)) visit(c, nextArrow);
  };
  visit(body, null);
  return items;
}

function cyclomaticLabel(n) {
  if (n.type === 'SwitchCase') return n.test ? 'case' : 'default';
  if (CONSTRUCT_LABELS[n.type]) return CONSTRUCT_LABELS[n.type];
  if (n.type === LOGICAL_EXPRESSION && (n.operator === '&&' || n.operator === '||')) {
    return n.operator;
  }
  return null;
}

function explainCognitive(body, extractedNodes, countLambdas) {
  const items = [];
  const visit = (n, depth, seqOp, arrowCtx) => {
    if (!isNode(n) || isSkippedSubtree(n, extractedNodes)) return;
    const nextArrow = arrowContextFor(n, arrowCtx, extractedNodes);
    if (FUNCTION_LIKE.has(n.type)) {
      visitCognitiveLambda(n, depth, nextArrow, countLambdas, visit);
      return;
    }
    if (CONSTRUCT_LABELS[n.type]) {
      cognitiveStructural(n, depth, nextArrow, items, visit);
      return;
    }
    cognitiveNonStructural(n, depth, seqOp, nextArrow, items, visit);
  };
  visit(body, 0, undefined, null);
  return items;
}

function visitCognitiveLambda(n, depth, arrowCtx, countLambdas, visit) {
  if (!countLambdas) return;
  for (const c of childrenOf(n)) visit(c, depth + 1, undefined, arrowCtx);
}

function cognitiveNonStructural(n, depth, seqOp, nextArrow, items, visit) {
  if (isLogicalRoot(n, seqOp)) {
    items.push(makeItem(1, n.loc?.start?.line, n.operator, nextArrow));
  }
  const childOp = n.type === LOGICAL_EXPRESSION ? n.operator : undefined;
  for (const c of childrenOf(n)) visit(c, depth, childOp, nextArrow);
}

function cognitiveStructural(n, depth, arrowCtx, items, visit) {
  const label = n.type === 'SwitchCase' && !n.test ? 'default' : CONSTRUCT_LABELS[n.type];
  items.push(makeItem(1 + depth, n.loc?.start?.line, label, arrowCtx, depth));
  if (n.type === IF_STATEMENT) {
    visitCognitiveIf(n, depth, arrowCtx, items, visit);
    return;
  }
  for (const c of childrenOf(n)) visit(c, depth + 1, undefined, arrowCtx);
}

function visitCognitiveIf(n, depth, arrowCtx, items, visit) {
  visit(n.test, depth + 1, undefined, arrowCtx);
  visit(n.consequent, depth + 1, undefined, arrowCtx);
  const alt = n.alternate;
  if (!alt) return;
  if (alt.type === IF_STATEMENT) {
    visit(alt, depth, undefined, arrowCtx);
    return;
  }
  items.push(makeItem(1 + depth, alt.loc?.start?.line, 'else', arrowCtx, depth));
  visit(alt, depth + 1, undefined, arrowCtx);
}

function isLogicalRoot(n, seqOp) {
  return (
    n.type === LOGICAL_EXPRESSION &&
    (n.operator === '&&' || n.operator === '||') &&
    seqOp !== n.operator
  );
}

function makeItem(delta, line, label, arrow, nesting = 0) {
  const item = { delta, line, label };
  if (nesting > 0) item.nesting = nesting;
  if (arrow) item.arrow = arrow;
  return item;
}

function isSkippedSubtree(n, extractedNodes) {
  if (extractedNodes.has(n)) return true;
  return n.type === FUNCTION_DECLARATION && Boolean(n.id);
}

// Track enclosing inner arrow/function expressions that were NOT extracted
// so `--explain` can annotate `(in arrow <name> at :<line>)`.
function arrowContextFor(n, current, extractedNodes) {
  const named = namedInnerFunction(n, extractedNodes);
  if (named) return named;
  if (FUNCTION_LIKE.has(n.type) && !extractedNodes.has(n) && !current) {
    return { name: n.id?.name ?? null, line: n.loc?.start?.line };
  }
  return current;
}

function namedInnerFunction(n, extractedNodes) {
  if (n.type === VARIABLE_DECLARATOR) return namedDeclaratorArrow(n, extractedNodes);
  if (n.type === 'ObjectProperty') return namedPropertyArrow(n, extractedNodes);
  if (n.type === 'AssignmentExpression') return namedAssignmentArrow(n, extractedNodes);
  return null;
}

function namedDeclaratorArrow(n, extractedNodes) {
  const fn = resolveAssignedFunction(n.init, true);
  if (!fn || extractedNodes.has(fn)) return null;
  return { name: n.id?.name ?? null, line: fn.loc?.start?.line };
}

function namedPropertyArrow(n, extractedNodes) {
  if (!FUNCTION_LIKE.has(n.value?.type) || extractedNodes.has(n.value)) return null;
  const k = keyName(n.key);
  return { name: k === ANON ? null : k, line: n.value.loc?.start?.line };
}

function namedAssignmentArrow(n, extractedNodes) {
  if (!FUNCTION_LIKE.has(n.right?.type) || extractedNodes.has(n.right)) return null;
  const k = leftName(n.left);
  return { name: k === ANON ? null : k, line: n.right.loc?.start?.line };
}

/**
 * Format an explanation item as a single indented line:
 *   `  +1 :14 catch                    (in arrow onPress at :13)`
 *
 * @param {object} item
 * @returns {string}
 */
export function formatExplainLine(item) {
  if (item.label === 'base') return `  +${item.delta} base`;
  const loc = item.line != null ? `:${item.line} ` : '';
  const nest = item.nesting ? ` (nesting +${item.nesting})` : '';
  const head = `  +${item.delta} ${loc}${item.label}${nest}`;
  return item.arrow ? appendArrowNote(head, item.arrow) : head;
}

function appendArrowNote(head, arrow) {
  const pad = head.length < 34 ? ' '.repeat(34 - head.length) : ' ';
  const who = arrow.name ? ` ${arrow.name}` : '';
  return `${head}${pad}(in arrow${who} at :${arrow.line})`;
}

/**
 * Format a full explanation block for a function.
 *
 * @param {string} file
 * @param {string} methodName
 * @param {number} line
 * @param {string} metric
 * @param {number} complexity
 * @param {object[]} breakdown
 * @returns {string}
 */
export function formatExplanation(file, methodName, line, metric, complexity, breakdown) {
  const label = metric === COGNITIVE ? COGNITIVE : 'CC';
  const header = `${file}:${line} ${methodName} ${label}=${complexity}`;
  const rows = (breakdown ?? []).map(formatExplainLine);
  return [header, ...rows].join('\n') + '\n';
}
