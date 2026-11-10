// AST range filters and pairwise/widening helpers for the duplicates gate
// (Issue #3):
//   - `--ignore-types`: skips TypeScript/Flow type, interface, and enum
//     declarations so mirrored DTO/view-model types are not flagged.
//   - `--ignore-data`: skips pure data object/array literals (whose values are
//     all literals, arrays of data, or nested data objects) and whole
//     export-default / const data maps (e.g. i18n translation tables, flat
//     config maps).

import {
  BOOLEAN_LITERAL,
  EXPORT_DEFAULT_DECLARATION,
  EXPORT_NAMED_DECLARATION,
  NUMERIC_LITERAL,
  STRING_LITERAL,
  TEMPLATE_LITERAL,
  VARIABLE_DECLARATION,
  childrenOf,
  isNode,
} from './constants.js';

const TYPE_DECL_TYPES = new Set([
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration',
  'TSEnumDeclaration',
  'TSModuleDeclaration',
  'TypeAlias',
  'InterfaceDeclaration',
  'OpaqueType',
  'DeclareTypeAlias',
  'DeclareInterface',
]);

const DATA_LITERALS = new Set([
  STRING_LITERAL,
  NUMERIC_LITERAL,
  BOOLEAN_LITERAL,
  'NullLiteral',
  'BigIntLiteral',
]);

/**
 * Collect `[start, end)` byte ranges to skip for `--ignore-types` and
 * `--ignore-data`.
 *
 * @param {object} program
 * @param {{ ignoreTypes?: boolean, ignoreData?: boolean }} opts
 * @returns {Array<[number, number]>}
 */
export function extraSkipRanges(program, opts) {
  const ranges = [];
  if (opts.ignoreTypes) collectTypeRanges(program, ranges);
  if (opts.ignoreData) collectDataRanges(program, ranges);
  return ranges;
}

function collectTypeRanges(node, ranges) {
  if (!isNode(node)) return;
  if (TYPE_DECL_TYPES.has(node.type) || isWrappedTypeExport(node)) {
    ranges.push([node.start, node.end]);
    return;
  }
  for (const c of childrenOf(node)) collectTypeRanges(c, ranges);
}

function isWrappedTypeExport(node) {
  if (node.type !== EXPORT_NAMED_DECLARATION && node.type !== EXPORT_DEFAULT_DECLARATION) {
    return false;
  }
  return Boolean(node.declaration && TYPE_DECL_TYPES.has(node.declaration.type));
}

function collectDataRanges(node, ranges) {
  if (!isNode(node)) return;
  if (isDataStatement(node) || isPureDataContainer(node)) {
    ranges.push([node.start, node.end]);
    return;
  }
  for (const c of childrenOf(node)) collectDataRanges(c, ranges);
}

function isDataStatement(node) {
  if (node.type === EXPORT_DEFAULT_DECLARATION) {
    return isPureDataValue(unwrapTsExpression(node.declaration));
  }
  if (node.type === EXPORT_NAMED_DECLARATION && node.declaration) {
    return isDataVariableDecl(node.declaration);
  }
  return isDataVariableDecl(node);
}

function isDataVariableDecl(node) {
  if (node.type !== VARIABLE_DECLARATION || node.declarations.length === 0) return false;
  return node.declarations.every((d) => isPureDataContainer(d.init));
}

function unwrapTsExpression(node) {
  let cur = node;
  while (cur && (cur.type === 'TSAsExpression' || cur.type === 'TSSatisfiesExpression')) {
    cur = cur.expression;
  }
  return cur;
}

function isPureDataContainer(node) {
  const u = unwrapTsExpression(node);
  if (!u) return false;
  if (u.type === 'ObjectExpression') {
    return u.properties.length > 0 && u.properties.every(isPureDataProperty);
  }
  if (u.type === 'ArrayExpression') {
    return u.elements.length > 0 && u.elements.every(isPureDataValue);
  }
  return false;
}

function isPureDataProperty(prop) {
  if (prop.type !== 'ObjectProperty' || prop.computed) return false;
  return isPureDataValue(prop.value);
}

function isPureDataValue(node) {
  const u = unwrapTsExpression(node);
  if (!u) return false;
  if (DATA_LITERALS.has(u.type) || isPlainTemplate(u)) return true;
  if (isSignedLiteral(u)) return isPureDataValue(u.argument);
  return isPureDataContainer(u);
}

function isPlainTemplate(u) {
  return u.type === TEMPLATE_LITERAL && u.expressions.length === 0;
}

function isSignedLiteral(u) {
  return u.type === 'UnaryExpression' && (u.operator === '-' || u.operator === '+');
}

// ---------- Pairwise and clone-widening helpers ----------

const MAX_PAIRWISE = 24;

/**
 * Generate pairwise 2-occurrence candidates for `--pairwise` when a bucket has
 * 3..24 occurrences and a pair shares a longer extent than the full group.
 *
 * @param {object[]} bags
 * @param {Array<[number, number]>} positions
 * @param {string[][]} codes
 * @param {{ minTokens: number, minLines: number }} opts
 * @param {Array<[number, number, number]>|null} group
 * @param {Function} extentOf
 * @returns {Array<Array<[number, number, number]>>}
 */
export function pairGroups(bags, positions, codes, opts, group, extentOf) {
  if (positions.length < 3 || positions.length > MAX_PAIRWISE) return [];
  const common = group ? group[0][2] - group[0][1] : opts.minTokens;
  const out = [];
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const pair = maximalPair(bags, positions[i], positions[j], codes, opts, extentOf);
      if (pair && pair[0][2] - pair[0][1] > common) out.push(pair);
    }
  }
  return out;
}

function maximalPair(bags, [b1, s1], [b2, s2], codes, { minTokens, minLines }, extentOf) {
  const [start2, end2] = extentOf(codes[b2], s2, codes[b1], s1, minTokens);
  const left = s2 - start2;
  const a = [b1, s1 - left, s1 - left + (end2 - start2)];
  const b = [b2, start2, end2];
  if (b1 === b2 && a[1] < b[2] && b[1] < a[2]) return null;
  const toks = bags[b1].tokens;
  if (toks[a[2] - 1].line - toks[a[1]].line + 1 < minLines) return null;
  return [a, b];
}

/**
 * Structured form of an accepted clone group for diff-scoped gates.
 *
 * @param {object[]} bags
 * @param {Array<[number, number, number]>} group
 * @returns {{ tokens: number, lines: number, fingerprint: string, occurrences: object[] }}
 */
export function cloneRecord(bags, group) {
  const [refBag, refStart, refEnd] = group[0];
  const ref = bags[refBag].tokens;
  const fingerprint = ref.slice(refStart, refEnd).map((t) => t.value).join('\u0000');
  return {
    tokens: refEnd - refStart,
    lines: ref[refEnd - 1].line - ref[refStart].line + 1,
    fingerprint,
    occurrences: group.map((_occ, i) => buildOccurrence(bags, group, i)),
  };
}

function buildOccurrence(bags, group, i) {
  const [b, s, e] = widenOccurrence(bags, group, i);
  const occTokens = bags[b].tokens;
  return {
    file: bags[b].rel,
    startLine: occTokens[s].line,
    endLine: occTokens[e - 1].line,
    fingerprint: occTokens.slice(s, e).map((t) => t.value).join('\u0000'),
  };
}

function sameToken(a, b) {
  return a.value === b.value || (a.lexeme !== undefined && a.lexeme === b.lexeme);
}

function widenOccurrence(bags, group, i) {
  const [b, s, e] = group[i];
  const mine = bags[b].tokens;
  let left = 0;
  let right = 0;
  group.forEach(([ob, os, oe], j) => {
    if (j === i) return;
    const [l, r] = growPair(mine, s, e, bags[ob].tokens, os, oe);
    left = Math.max(left, l);
    right = Math.max(right, r);
  });
  return clampToNeighbours(group, i, [b, s - left, e + right]);
}

function growPair(mine, s, e, other, os, oe) {
  let l = 0;
  while (s - l > 0 && os - l > 0 && sameToken(mine[s - l - 1], other[os - l - 1])) l++;
  let r = 0;
  while (e + r < mine.length && oe + r < other.length && sameToken(mine[e + r], other[oe + r])) r++;
  return [l, r];
}

function clampToNeighbours(group, i, [b, s, e]) {
  let start = s;
  let end = e;
  group.forEach(([ob, os, oe], j) => {
    if (j === i || ob !== b) return;
    if (oe <= group[i][1]) start = Math.max(start, oe);
    if (os >= group[i][2]) end = Math.min(end, os);
  });
  return [b, start, end];
}
