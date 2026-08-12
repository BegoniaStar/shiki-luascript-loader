/* SPDX-License-Identifier: AGPL-3.0-only */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the compatibility layer keeps its sandbox and fixed asset boundary', async () => {
  const source = await readFile(new URL('../../src/lua/fengari-runtime.ts', import.meta.url), 'utf8');
  assert.match(source, /lua_pushnil\(state\);/u);
  assert.match(source, /dofile/u);
  const index = JSON.parse(await readFile(new URL('../../assets/dice-lua/index.json', import.meta.url), 'utf8'));
  assert.equal(index.format, 'sealdice-dice-lua-index-v1');
  assert.deepEqual(index.plugins, []);
});
