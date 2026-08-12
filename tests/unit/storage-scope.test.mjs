/* SPDX-License-Identifier: AGPL-3.0-only */

import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('scoped Dice storage is persistent and rejects object-prototype keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dice-lua-storage-'));
  const output = join(directory, 'storage.cjs');
  try {
    buildSync({
      bundle: true,
      entryPoints: ['src/storage.ts'],
      format: 'cjs',
      outfile: output,
      platform: 'neutral',
      target: 'es2020',
    });
    const { CompatibilityStore } = createRequire(import.meta.url)(output);
    let raw = '';
    const adapter = {
      storageGet() { return raw; },
      storageSet(_key, value) { raw = value; },
    };
    const diagnostics = [];
    const first = new CompatibilityStore(adapter, {
      maxBytes: 100_000,
      maxDepth: 16,
      maxKeys: 2_000,
    }, { report(value) { diagnostics.push(value); } });
    assert.equal(first.writeScope('probe', 'group', '123', 'score', 7), true);
    assert.equal(first.readScope('probe', 'group', '123', 'score'), 7);
    assert.equal(first.writeScope('probe', 'group', '123', '__proto__', 1), false);
    assert.equal(first.writeSelfData('probe', 'constructor', 1), false);

    const second = new CompatibilityStore(adapter, {
      maxBytes: 100_000,
      maxDepth: 16,
      maxKeys: 2_000,
    }, { report(value) { diagnostics.push(value); } });
    assert.equal(second.readScope('probe', 'group', '123', 'score'), 7);
    assert.equal(diagnostics.some((item) => item.code === 'invalid-scoped-write'), true);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
