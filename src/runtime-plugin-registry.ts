/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Persisted, administrator-managed Lua source packages. This intentionally
 * supplements rather than alters the immutable sealpack asset index.
 */

import type { DiagnosticReporter } from './diagnostics';
import { isSafePluginId, type LuaPluginPackage } from './package-loader';

export interface RuntimePluginRegistryAdapter {
  storageGet(key: string): string;
  storageSet(key: string, value: string): void;
}

export interface RuntimePluginRegistryLimits {
  maxBytes: number;
  maxPlugins: number;
  maxSourceCharacters: number;
}

export interface ManagedPluginInfo {
  readonly enabled: boolean;
  readonly fingerprint: string;
  readonly id: string;
  readonly sourceCharacters: number;
}

export type RuntimePluginRegistryResult =
  | { ok: true }
  | {
    ok: false;
    reason: 'duplicate' | 'invalid-id' | 'invalid-source' | 'limit' | 'missing' | 'storage';
  };

interface StoredPlugin {
  enabled: boolean;
  source: string;
}

interface StoredRegistry {
  plugins: Record<string, StoredPlugin>;
  version: 1;
}

const storageKey = 'sealdice-dice-lua-runtime-plugins-v1';

function emptyRegistry(): StoredRegistry {
  return { plugins: {}, version: 1 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isStoredPlugin(value: unknown, maxSourceCharacters: number): value is StoredPlugin {
  return (
    isRecord(value) &&
    typeof value.source === 'string' &&
    value.source.length > 0 &&
    value.source.length <= maxSourceCharacters &&
    typeof value.enabled === 'boolean'
  );
}

function parseRegistry(raw: string, maxSourceCharacters: number): StoredRegistry | null {
  if (raw === '') return emptyRegistry();
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.plugins)) return null;
    for (const [id, plugin] of Object.entries(value.plugins)) {
      if (!isSafePluginId(id) || !isStoredPlugin(plugin, maxSourceCharacters)) return null;
    }
    return value as unknown as StoredRegistry;
  } catch {
    return null;
  }
}

/** A stable display fingerprint, not a cryptographic signature. */
export function sourceFingerprint(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Stores message-managed Lua source independently from sealpack assets. */
export class RuntimePluginRegistry {
  private state: StoredRegistry | undefined;

  public constructor(
    private readonly extension: RuntimePluginRegistryAdapter,
    private readonly limits: RuntimePluginRegistryLimits,
    private readonly reporter: DiagnosticReporter,
  ) {}

  private current(): StoredRegistry {
    if (this.state !== undefined) return this.state;
    let raw = '';
    try {
      raw = this.extension.storageGet(storageKey);
    } catch (error) {
      this.reporter.report({
        code: 'runtime-plugin-registry-read-failed',
        detail: String(error),
        severity: 'warning',
        stage: 'storage',
      });
    }
    const parsed = parseRegistry(raw, this.limits.maxSourceCharacters);
    if (parsed === null || !this.valid(parsed)) {
      this.reporter.report({
        code: parsed === null
          ? 'invalid-runtime-plugin-registry'
          : 'runtime-plugin-registry-limit-exceeded',
        severity: 'warning',
        stage: 'storage',
      });
      this.state = emptyRegistry();
    } else {
      this.state = parsed;
    }
    return this.state;
  }

  private valid(candidate: StoredRegistry): boolean {
    if (Object.keys(candidate.plugins).length > this.limits.maxPlugins) return false;
    return JSON.stringify(candidate).length <= this.limits.maxBytes;
  }

  private commit(candidate: StoredRegistry): RuntimePluginRegistryResult {
    if (!this.valid(candidate)) {
      this.reporter.report({
        code: 'runtime-plugin-registry-limit-exceeded',
        severity: 'warning',
        stage: 'storage',
      });
      return { ok: false, reason: 'limit' };
    }
    try {
      this.extension.storageSet(storageKey, JSON.stringify(candidate));
      this.state = candidate;
      return { ok: true };
    } catch (error) {
      this.reporter.report({
        code: 'runtime-plugin-registry-write-failed',
        detail: String(error),
        severity: 'error',
        stage: 'storage',
      });
      return { ok: false, reason: 'storage' };
    }
  }

  public list(): readonly ManagedPluginInfo[] {
    return Object.entries(this.current().plugins)
      .map(([id, plugin]) => ({
        enabled: plugin.enabled,
        fingerprint: sourceFingerprint(plugin.source),
        id,
        sourceCharacters: plugin.source.length,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  public get(id: string): ManagedPluginInfo | undefined {
    const plugin = this.current().plugins[id];
    if (plugin === undefined) return undefined;
    return {
      enabled: plugin.enabled,
      fingerprint: sourceFingerprint(plugin.source),
      id,
      sourceCharacters: plugin.source.length,
    };
  }

  /** Internal source access for revalidation; management replies never expose it. */
  public sourceForValidation(id: string): string | undefined {
    return this.current().plugins[id]?.source;
  }

  public enabledPackages(sequenceOffset = 0): readonly LuaPluginPackage[] {
    return Object.entries(this.current().plugins)
      .filter(([, plugin]) => plugin.enabled)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, plugin], index) => ({
        file: `runtime:${id}`,
        id,
        modules: {},
        sequence: sequenceOffset + index,
        source: plugin.source,
      }));
  }

  public add(id: string, source: string): RuntimePluginRegistryResult {
    if (!isSafePluginId(id)) return { ok: false, reason: 'invalid-id' };
    if (source.length === 0 || source.length > this.limits.maxSourceCharacters)
      return { ok: false, reason: 'invalid-source' };
    const candidate = clone(this.current());
    if (Object.prototype.hasOwnProperty.call(candidate.plugins, id))
      return { ok: false, reason: 'duplicate' };
    candidate.plugins[id] = { enabled: true, source };
    return this.commit(candidate);
  }

  public update(id: string, source: string): RuntimePluginRegistryResult {
    if (!isSafePluginId(id)) return { ok: false, reason: 'invalid-id' };
    if (source.length === 0 || source.length > this.limits.maxSourceCharacters)
      return { ok: false, reason: 'invalid-source' };
    const candidate = clone(this.current());
    const plugin = candidate.plugins[id];
    if (plugin === undefined) return { ok: false, reason: 'missing' };
    plugin.source = source;
    return this.commit(candidate);
  }

  public remove(id: string): RuntimePluginRegistryResult {
    const candidate = clone(this.current());
    if (!Object.prototype.hasOwnProperty.call(candidate.plugins, id))
      return { ok: false, reason: 'missing' };
    delete candidate.plugins[id];
    return this.commit(candidate);
  }

  public setEnabled(id: string, enabled: boolean): RuntimePluginRegistryResult {
    const candidate = clone(this.current());
    const plugin = candidate.plugins[id];
    if (plugin === undefined) return { ok: false, reason: 'missing' };
    plugin.enabled = enabled;
    return this.commit(candidate);
  }
}
