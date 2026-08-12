/* SPDX-License-Identifier: AGPL-3.0-only */

import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('Lua handlers survive registration-to-invocation VM transfer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dice-lua-compat-'));
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
    const diagnostics = [];
    const reporter = { report(value) { diagnostics.push(value); } };
    const plugin = {
      file: 'plugins/probe.lua.json',
      id: 'probe',
      modules: {},
      sequence: 0,
      source: `
        msg_order = { ping = function(msg)
          local data = getSelfData('probe')
          data.count = (data.count or 0) + 1
          msg:echo('side')
          return tostring(data.count), 'hidden'
        end, actor = function(msg)
          local card = getPlayerCard(msg.uid, msg.gid)
          card.hp = (card.hp or 0) + 1
          card:set('name', 'Ada')
          card:lock('hp')
          return tostring(getPlayerCardAttr(msg.uid, msg.gid, 'hp', 0)) .. ':' .. card:get('name', '') .. ':' .. tostring(card:locked('hp'))
        end, identity = function(msg)
          return getDiceQQ()
        end, send = function(msg)
          sendMsg('queued', msg.gid)
          return 'done'
        end, privateSend = function(msg)
          sendMsg('secret', 0, msg.uid)
        end, scoped = function(msg)
          setGroupConf(msg.gid, 'score', 7)
          setUserConf(msg.uid, 'name', 'Ada')
          setUserToday(msg.uid, 'count', (getUserToday(msg.uid, 'count', 0) or 0) + 1)
          return tostring(getGroupConf(msg.gid, 'score', 0)) .. ':' .. getUserConf(msg.uid, 'name', '') .. ':' .. tostring(getUserToday(msg.uid, 'count', 0))
        end, limitedOrder = {
          limit = { user_id = { '456' }, grp_id = { '123' }, prob = 60 },
          echo = 'limited-order'
        }, deck = function(msg)
          return drawDeck(msg.gid, msg.uid, 'demo')
        end, plain = { echo = 'plain' }, formatted = function(msg)
          msg:echo('formatted')
          msg:echo('raw', true)
        end, safe = function(msg)
          return tostring(io) .. ':' .. tostring(os) .. ':' .. tostring(package) .. ':' .. tostring(dofile) .. ':' .. tostring(loadfile)
        end }
        msg_reply = { hello = {
          keyword = { match = 'hello' },
          echo = function(msg) return 'world' end
        }, fallback = { echo = 'fallback' }, anchored = {
          keyword = { regex = '^hello$' }, echo = 'anchored'
        }, limited = {
          keyword = { match = 'limited' },
          limit = { user_id = { '456' }, grp_id = { '123' }, prob = 60 },
          echo = 'limited'
        }, excluded = {
          keyword = { match = 'excluded' },
          limit = 'user_id:!456;grp_id:123',
          echo = 'excluded'
        } }
        event = {
          startup = { hook = 'StartUp', action = { lua = function() return event.hook end } },
          message = { hook = 'MessageReceived', action = { lua = function() return event.fromMsg end } },
          nested = { trigger = { hook = 'GroupJoined' }, action = { lua = function() return event.hook end } }
        }
      `,
    };
    const config = {
      commandHelp: '',
      invalidReturn: '',
      maxOutputCount: 4,
      maxOutputCharacters: 4000,
      maxSourceCharacters: 200000,
      maxStorageBytes: 512000,
      maxStorageDepth: 16,
      maxStorageKeys: 2000,
      maxVmInstructions: 100000,
      outputLimited: '',
      runtimeError: '',
      showUserErrors: false,
    };
    const registered = runtime.registerLuaPlugin(plugin, config, reporter);
    assert.ok(registered);
    assert.equal(registered.events.length, 3);
    const values = new Map();
    const scopes = new Map();
    const store = {
      readSelfData(id, name) { return values.get(`${id}:${name}`) ?? {}; },
      writeSelfData(id, name, value) { values.set(`${id}:${name}`, value); return true; },
      readScope(id, scope, scopeId, key) { return scopes.get(`${id}:${scope}:${scopeId}:${key}`); },
      writeScope(id, scope, scopeId, key, value) {
        const storageKey = `${id}:${scope}:${scopeId}:${key}`;
        if (value === undefined) scopes.delete(storageKey);
        else scopes.set(storageKey, value);
        return true;
      },
    };
    const host = {
      snapshot: { fromMsg: 'hello', gid: '123', uid: '456' },
      format: (text) => `fmt:${text}`,
      random: () => 0.5,
      drawDeck: (groupId, userId, name) => `${groupId}:${userId}:${name}:card`,
      getDiceQQ: () => 'bot-42',
    };
    const first = runtime.invokeLuaHandler(registered, registered.orders.get('ping'), host, store, config, reporter);
    const second = runtime.invokeLuaHandler(registered, registered.orders.get('ping'), host, store, config, reporter);
    assert.deepEqual(first.outputs, [
      { hidden: false, text: 'fmt:side' },
      { hidden: false, text: 'fmt:1' },
      { hidden: true, text: 'fmt:hidden' },
    ]);
    assert.equal(second.outputs[1].text, 'fmt:2');
    const deck = runtime.invokeLuaHandler(registered, registered.orders.get('deck'), host, store, config, reporter);
    assert.deepEqual(deck.outputs, [{ hidden: false, text: 'fmt:123:456:demo:card' }]);
    const identity = runtime.invokeLuaHandler(registered, registered.orders.get('identity'), host, store, config, reporter);
    assert.deepEqual(identity.outputs, [{ hidden: false, text: 'fmt:bot-42' }]);
    const sent = runtime.invokeLuaHandler(registered, registered.orders.get('send'), host, store, config, reporter);
    assert.deepEqual(sent.outputs, [
      { hidden: false, text: 'fmt:queued' },
      { hidden: false, text: 'fmt:done' },
    ]);
    const privateSent = runtime.invokeLuaHandler(registered, registered.orders.get('privateSend'), host, store, config, reporter);
    assert.deepEqual(privateSent.outputs, [{ hidden: true, text: 'fmt:secret' }]);
    const limitedOrder = registered.orders.get('limitedOrder');
    assert.ok(limitedOrder.limit);
    assert.equal(runtime.triggerLimitAllows(limitedOrder.limit, host), true);
    assert.equal(runtime.triggerLimitAllows(limitedOrder.limit, { ...host, snapshot: { gid: '999', uid: '456' } }), false);
    const actor = runtime.invokeLuaHandler(registered, registered.orders.get('actor'), host, store, config, reporter);
    assert.deepEqual(actor.outputs, [{ hidden: false, text: 'fmt:1:Ada:true' }]);
    const actorAgain = runtime.invokeLuaHandler(registered, registered.orders.get('actor'), host, store, config, reporter);
    assert.deepEqual(actorAgain.outputs, [{ hidden: false, text: 'fmt:2:Ada:true' }]);
    const startup = runtime.invokeLuaEventHandler(registered, registered.events.find((event) => event.hook === 'StartUp'), {
      ...host,
      snapshot: { hook: 'StartUp' },
    }, store, config, reporter);
    assert.deepEqual(startup.outputs, [{ hidden: false, text: 'fmt:StartUp' }]);
    const received = runtime.invokeLuaEventHandler(registered, registered.events.find((event) => event.hook === 'MessageReceived'), host, store, config, reporter);
    assert.deepEqual(received.outputs, [{ hidden: false, text: 'fmt:hello' }]);
    const joined = runtime.invokeLuaEventHandler(registered, registered.events.find((event) => event.hook === 'GroupJoined'), {
      ...host,
      snapshot: { hook: 'GroupJoined', gid: '123', uid: '456' },
    }, store, config, reporter);
    assert.deepEqual(joined.outputs, [{ hidden: false, text: 'fmt:GroupJoined' }]);
    const scoped = runtime.invokeLuaHandler(registered, registered.orders.get('scoped'), host, store, config, reporter);
    assert.deepEqual(scoped.outputs, [{ hidden: false, text: 'fmt:7:Ada:1' }]);
    const scopedAgain = runtime.invokeLuaHandler(registered, registered.orders.get('scoped'), host, store, config, reporter);
    assert.deepEqual(scopedAgain.outputs, [{ hidden: false, text: 'fmt:7:Ada:2' }]);
    const plain = runtime.invokeLuaHandler(registered, registered.orders.get('plain'), host, store, config, reporter);
    assert.deepEqual(plain.outputs, [{ hidden: false, text: 'fmt:plain' }]);
    const formatted = runtime.invokeLuaHandler(registered, registered.orders.get('formatted'), host, store, config, reporter);
    assert.deepEqual(formatted.outputs, [
      { hidden: false, text: 'fmt:formatted' },
      { hidden: false, text: 'raw' },
    ]);
    const safe = runtime.invokeLuaHandler(registered, registered.orders.get('safe'), host, store, config, reporter);
    assert.deepEqual(safe.outputs, [{ hidden: false, text: 'fmt:nil:nil:nil:nil:nil' }]);
    assert.equal(registered.replies.length, 5);
    const hello = registered.replies.find((reply) => reply.title === 'hello');
    const fallback = registered.replies.find((reply) => reply.title === 'fallback');
    const limited = registered.replies.find((reply) => reply.title === 'limited');
    const excluded = registered.replies.find((reply) => reply.title === 'excluded');
    assert.ok(hello);
    assert.ok(fallback);
    assert.ok(limited);
    assert.ok(excluded);
    assert.equal(runtime.replyMatches(hello, 'HELLO').matched, true);
    assert.equal(runtime.replyMatches({ ...hello, keywords: { match: [], prefix: [], search: [], regex: [new RegExp('^hello$', 'iu')] }, type: 'Reply' }, 'hello!').matched, false);
    assert.equal(runtime.replyLimitAllows(limited, host), true);
    assert.equal(runtime.replyLimitAllows(limited, { ...host, random: () => 0.6 }), false);
    assert.equal(runtime.replyLimitAllows(limited, { ...host, snapshot: { gid: 'other', uid: '456' } }), false);
    assert.equal(runtime.replyLimitAllows(excluded, host), false);
    const fallbackResult = runtime.invokeLuaHandler(registered, fallback, host, store, config, reporter);
    assert.deepEqual(fallbackResult.outputs, [{ hidden: false, text: 'fmt:fallback' }]);
    assert.deepEqual(diagnostics, []);
    const unsupported = runtime.registerLuaPlugin({
      ...plugin,
      id: 'unsupported-limit',
      source: `msg_reply = { cooling = { keyword = { match = 'cooling' }, limit = 'cd:3', echo = 'cooling' } }`,
    }, config, reporter);
    assert.ok(unsupported);
    assert.equal(diagnostics.some((item) => item.code === 'unsupported-reply-limit'), true);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
