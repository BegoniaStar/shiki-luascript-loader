/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { DiagnosticReporter } from './diagnostics';

export interface LuaPluginPackage {
  file: string;
  id: string;
  modules: Readonly<Record<string, string>>;
  sequence: number;
  source: string;
}

interface LuaPluginEnvelope {
  format: 'sealdice-dice-lua-plugin-v1';
  id: string;
  modules: Record<string, string>;
  source: string;
}

interface LuaPluginIndex {
  format: 'sealdice-dice-lua-index-v1';
  plugins: readonly string[];
}

export interface PackageLoaderOptions {
  maxSourceCharacters: number;
}

export interface RuntimeModuleLoader {
  load(path: string): unknown;
}

const pluginPath = /^plugins\/[A-Za-z0-9][A-Za-z0-9._-]*\.lua\.json$/u;
const stableId = /^[^/\\\u0000-\u001F]{1,128}$/u;
const moduleName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const reservedObjectKeys = new Set(['__proto__', 'constructor', 'prototype']);

export function isSafePluginId(value: string): boolean {
  return stableId.test(value) && !reservedObjectKeys.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asIndex(value: unknown): LuaPluginIndex | null {
  if (!isRecord(value)) return null;
  if (value['format'] !== 'sealdice-dice-lua-index-v1') return null;
  if (!Array.isArray(value['plugins'])) return null;
  if (!value['plugins'].every((item) => typeof item === 'string')) return null;
  return { format: value['format'], plugins: value['plugins'] };
}

function asEnvelope(
  value: unknown,
  maxSourceCharacters: number,
): LuaPluginEnvelope | null {
  if (!isRecord(value)) return null;
  if (value['format'] !== 'sealdice-dice-lua-plugin-v1') return null;
  if (
    typeof value['id'] !== 'string' ||
    !isSafePluginId(value['id'])
  ) return null;
  if (
    typeof value['source'] !== 'string' ||
    value['source'].length > maxSourceCharacters
  ) {
    return null;
  }
  const rawModules = value['modules'] ?? {};
  if (!isRecord(rawModules)) return null;
  const modules: Record<string, string> = {};
  for (const [name, source] of Object.entries(rawModules)) {
    if (
      !moduleName.test(name) ||
      typeof source !== 'string' ||
      source.length > maxSourceCharacters
    ) {
      return null;
    }
    modules[name] = source;
  }
  return { format: value['format'], id: value['id'], modules, source: value['source'] };
}

export function isSafePluginPath(value: string): boolean {
  return pluginPath.test(value);
}

declare const require: (path: string) => unknown;

const runtimeModuleLoader: RuntimeModuleLoader = {
  load(path: string): unknown {
    if (path !== 'index.json' && !isSafePluginPath(path)) {
      throw new Error('Unexpected Dice Lua package asset path');
    }
    return require('../assets/dice-lua/' + path);
  },
};

/** Loads only index-declared JSON assets; it never scans or reads host paths. */
export function loadPluginPackages(
  reporter: DiagnosticReporter,
  options: PackageLoaderOptions,
  loader: RuntimeModuleLoader = runtimeModuleLoader,
): readonly LuaPluginPackage[] {
  let indexValue: unknown;
  try {
    indexValue = loader.load('index.json');
  } catch (error) {
    reporter.report({
      code: 'index-load-failed',
      detail: String(error),
      severity: 'error',
      stage: 'load',
    });
    return [];
  }
  const index = asIndex(indexValue);
  if (index === null) {
    reporter.report({
      code: 'invalid-plugin-index',
      severity: 'error',
      stage: 'load',
    });
    return [];
  }

  const ids = new Set<string>();
  const files = new Set<string>();
  const packages: LuaPluginPackage[] = [];
  for (const file of index.plugins) {
    if (!isSafePluginPath(file) || files.has(file)) {
      reporter.report({
        code: 'unsafe-or-duplicate-plugin-path',
        file,
        severity: 'error',
        stage: 'load',
      });
      continue;
    }
    files.add(file);
    let raw: unknown;
    try {
      raw = loader.load(file);
    } catch (error) {
      reporter.report({
        code: 'plugin-load-failed',
        detail: String(error),
        file,
        severity: 'error',
        stage: 'load',
      });
      continue;
    }
    const envelope = asEnvelope(raw, options.maxSourceCharacters);
    if (envelope === null) {
      reporter.report({
        code: 'invalid-plugin-envelope',
        file,
        severity: 'error',
        stage: 'load',
      });
      continue;
    }
    if (ids.has(envelope.id)) {
      reporter.report({
        code: 'duplicate-plugin-id',
        file,
        pluginId: envelope.id,
        severity: 'error',
        stage: 'load',
      });
      continue;
    }
    ids.add(envelope.id);
    packages.push({
      file,
      id: envelope.id,
      modules: envelope.modules,
      sequence: packages.length,
      source: envelope.source,
    });
  }
  return packages;
}
