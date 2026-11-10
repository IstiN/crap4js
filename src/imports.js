// Import-specifier extraction and relative/alias-specifier resolution, shared
// by the unused-files and banned-imports subcommands.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { childrenOf, isNode } from './complexity.js';
import { toRelPath } from './files.js';

// Extensions tried when resolving an extensionless relative specifier,
// including React Native / Metro platform-specific variants.
const BASE_EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'];
const SOURCE_EXTS = [
  ...BASE_EXTS,
  ...BASE_EXTS.flatMap((e) => [`.ios${e}`, `.android${e}`, `.native${e}`]),
];
const aliasCache = new Map();

/**
 * All import/require specifiers of a parsed program: static imports,
 * re-exports (`export ... from`), dynamic `import('...')`, and
 * `require('...')`.
 *
 * @param {object} program  parsed Program node.
 * @returns {string[]} specifier strings.
 */
export function collectImports(program) {
  const specs = [];
  const visit = (n) => {
    if (!isNode(n)) return;
    const spec = importSpecifierOf(n);
    if (spec !== null) specs.push(spec);
    for (const c of childrenOf(n)) visit(c);
  };
  visit(program);
  return specs;
}

// Static import/export forms: the specifier lives in node.source.
const SOURCE_FORMS = new Set([
  'ImportDeclaration',
  'ExportAllDeclaration',
  'ExportNamedDeclaration',
]);

// The specifier a node carries, or null when the node is not an import.
function importSpecifierOf(n) {
  // Babel 8 parses dynamic import() as ImportExpression; older parsers
  // produce a CallExpression with an Import/require callee.
  if (n.type === 'ImportExpression') return literalValue(n.source);
  if (n.type === 'CallExpression') return literalArg(n);
  if (SOURCE_FORMS.has(n.type)) return n.source?.value ?? null;
  return null;
}

function isRequireLike(callee) {
  return callee.type === 'Import' || (callee.type === 'Identifier' && callee.name === 'require');
}

function literalArg(call) {
  return isRequireLike(call.callee) ? literalValue(call.arguments[0]) : null;
}

function literalValue(node) {
  return node?.type === 'StringLiteral' ? node.value : null;
}

// Strip `//` and `/* ... */` comments outside JSON string literals so
// JSONC `tsconfig.json` files parse with JSON.parse.
function stripJsonComments(text) {
  return text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) =>
    m.startsWith('"') ? m : '',
  );
}

function parseTsconfigPaths(projectRoot) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    try {
      const raw = readFileSync(path.join(projectRoot, name), 'utf8');
      return JSON.parse(stripJsonComments(raw)).compilerOptions ?? null;
    } catch {
      // try next
    }
  }
  return null;
}

function toAliasRule(baseDir, pattern, targets) {
  const t = Array.isArray(targets) ? targets[0] : null;
  if (!pattern.endsWith('/*') || typeof t !== 'string' || !t.endsWith('/*')) return null;
  return {
    prefix: pattern.slice(0, -1),
    targetDir: path.resolve(baseDir, t.slice(0, -2)),
  };
}

// Build `[{ prefix, targetDir }]` from tsconfig `compilerOptions.paths`
// (`"@app/*": ["./*"]` + `baseUrl: "./src"`). Cached per projectRoot.
function projectAliases(projectRoot) {
  if (aliasCache.has(projectRoot)) return aliasCache.get(projectRoot);
  const co = parseTsconfigPaths(projectRoot);
  const paths = co?.paths ?? {};
  const baseDir = path.resolve(projectRoot, co?.baseUrl ?? '.');
  const rules = Object.entries(paths)
    .map(([pattern, targets]) => toAliasRule(baseDir, pattern, targets))
    .filter(Boolean);
  aliasCache.set(projectRoot, rules);
  return rules;
}

function resolveCandidateBase(specifier, importerFile, projectRoot) {
  if (specifier.startsWith('.')) return path.resolve(path.dirname(importerFile), specifier);
  const rule = projectAliases(projectRoot).find((r) => specifier.startsWith(r.prefix));
  return rule ? path.resolve(rule.targetDir, specifier.slice(rule.prefix.length)) : null;
}

/**
 * Resolve an import specifier to a project-relative path. Relative
 * specifiers resolve against the importing file's directory; tsconfig
 * `paths` aliases resolve against `baseUrl`, trying the exact path, each
 * source extension, and `/index.<ext>`. Bare external specifiers return null.
 *
 * @param {string} specifier
 * @param {string} importerFile  absolute path of the importing file.
 * @param {string} projectRoot
 * @returns {string|null} project-relative POSIX path, or null.
 */
export function resolveImport(specifier, importerFile, projectRoot) {
  return resolveImports(specifier, importerFile, projectRoot)[0] ?? null;
}

/**
 * Resolve an import specifier to all matching project-relative paths
 * (e.g. both `Switch.ios.tsx` and `Switch.android.tsx` when importing
 * `./Switch`).
 *
 * @param {string} specifier
 * @param {string} importerFile  absolute path of the importing file.
 * @param {string} projectRoot
 * @returns {string[]} project-relative POSIX paths.
 */
export function resolveImports(specifier, importerFile, projectRoot) {
  const base = resolveCandidateBase(specifier, importerFile, projectRoot);
  if (!base) return [];
  const candidates = [base, ...withExts(base), ...withExts(path.join(base, 'index'))];
  return candidates.filter(isFile).map((hit) => toRelPath(hit, projectRoot));
}

function withExts(p) {
  return SOURCE_EXTS.map((e) => p + e);
}

// The exact-path candidate may hit a directory (e.g. `./lib`); only a
// real file resolves.
function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
