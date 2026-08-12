/* SPDX-License-Identifier: AGPL-3.0-only */

import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, readFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('the original compatibility demo Lua plugin loads and runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dice-lua-demo-'));
  const output = join(directory, 'runtime.cjs');
  try {
    buildSync({
      bundle: true,
      entryPoints: ['src/lua/runtime.ts'],
      format: 'cjs',
      outfile: output,
      platform: 'neutral',
      target: 'es2020',
    });
    const runtime = createRequire(import.meta.url)(output);
    const source = await readFile(new URL('../../tests/lua/compat-demo.lua', import.meta.url), 'utf8');
    const diagnostics = [];
    const config = {
      commandHelp: '',
      invalidReturn: '',
      maxOutputCount: 8,
      maxOutputCharacters: 4_000,
      maxSourceCharacters: 200_000,
      maxStorageBytes: 512_000,
      maxStorageDepth: 16,
      maxStorageKeys: 2_000,
      maxVmInstructions: 100_000,
      outputLimited: '',
      runtimeError: '',
      showUserErrors: false,
    };
    const plugin = {
      file: 'tests/lua/compat-demo.lua',
      id: 'compat-demo',
      modules: {},
      sequence: 0,
      source,
    };
    const registered = runtime.registerLuaPlugin(plugin, config, {
      report(value) { diagnostics.push(value); },
    });
    assert.ok(registered);
    assert.deepEqual([...registered.orders.keys()], ['.dlcard', '.dlhelp', '.dlstate']);
    assert.equal(registered.replies.length, 1);
    assert.equal(registered.events.length, 1);

    const selfData = new Map();
    const scopes = new Map();
    const store = {
      readSelfData(id, name) { return selfData.get(`${id}:${name}`) ?? {}; },
      writeSelfData(id, name, value) { selfData.set(`${id}:${name}`, value); return true; },
      readScope(id, scope, scopeId, key) { return scopes.get(`${id}:${scope}:${scopeId}:${key}`); },
      writeScope(id, scope, scopeId, key, value) {
        const storageKey = `${id}:${scope}:${scopeId}:${key}`;
        if (value === undefined) scopes.delete(storageKey);
        else scopes.set(storageKey, value);
        return true;
      },
    };
    const host = {
      format: (text) => `fmt:${text}`,
      random: () => 0.5,
      snapshot: { fromMsg: '.dlhelp', gid: '123', uid: '42' },
    };
    const invoke = (name, currentHost = host) => runtime.invokeLuaHandler(
      registered,
      registered.orders.get(name),
      currentHost,
      store,
      config,
      { report(value) { diagnostics.push(value); } },
    );

    assert.deepEqual(invoke('.dlhelp').outputs, [{ hidden: false, text: 'fmt:compat-demo 42@123' }]);
    assert.deepEqual(invoke('.dlstate').outputs, [{ hidden: false, text: 'fmt:state=1,group=1' }]);
    assert.deepEqual(invoke('.dlstate').outputs, [{ hidden: false, text: 'fmt:state=2,group=2' }]);
    assert.deepEqual(invoke('.dlcard').outputs, [{ hidden: false, text: 'fmt:hp=1,locked=true' }]);
    assert.deepEqual(invoke('.dlcard').outputs, [{ hidden: false, text: 'fmt:hp=2,locked=true' }]);

    const reply = registered.replies[0];
    assert.equal(runtime.replyMatches(reply, 'DL PING').matched, true);
    assert.equal(runtime.replyLimitAllows(reply, host), true);
    assert.equal(runtime.replyLimitAllows(reply, { ...host, snapshot: { gid: '123', uid: '7' } }), false);
    assert.deepEqual(runtime.invokeLuaHandler(registered, reply, host, store, config, {
      report(value) { diagnostics.push(value); },
    }).outputs, [{ hidden: false, text: 'fmt:pong:42' }]);

    const startup = runtime.invokeLuaEventHandler(registered, registered.events[0], {
      ...host,
      snapshot: { hook: 'StartUp' },
    }, store, config, { report(value) { diagnostics.push(value); } });
    assert.deepEqual(startup.outputs, [{ hidden: false, text: 'fmt:compat-demo-started' }]);
    assert.deepEqual(diagnostics, []);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
