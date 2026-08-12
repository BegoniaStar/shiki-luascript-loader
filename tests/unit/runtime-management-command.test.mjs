/* SPDX-License-Identifier: AGPL-3.0-only */

import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function commandArgs(action, id = '', source = '') {
  return {
    rawArgs: `${action}${id === '' ? '' : ` ${id}`}${source === '' ? '' : `\n${source}`}`,
    getArgN(index) {
      if (index === 1) return action;
      if (index === 2) return id;
      return '';
    },
    getRestArgsFrom(index) {
      return index === 3 ? source : '';
    },
  };
}

test('master-only management command performs single-message Lua CRUD', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dice-lua-management-'));
  const output = join(directory, 'index.cjs');
  const originalSeal = globalThis.seal;
  try {
    buildSync({
      bundle: true,
      entryPoints: ['src/index.ts'],
      format: 'cjs',
      outfile: output,
      platform: 'neutral',
      target: 'es2020',
    });
    const config = new Map();
    const storage = new Map();
    const replies = [];
    let extension;
    const registerConfig = (_extension, key, defaultValue) => config.set(key, defaultValue);
    globalThis.seal = {
      deck: { draw() { return { exists: false }; } },
      ext: {
        find() { return null; },
        getBoolConfig(_extension, key) { return config.get(key); },
        getIntConfig(_extension, key) { return config.get(key); },
        getStringConfig(_extension, key) { return config.get(key); },
        new(_name, _author, _version) {
          extension = {
            cmdMap: {},
            storageGet(key) { return storage.get(key) ?? ''; },
            storageSet(key, value) { storage.set(key, value); },
          };
          return extension;
        },
        newCmdExecuteResult(solved) { return { solved, showHelp: false }; },
        newCmdItemInfo() { return {}; },
        register() {},
        registerBoolConfig: registerConfig,
        registerIntConfig: registerConfig,
        registerStringConfig: registerConfig,
      },
      format(_ctx, text) { return text; },
      replyPerson(_ctx, _msg, text) { replies.push({ hidden: true, text }); },
      replyToSender(_ctx, _msg, text) { replies.push({ hidden: false, text }); },
    };
    createRequire(import.meta.url)(output);
    assert.ok(extension.cmdMap.luaplug);
    const ctx = {
      endPoint: { userId: 'bot' },
      group: null,
      isPrivate: true,
      player: { name: 'master' },
      privilegeLevel: 100,
    };
    const msg = {
      channelId: '',
      groupId: '',
      message: '',
      platform: 'QQ',
      rawId: '1',
      sender: { nickname: 'master', userId: '42' },
    };
    extension.cmdMap.luaplug.solve(ctx, msg, commandArgs('add', 'broken', 'msg_order = {'));
    assert.equal(extension.cmdMap.broken, undefined);
    assert.equal(storage.size, 0);
    assert.match(replies.at(-1).text, /Lua 校验失败/u);
    const source = 'msg_order = { ping = function(msg) return "pong" end }';
    extension.cmdMap.luaplug.solve(ctx, msg, commandArgs('add', 'demo', source));
    assert.ok(extension.cmdMap.ping);
    assert.match(replies.at(-1).text, /add demo/u);
    extension.cmdMap.luaplug.solve(ctx, msg, commandArgs('info', 'demo'));
    assert.doesNotMatch(replies.at(-1).text, /pong/u);
    assert.match(replies.at(-1).text, /源码字符数/u);

    extension.cmdMap.ping.solve(ctx, msg, commandArgs(''));
    assert.deepEqual(replies.at(-1), { hidden: false, text: 'pong' });

    extension.cmdMap.luaplug.solve(ctx, msg, commandArgs('disable', 'demo'));
    assert.equal(extension.cmdMap.ping, undefined);
    extension.cmdMap.luaplug.solve(ctx, msg, commandArgs('enable', 'demo'));
    assert.ok(extension.cmdMap.ping);
    extension.cmdMap.luaplug.solve(
      ctx,
      msg,
      commandArgs('update', 'demo', 'msg_order = { ping = function(msg) return "updated" end }'),
    );
    extension.cmdMap.ping.solve(ctx, msg, commandArgs(''));
    assert.deepEqual(replies.at(-1), { hidden: false, text: 'updated' });
    extension.cmdMap.luaplug.solve(ctx, msg, commandArgs('remove', 'demo'));
    assert.equal(extension.cmdMap.ping, undefined);

    const nonMaster = { ...ctx, privilegeLevel: 70 };
    extension.cmdMap.luaplug.solve(nonMaster, msg, commandArgs('list'));
    assert.equal(replies.at(-1).text, '权限不足。');
    extension.cmdMap.luaplug.solve({ ...ctx, isPrivate: false }, msg, commandArgs('list'));
    assert.equal(replies.at(-1).text, '权限不足。');
  } finally {
    globalThis.seal = originalSeal;
    await rm(directory, { force: true, recursive: true });
  }
});
