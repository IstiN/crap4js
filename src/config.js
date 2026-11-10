// Per-path configuration and CLI `--override` parsing (Issue #2).
//
// Loads optional `crap4js.config.json` in `cwd`, `"crap4js"` key in
// `package.json`, or an explicit `--config <path>` file, plus repeatable
// CLI `--override '<glob>:threshold=15,metric=cognitive'` rules.
// Overrides match project-relative POSIX paths; last matching override wins
// (ESLint-style).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { UTF8, globToRegExp } from './files.js';
import {
  COGNITIVE,
  COMPONENT_SIZE_GATE,
  COVERAGE,
  CRAP_GATE,
  CYCLOMATIC,
  DUPLICATES_GATE,
  MAX_CALLBACKS_OPT,
  MAX_COMPLEXITY_OPT,
  MAX_LINES_OPT,
  MAX_PARAMS_OPT,
  METHOD_SIZE_GATE,
  METRIC_OPT,
  OBJECT,
  PACKAGE_JSON,
  THRESHOLD_OPT,
} from './constants.js';

const DEFAULT_CONFIG_FILE = 'crap4js.config.json';
const NUMBER_KEYS = new Set([
  THRESHOLD_OPT,
  MAX_LINES_OPT,
  'maxMethodLines',
  MAX_PARAMS_OPT,
  MAX_COMPLEXITY_OPT,
  MAX_CALLBACKS_OPT,
  'maxComponentLines',
  'minCoverage',
]);
const BOOL_GATES = new Set([
  CRAP_GATE,
  COVERAGE,
  DUPLICATES_GATE,
  'methodSize',
  'loc',
  'componentSize',
]);
const GATE_ALIASES = {
  [CRAP_GATE]: CRAP_GATE,
  [COVERAGE]: COVERAGE,
  [DUPLICATES_GATE]: DUPLICATES_GATE,
  duplication: DUPLICATES_GATE,
  methodSize: 'methodSize',
  [METHOD_SIZE_GATE]: 'methodSize',
  loc: 'loc',
  componentSize: 'componentSize',
  [COMPONENT_SIZE_GATE]: 'componentSize',
};

/**
 * Load project config from `--config <path>`, `crap4js.config.json`, or
 * `package.json#crap4js`, appending any CLI `--override` entries.
 *
 * @param {string} cwd
 * @param {{ configPath?: string, overrides?: string[] }} [opts]
 * @returns {object}
 */
export function loadConfig(cwd, { configPath, overrides = [] } = {}) {
  const raw = readRawConfig(cwd, configPath) ?? {};
  const cliOverrides = overrides.map(parseOverrideSpec);
  const allOverrides = [...(raw.overrides ?? []), ...cliOverrides].map(compileOverride);
  return { ...raw, overrides: allOverrides };
}

function readRawConfig(cwd, configPath) {
  if (configPath) {
    const abs = path.resolve(cwd, configPath);
    if (!existsSync(abs)) throw new Error(`config file not found: ${configPath}`);
    return parseJsonFile(abs, configPath);
  }
  const defaultFile = path.join(cwd, DEFAULT_CONFIG_FILE);
  if (existsSync(defaultFile)) return parseJsonFile(defaultFile, DEFAULT_CONFIG_FILE);
  return readPackageConfig(cwd);
}

function parseJsonFile(abs, label) {
  try {
    return JSON.parse(readFileSync(abs, UTF8));
  } catch (e) {
    throw new Error(`failed to parse ${label}: ${e.message}`);
  }
}

function readPackageConfig(cwd) {
  const pkgPath = path.join(cwd, PACKAGE_JSON);
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, UTF8));
    return pkg?.crap4js && typeof pkg.crap4js === OBJECT ? pkg.crap4js : null;
  } catch {
    return null;
  }
}

/**
 * Parse a CLI `--override '<glob>:k=v,k2=v2'` string into an override object.
 *
 * @param {string} spec
 * @returns {object}
 */
export function parseOverrideSpec(spec) {
  const sep = spec.indexOf(':');
  const glob = sep > 0 ? spec.slice(0, sep).trim() : '';
  const body = sep > 0 ? spec.slice(sep + 1).trim() : '';
  if (!glob || !body) {
    throw new Error(`Invalid --override: ${spec} (expected <glob>:key=value[,key=value])`);
  }
  const rule = { files: [glob], gates: {} };
  for (const pair of body.split(',')) applyOverridePair(rule, pair.trim(), spec);
  return rule;
}

function applyOverridePair(rule, pair, spec) {
  const eq = pair.indexOf('=');
  if (eq <= 0) throw new Error(`Invalid --override: ${spec}`);
  const key = pair.slice(0, eq).trim();
  const val = pair.slice(eq + 1).trim();
  if (key.startsWith('gates.')) {
    applyGateToggle(rule.gates, key.slice('gates.'.length), val, spec);
  } else if (key === METRIC_OPT) {
    applyMetricValue(rule, val);
  } else {
    applyNumberValue(rule, key, val);
  }
}

function applyMetricValue(rule, val) {
  if (val !== CYCLOMATIC && val !== COGNITIVE) {
    throw new Error(`Invalid metric in --override: ${val}`);
  }
  rule.metric = val;
}

function applyNumberValue(rule, key, val) {
  if (!NUMBER_KEYS.has(key)) throw new Error(`Unknown key in --override: ${key}`);
  const n = Number(val);
  if (Number.isNaN(n) || n < 0) throw new Error(`Invalid ${key} in --override: ${val}`);
  rule[key] = n;
}

function applyGateToggle(gates, rawGate, val, spec) {
  const gate = GATE_ALIASES[rawGate];
  if (!gate || !BOOL_GATES.has(gate) || (val !== 'true' && val !== 'false')) {
    throw new Error(`Invalid gate toggle in --override: ${spec}`);
  }
  gates[gate] = val === 'true';
}

function compileOverride(entry) {
  const files = Array.isArray(entry.files) ? entry.files : [entry.files].filter(Boolean);
  return {
    ...entry,
    gates: normalizeGates(entry.gates),
    matchers: files.map(globToRegExp),
  };
}

function normalizeGates(gates) {
  if (!gates || typeof gates !== OBJECT) return {};
  const out = {};
  for (const [k, v] of Object.entries(gates)) {
    out[GATE_ALIASES[k] ?? k] = Boolean(v);
  }
  return out;
}

/**
 * Resolve effective settings for a project-relative POSIX path `relFile`.
 * Last matching override wins over top-level config and `defaults`.
 *
 * @param {object} config  result of `loadConfig`.
 * @param {string} relFile  project-relative POSIX path.
 * @param {object} [defaults]  caller/CLI defaults.
 * @returns {object}
 */
export function resolvePathConfig(config, relFile, defaults = {}) {
  const base = {
    ...defaults,
    ...pickTopLevel(config, defaults),
    gates: { ...(defaults.gates ?? {}), ...normalizeGates(config?.gates) },
  };
  for (const ov of config?.overrides ?? []) {
    if (ov.matchers?.some((re) => re.test(relFile))) applyMatchedOverride(base, ov);
  }
  return base;
}

function pickTopLevel(config, defaults) {
  if (!config) return {};
  const out = {};
  for (const k of [METRIC_OPT, ...NUMBER_KEYS]) {
    if (config[k] !== undefined && defaults[`explicit_${k}`] !== true) {
      out[k] = config[k];
    }
  }
  return out;
}

function applyMatchedOverride(target, ov) {
  for (const k of [METRIC_OPT, ...NUMBER_KEYS]) {
    if (ov[k] !== undefined) target[k] = ov[k];
  }
  if (ov.gates) Object.assign(target.gates, ov.gates);
}

/**
 * Whether a specific gate (`crap`, `coverage`, `duplicates`, `methodSize`,
 * `loc`, `componentSize`) is enabled for `relFile`.
 *
 * @param {object} config
 * @param {string} relFile
 * @param {string} gate
 * @returns {boolean}
 */
export function isGateEnabled(config, relFile, gate) {
  const key = GATE_ALIASES[gate] ?? gate;
  const resolved = resolvePathConfig(config, relFile);
  return resolved.gates?.[key] !== false;
}
