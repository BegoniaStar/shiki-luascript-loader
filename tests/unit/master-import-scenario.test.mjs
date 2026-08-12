/* SPDX-License-Identifier: AGPL-3.0-only */

import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function commandArgs(action = '', id = '', source = '') {
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

test('a dice master can import, exercise, and revoke original small Lua plugins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dice-lua-master-scenario-'));
  const output = join(directory, 'index.cjs');
  const originalSeal = globalThis.seal;
  const originalRandom = Math.random;
  try {
    const [coreSource, messageSource, lifecycleSource] = await Promise.all([
      readFile(new URL('../lua/master-import-core.lua', import.meta.url), 'utf8'),
      readFile(new URL('../lua/master-import-messages.lua', import.meta.url), 'utf8'),
      readFile(new URL('../lua/master-import-lifecycle.lua', import.meta.url), 'utf8'),
    ]);
    Math.random = () => 0.5;
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
      deck: {
        draw(_ctx, name) { return { exists: true, result: `deck:${name}` }; },
      },
      ext: {
        // Mirror the managed Goja bridge, which exposes a missing extension
        // as undefined rather than the declaration's null value.
        find() { return undefined; },
        getBoolConfig(_extension, key) { return config.get(key); },
        getIntConfig(_extension, key) { return config.get(key); },
        getStringConfig(_extension, key) { return config.get(key); },
        new() {
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
      format(_ctx, text) { return `fmt:${text}`; },
      replyPerson(_ctx, _msg, text) { replies.push({ hidden: true, text }); },
      replyToSender(_ctx, _msg, text) { replies.push({ hidden: false, text }); },
    };
    createRequire(import.meta.url)(output);

    const master = {
      endPoint: { userId: 'bot-1' },
      group: { groupId: '9001', groupName: 'Review room' },
      isPrivate: true,
      player: { name: 'Dice master' },
      privilegeLevel: 100,
    };
    const player = { ...master, isPrivate: false, player: { name: 'Reviewer' }, privilegeLevel: 0 };
    const messageFor = (text, userId = '6401', groupId = '9001') => ({
      channelId: '',
      groupId,
      message: text,
      platform: 'QQ',
      rawId: 'scenario-message',
      sender: { nickname: 'Reviewer', userId },
    });
    const takeReplies = () => replies.splice(0);
    const manage = (action, id, source = '') => {
      extension.cmdMap.luaplug.solve(master, messageFor('.luaplug'), commandArgs(action, id, source));
      return takeReplies();
    };
    const invoke = (name, text, ctx = player, userId = '6401', groupId = '9001') => {
      assert.ok(extension.cmdMap[name], `expected ${name} to be registered`);
      extension.cmdMap[name].solve(ctx, messageFor(text, userId, groupId), commandArgs());
      return takeReplies();
    };
    const receive = (text, ctx = player, userId = '6401', groupId = '9001') => {
      extension.onNotCommandReceived(ctx, messageFor(text, userId, groupId));
      return takeReplies();
    };

    assert.deepEqual(manage('add', 'master-core', coreSource), [
      { hidden: false, text: '操作完成：add master-core。' },
    ]);
    assert.deepEqual(manage('add', 'master-messages', messageSource), [
      { hidden: false, text: '操作完成：add master-messages。' },
    ]);
    assert.deepEqual(manage('add', 'master-lifecycle', lifecycleSource), [
      { hidden: false, text: '操作完成：add master-lifecycle。' },
    ]);
    assert.ok(extension.cmdMap.smhelp);
    assert.equal(extension.cmdMap['.smhelp'], undefined);

    const listed = manage('list', '');
    assert.equal(listed.length, 1);
    assert.match(listed[0].text, /master-core/u);
    assert.match(listed[0].text, /master-messages/u);
    assert.doesNotMatch(listed[0].text, /watch-help/u);
    const info = manage('info', 'master-core');
    assert.match(info[0].text, /源码字符数/u);
    assert.doesNotMatch(info[0].text, /watch-help/u);

    assert.deepEqual(invoke('smhelp', '.smhelp'), [
      { hidden: false, text: 'fmt:watch-help:6401@9001' },
    ]);
    assert.deepEqual(invoke('smroll', '.smroll 3 6 focus'), [
      { hidden: false, text: 'fmt:rolls=6,6,6;hits=3;topic=focus' },
    ]);
    assert.deepEqual(invoke('smroll', '.smroll'), [
      { hidden: false, text: 'fmt:usage:.smroll <count> <difficulty> [topic]' },
    ]);
    assert.deepEqual(invoke('smroll', '.smroll 7 6'), [
      { hidden: false, text: 'fmt:count-out-of-range' },
    ]);
    assert.deepEqual(invoke('smstate', '.smstate'), [
      { hidden: false, text: 'fmt:state=1;group=1;user=Reviewer;today=1' },
    ]);
    assert.deepEqual(invoke('smstate', '.smstate'), [
      { hidden: false, text: 'fmt:state=2;group=2;user=Reviewer;today=2' },
    ]);
    assert.deepEqual(invoke('smactor', '.smactor'), [
      { hidden: false, text: 'fmt:rank=1;locked=true' },
    ]);
    assert.deepEqual(invoke('smactor', '.smactor'), [
      { hidden: false, text: 'fmt:rank=2;locked=true' },
    ]);
    assert.deepEqual(invoke('smlimit', '.smlimit'), [
      { hidden: false, text: 'fmt:limited-command' },
    ]);
    assert.deepEqual(invoke('smlimit', '.smlimit', player, '6402'), []);

    assert.deepEqual(invoke('smdeck', '.smdeck'), [
      { hidden: false, text: 'fmt:deck:review-deck' },
    ]);
    assert.deepEqual(invoke('smqueue', '.smqueue'), [
      { hidden: false, text: 'fmt:queued:6401' },
      { hidden: false, text: 'fmt:queue-complete' },
    ]);
    assert.deepEqual(invoke('smprivate', '.smprivate'), [
      { hidden: true, text: 'fmt:private:6401' },
    ]);
    assert.deepEqual(invoke('smformat', '.smformat'), [
      { hidden: false, text: 'fmt:format-me' },
      { hidden: false, text: 'raw-me' },
      { hidden: false, text: 'fmt:format-complete' },
    ]);
    assert.deepEqual(invoke('smplain', '.smplain'), [
      { hidden: false, text: 'fmt:plain-reply' },
    ]);
    assert.deepEqual(invoke('smsandbox', '.smsandbox'), [
      { hidden: false, text: 'fmt:nil,nil,nil,nil,nil' },
    ]);
    assert.deepEqual(invoke('smburst', '.smburst'), [
      { hidden: false, text: 'fmt:burst-1' },
      { hidden: false, text: 'fmt:burst-2' },
      { hidden: false, text: 'fmt:burst-3' },
      { hidden: false, text: 'fmt:burst-4' },
    ]);

    assert.deepEqual(receive('WATCH PING'), [{ hidden: false, text: 'fmt:exact:6401' }]);
    assert.deepEqual(receive('watch signal north'), [{ hidden: false, text: 'fmt:prefix:north' }]);
    assert.deepEqual(receive('please watch find this'), [{ hidden: false, text: 'fmt:search-hit' }]);
    assert.deepEqual(receive('watch-42'), [{ hidden: false, text: 'fmt:regex-hit' }]);
    assert.deepEqual(receive('watch secret'), [{ hidden: false, text: 'fmt:restricted-hit' }]);
    assert.deepEqual(receive('watch secret', player, '6402'), []);

    extension.onLoad();
    assert.deepEqual(takeReplies(), []);
    assert.deepEqual(invoke('smevents', '.smevents'), [{ hidden: false, text: 'fmt:starts=1' }]);
    extension.onMessageReceived(player, messageFor('event input'));
    assert.deepEqual(takeReplies(), [{ hidden: false, text: 'fmt:received:event input' }]);
    extension.onGroupJoined(player, messageFor('joined input'));
    assert.deepEqual(takeReplies(), [{ hidden: false, text: 'fmt:joined:9001' }]);

    assert.deepEqual(manage('disable', 'master-messages'), [
      { hidden: false, text: '操作完成：disable master-messages。' },
    ]);
    assert.equal(extension.cmdMap.smdeck, undefined);
    assert.deepEqual(receive('watch ping'), []);
    assert.deepEqual(manage('enable', 'master-messages'), [
      { hidden: false, text: '操作完成：enable master-messages。' },
    ]);
    assert.deepEqual(invoke('smdeck', '.smdeck'), [
      { hidden: false, text: 'fmt:deck:review-deck' },
    ]);
    assert.deepEqual(manage('remove', 'master-lifecycle'), [
      { hidden: false, text: '操作完成：remove master-lifecycle。' },
    ]);
    assert.equal(extension.cmdMap.smevents, undefined);
  } finally {
    Math.random = originalRandom;
    globalThis.seal = originalSeal;
    await rm(directory, { force: true, recursive: true });
  }
});
