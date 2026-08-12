/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { DiagnosticReporter } from './diagnostics';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

interface PluginState {
  group: Record<string, JsonObject>;
  selfdata: Record<string, JsonValue>;
  today: Record<string, JsonObject>;
  user: Record<string, JsonObject>;
}

export type StorageScope = 'group' | 'today' | 'user';

interface PersistedState {
  plugins: Record<string, PluginState>;
  version: 1;
}

export interface StorageAdapter {
  storageGet(key: string): string;
  storageSet(key: string, value: string): void;
}

export interface StorageLimits {
  maxBytes: number;
  maxDepth: number;
  maxKeys: number;
}

const storageKey = 'sealdice-dice-lua-state-v1';
const safeDataName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const safeScopeId = /^[^/\\\u0000-\u001F\u007F]{1,256}$/u;
const safeScopeKey = /^[^\u0000-\u001F\u007F]{1,256}$/u;
const reservedObjectKeys = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'hasOwnProperty',
  'toString',
  'toLocaleString',
  'valueOf',
]);

function emptyPluginState(): PluginState {
  return { group: {}, selfdata: {}, today: {}, user: {} };
}

function emptyState(): PersistedState {
  return { plugins: {}, version: 1 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function isPluginState(value: unknown): value is PluginState {
  if (!isRecord(value)) return false;
  return (
    isRecord(value['group']) &&
    isRecord(value['selfdata']) &&
    isRecord(value['today']) &&
    isRecord(value['user']) &&
    Object.values(value['selfdata']).every(isJsonValue) &&
    Object.values(value['group']).every(
      (item) => isRecord(item) && Object.values(item).every(isJsonValue),
    ) &&
    Object.values(value['today']).every(
      (item) => isRecord(item) && Object.values(item).every(isJsonValue),
    ) &&
    Object.values(value['user']).every(
      (item) => isRecord(item) && Object.values(item).every(isJsonValue),
    )
  );
}

function parseState(raw: string): PersistedState | null {
  if (raw === '') return emptyState();
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value['version'] !== 1 || !isRecord(value['plugins']))
      return null;
    if (!Object.values(value['plugins']).every(isPluginState)) return null;
    return value as unknown as PersistedState;
  } catch {
    return null;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function countShape(value: unknown, depth = 1): { depth: number; keys: number } {
  if (value === null || typeof value !== 'object') return { depth, keys: 0 };
  let maxDepth = depth;
  let keys = 0;
  for (const child of Object.values(value)) {
    keys += 1;
    const childShape = countShape(child, depth + 1);
    keys += childShape.keys;
    maxDepth = Math.max(maxDepth, childShape.depth);
  }
  return { depth: maxDepth, keys };
}

function validDataName(name: string): boolean {
  return safeDataName.test(name) && !reservedObjectKeys.has(name);
}

function validScopePart(value: string, pattern: RegExp): boolean {
  return pattern.test(value) && !reservedObjectKeys.has(value);
}

/** Versioned, plugin-scoped storage that never interprets data names as paths. */
export class CompatibilityStore {
  private state: PersistedState | undefined;

  public constructor(
    private readonly extension: StorageAdapter,
    private readonly limits: StorageLimits,
    private readonly reporter: DiagnosticReporter,
  ) {}

  private current(): PersistedState {
    if (this.state !== undefined) return this.state;
    let raw = '';
    try {
      raw = this.extension.storageGet(storageKey);
    } catch (error) {
      this.reporter.report({
        code: 'storage-read-failed',
        detail: String(error),
        severity: 'warning',
        stage: 'storage',
      });
    }
    const parsed = parseState(raw);
    const invalidShape =
      parsed !== null &&
      (raw.length > this.limits.maxBytes ||
        countShape(parsed).depth > this.limits.maxDepth ||
        countShape(parsed).keys > this.limits.maxKeys);
    if (parsed === null || invalidShape) {
      this.reporter.report({
        code: invalidShape ? 'storage-limit-exceeded' : 'invalid-storage-state',
        severity: 'warning',
        stage: 'storage',
      });
      this.state = emptyState();
    } else {
      this.state = parsed;
    }
    return this.state;
  }

  private commit(candidate: PersistedState): boolean {
    const json = JSON.stringify(candidate);
    const shape = countShape(candidate);
    if (
      json.length > this.limits.maxBytes ||
      shape.depth > this.limits.maxDepth ||
      shape.keys > this.limits.maxKeys
    ) {
      this.reporter.report({
        code: 'storage-limit-exceeded',
        severity: 'warning',
        stage: 'storage',
      });
      return false;
    }
    try {
      this.extension.storageSet(storageKey, json);
      this.state = candidate;
      return true;
    } catch (error) {
      this.reporter.report({
        code: 'storage-write-failed',
        detail: String(error),
        severity: 'error',
        stage: 'storage',
      });
      return false;
    }
  }

  public readSelfData(pluginId: string, name: string): JsonValue {
    if (!validDataName(name)) return {};
    const state = this.current();
    const plugin = Object.prototype.hasOwnProperty.call(state.plugins, pluginId)
      ? state.plugins[pluginId]
      : undefined;
    return clone(plugin?.selfdata[name] ?? {});
  }

  public writeSelfData(pluginId: string, name: string, value: JsonValue): boolean {
    if (!validDataName(name) || !isJsonValue(value)) {
      this.reporter.report({
        code: 'invalid-selfdata-write',
        pluginId,
        severity: 'warning',
        stage: 'storage',
      });
      return false;
    }
    const candidate = clone(this.current());
    const plugin = Object.prototype.hasOwnProperty.call(candidate.plugins, pluginId)
      ? candidate.plugins[pluginId]
      : (candidate.plugins[pluginId] = emptyPluginState());
    plugin.selfdata[name] = clone(value);
    return this.commit(candidate);
  }

  public readScope(
    pluginId: string,
    scope: StorageScope,
    scopeId: string,
    key: string,
  ): JsonValue | undefined {
    if (
      !validScopePart(scopeId, safeScopeId) ||
      !validScopePart(key, safeScopeKey)
    ) return undefined;
    const plugin = this.current().plugins[pluginId];
    const bucket = plugin?.[scope];
    const record = bucket !== undefined &&
      Object.prototype.hasOwnProperty.call(bucket, scopeId)
      ? bucket[scopeId]
      : undefined;
    if (record === undefined || !Object.prototype.hasOwnProperty.call(record, key)) {
      return undefined;
    }
    return clone(record[key]);
  }

  public writeScope(
    pluginId: string,
    scope: StorageScope,
    scopeId: string,
    key: string,
    value: JsonValue | undefined,
  ): boolean {
    if (
      !validScopePart(scopeId, safeScopeId) ||
      !validScopePart(key, safeScopeKey) ||
      (value !== undefined && !isJsonValue(value))
    ) {
      this.reporter.report({
        code: 'invalid-scoped-write',
        pluginId,
        severity: 'warning',
        stage: 'storage',
      });
      return false;
    }
    const candidate = clone(this.current());
    const plugin = Object.prototype.hasOwnProperty.call(candidate.plugins, pluginId)
      ? candidate.plugins[pluginId]
      : (candidate.plugins[pluginId] = emptyPluginState());
    const bucket = plugin[scope];
    const record = Object.prototype.hasOwnProperty.call(bucket, scopeId)
      ? bucket[scopeId]
      : (bucket[scopeId] = {});
    if (value === undefined) delete record[key];
    else record[key] = clone(value);
    if (Object.keys(record).length === 0) delete bucket[scopeId];
    return this.commit(candidate);
  }
}
