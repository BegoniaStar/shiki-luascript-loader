/* SPDX-License-Identifier: AGPL-3.0-only */

import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('runtime plugin registry persists bounded CRUD records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dice-lua-registry-'));
  const output = join(directory, 'registry.cjs');
  try {
    buildSync({
      bundle: true,
      entryPoints: ['src/runtime-plugin-registry.ts'],
      format: 'cjs',
      outfile: output,
      platform: 'neutral',
      target: 'es2020',
    });
    const { RuntimePluginRegistry } = createRequire(import.meta.url)(output);
    let persisted = '';
    const extension = {
      storageGet() { return persisted; },
      storageSet(_key, value) { persisted = value; },
    };
    const diagnostics = [];
    const limits = { maxBytes: 1_000, maxPlugins: 2, maxSourceCharacters: 100 };
    const registry = new RuntimePluginRegistry(extension, limits, {
      report(value) { diagnostics.push(value); },
    });
    assert.deepEqual(registry.list(), []);
    assert.deepEqual(registry.add('__proto__', 'msg_order = {}'), { ok: false, reason: 'invalid-id' });
    assert.deepEqual(registry.add('demo', 'msg_order = {}'), { ok: true });
    assert.equal(registry.list()[0].enabled, true);
    assert.equal(registry.enabledPackages().length, 1);
    assert.deepEqual(registry.add('demo', 'msg_order = {}'), { ok: false, reason: 'duplicate' });
    assert.deepEqual(registry.update('demo', 'msg_order = { ping = function(msg) return "pong" end }'), { ok: true });
    assert.deepEqual(registry.setEnabled('demo', false), { ok: true });
    assert.equal(registry.enabledPackages().length, 0);

    const reloaded = new RuntimePluginRegistry(extension, limits, {
      report(value) { diagnostics.push(value); },
    });
    assert.equal(reloaded.get('demo').enabled, false);
    assert.deepEqual(reloaded.remove('demo'), { ok: true });
    assert.deepEqual(reloaded.remove('demo'), { ok: false, reason: 'missing' });
    assert.deepEqual(diagnostics, []);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
