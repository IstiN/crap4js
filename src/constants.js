// Shared simple literals used across modules — every constant owns one
// spelling, not one usage: the same value may legitimately play several
// roles (TEST is the default test directory, the node:test registrar and
// the TAP type of a real test). The scattered-constants gate guards
// against the literals reappearing inline elsewhere.

// The `test` name: the default test directory, the node:test registrar
// and the TAP `type:` diagnostic of a real test.
export const TEST = 'test';

// The node test runner's flag (`node --test`).
export const TEST_FLAG = '--test';

// The `--threshold` option name; each command defines what it thresholds.
export const THRESHOLD_FLAG = '--threshold';

// The `coverage` name shared by the coverage flag's value key and the
// coverage output directory skipped as tooling output.
export const COVERAGE = 'coverage';

// The default Istanbul JSON report path, relative to the project root.
export const DEFAULT_COVERAGE = 'coverage/coverage-final.json';

// The shared `exclude` / `ignore` option keys of the gate subcommands;
// `ignore` is also the node child-process stdio discard value.
export const EXCLUDE = 'exclude';
export const IGNORE = 'ignore';

// The `string` / `object` typeof tags and AST/token spellings.
export const STRING = 'string';
export const OBJECT = 'object';

// Milliseconds per second — the unit scale factor 1000: seconds to
// millis (mutation timeout), micros to millis and millis to seconds
// (profile report formatting).
export const MILLIS_PER_SECOND = 1000;

// Shared AST-node-type names and protocol spellings repeated across the
// gates: one home per spelling, referenced at every use site.
export const ANON = '<anonymous>';
export const IDENT = 'Identifier';
export const CALL = 'CallExpression';
export const MEMBER = 'MemberExpression';
export const CONSTRUCTOR = 'constructor';
export const FUNCTION_DECLARATION = 'FunctionDeclaration';
export const FUNCTION_EXPRESSION = 'FunctionExpression';
export const ARROW_FUNCTION_EXPRESSION = 'ArrowFunctionExpression';
export const CLASS_DECLARATION = 'ClassDeclaration';
export const CLASS_METHOD = 'ClassMethod';
export const CLASS_PRIVATE_METHOD = 'ClassPrivateMethod';
export const PRIVATE_NAME = 'PrivateName';
export const STRING_LITERAL = 'StringLiteral';
export const NUMERIC_LITERAL = 'NumericLiteral';
export const BOOLEAN_LITERAL = 'BooleanLiteral';
export const TEMPLATE_LITERAL = 'TemplateLiteral';
export const TAGGED_TEMPLATE = 'TaggedTemplateExpression';
export const REGEX_LITERAL = 'RegExpLiteral';
export const NEW_EXPRESSION = 'NewExpression';
export const IMPORT_DECLARATION = 'ImportDeclaration';
export const EXPORT_NAMED_DECLARATION = 'ExportNamedDeclaration';
export const EXPORT_DEFAULT_DECLARATION = 'ExportDefaultDeclaration';
export const VARIABLE_DECLARATION = 'VariableDeclaration';
export const VARIABLE_DECLARATOR = 'VariableDeclarator';
export const IF_STATEMENT = 'IfStatement';
export const BLOCK_STATEMENT = 'BlockStatement';
export const TRY_STATEMENT = 'TryStatement';
export const CONDITIONAL_EXPRESSION = 'ConditionalExpression';
export const LOGICAL_EXPRESSION = 'LogicalExpression';

// Complexity metric names.
export const COGNITIVE = 'cognitive';
export const CYCLOMATIC = 'cyclomatic';

// Shared gate & CLI option names.
export const CRAP_GATE = 'crap';
export const DUPLICATES_GATE = 'duplicates';
export const METHOD_SIZE_GATE = 'method-size';
export const COMPONENT_SIZE_GATE = 'component-size';
export const COLLAPSIBLE_FLOW_GATE = 'collapsible-flow';
export const IDENTICAL_BRANCHES_GATE = 'identical-branches';
export const NON_NULL_ASSERTION_GATE = 'non-null-assertion';
export const STRING_HAZARDS_GATE = 'string-hazards';

export const METRIC_OPT = 'metric';
export const THRESHOLD_OPT = 'threshold';
export const CONFIG_OPT = 'config';
export const OVERRIDE_OPT = 'override';
export const SPLIT_CALLBACKS_OPT = 'splitCallbacks';
export const EXPLAIN_OPT = 'explain';
export const MAX_LINES_OPT = 'maxLines';
export const MAX_LINES_FLAG = '--max-lines';
export const MAX_PARAMS_OPT = 'maxParams';
export const MAX_COMPLEXITY_OPT = 'maxComplexity';
export const MAX_CALLBACKS_OPT = 'maxCallbacks';
export const SEVERITY_OPT = 'severity';
export const WARNING_SEV = 'warning';
export const ERROR_SEV = 'error';
export const PACKAGE_JSON = 'package.json';
export const NO_SOURCE_FILES_MSG = 'No source files to check.\n';

/**
 * True when `x` is a Babel/ESTree AST node (`{ type: string, ... }`).
 *
 * @param {unknown} x
 * @returns {boolean}
 */
export function isNode(x) {
  return x !== null && typeof x === OBJECT && typeof x.type === STRING;
}

// Keys skipped during generic AST child traversal.
export const SKIP_KEYS = new Set([
  'type', 'loc', 'range', 'sourceType', 'start', 'end',
  'leadingComments', 'trailingComments', 'innerComments', 'extra', 'directives',
]);

/**
 * Child AST nodes of `n`, skipping location/comment metadata.
 *
 * @param {object} n
 * @returns {object[]}
 */
export function childrenOf(n) {
  const out = [];
  for (const key of Object.keys(n)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = n[key];
    if (Array.isArray(v)) out.push(...v.filter(isNode));
    else if (isNode(v)) out.push(v);
  }
  return out;
}

/**
 * Display name of an object property or class method `key`.
 *
 * @param {object} key
 * @returns {string}
 */
export function keyName(key) {
  if (!key) return ANON;
  if (key.type === IDENT) return key.name;
  if (key.type === PRIVATE_NAME) return '#' + key.id?.name;
  if (key.type === 'Literal') return String(key.value);
  return ANON;
}

/**
 * Display name of an assignment left-hand side (`Identifier` or `MemberExpression`).
 *
 * @param {object} node
 * @returns {string}
 */
export function leftName(node) {
  if (!node) return ANON;
  if (node.type === IDENT) return node.name;
  if (node.type === MEMBER) {
    const obj = leftName(node.object);
    const prop =
      node.property.type === IDENT && !node.computed
        ? node.property.name
        : node.property.type === 'Literal'
        ? String(node.property.value)
        : '<anon>';
    return `${obj}.${prop}`;
  }
  return ANON;
}
