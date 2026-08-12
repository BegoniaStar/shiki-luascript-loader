/* SPDX-License-Identifier: AGPL-3.0-only */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the Lua bridge is installed separately from the SealDice host adapter', async () => {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /invokeLuaHandler/u);
  assert.match(source, /onNotCommandReceived/u);
});
