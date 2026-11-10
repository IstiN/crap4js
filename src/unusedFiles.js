// `unused-files` subcommand: flags non-test source files that are never
// imported by any analyzed source or test file. Port of crap4dart's
// unused_files gate (0.5.x), adapted to ESM: relative and tsconfig-alias
// import specifiers are resolved against the importing file's directory
// (trying source extensions, platform extensions, and `/index.<ext>`);
// bare specifiers name external packages and never count.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UTF8, gateFiles, testFiles, toRelPath } from './files.js';
import { applyGateArg, runCheck, skipPartialSelection } from './gateCommon.js';
import { globToRegExp } from './bannedImports.js';
import { parseSource } from './complexity.js';
import { collectImports, resolveImports } from './imports.js';
import { EXCLUDE } from './constants.js';

const VALUE_FLAGS = { '--exclude': EXCLUDE };

/**
 * Parse `unused-files` arguments into `{ exclude, paths }`. `--exclude`
 * is repeatable and accepts `--exclude GLOB` or `--exclude=GLOB`.
 *
 * @param {string[]} argv
 * @returns {{exclude: string[], paths: string[]}}
 */
export function parseUnusedFilesArgs(argv) {
  const opts = { exclude: [], paths: [] };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(opts, argv[i], argv, i, VALUE_FLAGS);
  }
  return opts;
}

/**
 * Unused-file violations across files. Imports from both non-test `files`
 * and any `importers` (e.g. test files) count toward the reachability
 * graph so shared test helpers/fixtures under `src/` are not flagged as
 * dead when imported by tests.
 *
 * @param {string[]} files  absolute paths (non-test sources to check).
 * @param {string} projectRoot
 * @param {string[]} [importers]  additional files whose imports count.
 * @returns {{violations: Array<{file, message}>, checked: number}}
 */
export function unusedFilesViolations(files, projectRoot, importers = []) {
  const imported = new Set();
  for (const file of new Set([...files, ...importers])) {
    for (const resolved of importedFrom(file, projectRoot)) imported.add(resolved);
  }
  const violations = files
    .map((f) => toRelPath(f, projectRoot))
    .filter((rel) => !imported.has(rel))
    .map((rel) => ({ file: rel, message: 'never imported by any analyzed source file' }));
  return { violations, checked: files.length };
}

function importedFrom(file, projectRoot) {
  const ast = parseSource(readFileSync(file, UTF8), path.extname(file));
  const out = [];
  for (const spec of collectImports(ast.program)) {
    out.push(...resolveImports(spec, file, projectRoot));
  }
  return out;
}

/**
 * One-line summary: `N/M files never imported` on violations, `M files
 * all imported` otherwise.
 */
export function unusedFilesSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} files all imported`
    : `${violations}/${checked} files never imported`;
}

/**
 * The `unused-files` command body. A whole-project check: with an explicit
 * path selection it prints the skip message and exits 0 (a partial file
 * set yields false positives — crap4dart 0.5.1 behavior).
 */
export function runUnusedFiles(argv, ctx) {
  const { exclude, paths } = parseUnusedFilesArgs(argv);
  if (paths.length > 0) return skipPartialSelection(ctx);
  const globs = exclude.map(globToRegExp);
  const allSources = gateFiles([], ctx.cwd);
  const checkedFiles = allSources.filter(
    (f) => !globs.some((g) => g.test(toRelPath(f, ctx.cwd))),
  );
  const importers = [...allSources, ...testFiles([], ctx.cwd)];
  return runCheck(
    ctx,
    checkedFiles,
    (fs, root) => unusedFilesViolations(fs, root, importers),
    unusedFilesSummary,
    'unused-files',
  );
}
