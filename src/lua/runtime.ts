/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { RuntimeConfig } from '../config';
import type { DiagnosticReporter } from '../diagnostics';
import type { LuaPluginPackage } from '../package-loader';
import type { CompatibilityStore, JsonObject, JsonValue } from '../storage';
import {
  installDiceBridge,
  pushContext,
  type LuaBridgeEnvironment,
  type LuaContextSnapshot,
} from './bridge';
import {
  closeLuaState,
  createLuaState,
  luaApi,
  lauxlibApi,
  toJsString,
  toLuaString,
  type LuaState,
} from './fengari-runtime';

export interface LuaBytecodeHandler {
  bytecode: Uint8Array;
  limit?: LuaTriggerLimit;
  /** Name of a top-level function that must be re-created from plugin source. */
  sourceFunction?: string;
  staticText?: string;
  title: string;
}

export interface LuaReplyDescriptor extends LuaBytecodeHandler {
  keywords: Readonly<{
    match: readonly string[];
    prefix: readonly string[];
    regex: readonly RegExp[];
    search: readonly string[];
  }>;
  limit: LuaTriggerLimit;
  type: 'Both' | 'Game' | 'Nor' | 'Order' | 'Reply';
}

/** The safe, host-independent subset of Dice!'s trigger limits. */
export interface LuaTriggerLimit {
  readonly userIds: readonly string[];
  readonly userIdNegative: boolean;
  readonly groupIds: readonly string[];
  readonly groupIdNegative: boolean;
  /** Dice! treats this as an integer percentage in the range 1..99. */
  readonly probability: number;
  readonly unsupported: readonly string[];
}

export interface LuaEventHandler extends LuaBytecodeHandler {
  hook: string;
}

export interface LuaPluginRuntime {
  file: string;
  id: string;
  modules: Readonly<Record<string, string>>;
  source: string;
  events: readonly LuaEventHandler[];
  orders: ReadonlyMap<string, LuaBytecodeHandler>;
  replies: readonly LuaReplyDescriptor[];
  sequence: number;
}

export interface InvocationHost {
  readonly drawDeck?: (groupId: string, userId: string, name: string) => string | null;
  readonly format: (text: string) => string;
  readonly getDiceQQ?: () => string;
  readonly random: () => number;
  readonly snapshot: JsonObject;
  readonly todayKey?: string;
}

export interface LuaOutput {
  hidden: boolean;
  text: string;
}

export type InvocationFailure = 'invalid-return' | 'output-limit' | 'runtime';

export interface InvocationResult {
  failure?: InvocationFailure;
  outputs: readonly LuaOutput[];
}

function luaString(state: LuaState, index: number): string | null {
  const value = luaApi.lua_tolstring(state, index) as Uint8Array | null;
  return value === null ? null : toJsString(value);
}

function clearStack(state: LuaState): void {
  luaApi.lua_settop(state, 0);
}

function luaErrorText(state: LuaState): string {
  return luaString(state, -1) ?? 'unknown-lua-error';
}

function dumpFunction(state: LuaState): Uint8Array | null {
  const chunks: Uint8Array[] = [];
  const status = luaApi.lua_dump(
    state,
    (_state: LuaState, block: Uint8Array): number => {
      chunks.push(new Uint8Array(block));
      return 0;
    },
    null,
    0,
  ) as number;
  if (status !== 0) return null;
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytecode = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytecode.set(chunk, offset);
    offset += chunk.length;
  }
  return bytecode;
}

function hasUnsupportedUpvalues(state: LuaState, index: number): boolean {
  const absolute = luaApi.lua_absindex(state, index) as number;
  for (let upvalue = 1; ; upvalue += 1) {
    const name = luaApi.lua_getupvalue(state, absolute, upvalue) as Uint8Array | null;
    if (name === null) return false;
    luaApi.lua_pop(state, 1);
    if (toJsString(name) !== '_ENV') return true;
  }
}

function handlerFromStack(
  state: LuaState,
  title: string,
  plugin: LuaPluginPackage,
  reporter: DiagnosticReporter,
): LuaBytecodeHandler | null {
  if (!luaApi.lua_isfunction(state, -1)) return null;
  if (hasUnsupportedUpvalues(state, -1)) {
    reporter.report({
      code: 'handler-captures-upvalues',
      file: plugin.file,
      pluginId: plugin.id,
      severity: 'warning',
      stage: 'registration',
    });
    return null;
  }
  const bytecode = dumpFunction(state);
  if (bytecode === null) {
    reporter.report({
      code: 'handler-dump-failed',
      file: plugin.file,
      pluginId: plugin.id,
      severity: 'error',
      stage: 'registration',
    });
    return null;
  }
  return { bytecode, title };
}

function staticHandlerFromStack(
  state: LuaState,
  title: string,
): LuaBytecodeHandler | null {
  const text = luaString(state, -1);
  return text === null ? null : { bytecode: new Uint8Array(), staticText: text, title };
}

function stringsFromValue(state: LuaState, index: number): string[] {
  if (luaApi.lua_isstring(state, index)) {
    const value = luaString(state, index);
    return value === null ? [] : [value];
  }
  if (!luaApi.lua_istable(state, index)) return [];
  const table = luaApi.lua_absindex(state, index) as number;
  const result: string[] = [];
  const length = luaApi.lua_rawlen(state, table) as number;
  for (let item = 1; item <= length; item += 1) {
    luaApi.lua_geti(state, table, item);
    const value = luaString(state, -1);
    luaApi.lua_pop(state, 1);
    if (value !== null) result.push(value);
  }
  return result;
}

function fieldStrings(state: LuaState, table: number, names: readonly string[]): string[] {
  for (const name of names) {
    luaApi.lua_getfield(state, table, toLuaString(name));
    const result = stringsFromValue(state, -1);
    luaApi.lua_pop(state, 1);
    if (result.length > 0) return result;
  }
  return [];
}

function emptyTriggerLimit(): LuaTriggerLimit {
  return {
    userIds: [],
    userIdNegative: false,
    groupIds: [],
    groupIdNegative: false,
    probability: 0,
    unsupported: [],
  };
}

function numericRuns(value: string): string[] {
  return [...value.matchAll(/\d+/gu)].map(([match]) => match);
}

function luaNumber(state: LuaState, index: number): number | null {
  if (!luaApi.lua_isnumber(state, index)) return null;
  const value = luaApi.lua_tonumberx(state, index) as number | false;
  return value === false || !Number.isFinite(value) ? null : value;
}

function tableIds(state: LuaState, index: number): {
  ids: string[];
  negative: boolean;
} {
  if (!luaApi.lua_istable(state, index)) {
    const value = luaString(state, index);
    return {
      ids: value === null ? [] : numericRuns(value),
      negative: value?.trimStart().startsWith('!') ?? false,
    };
  }
  const table = luaApi.lua_absindex(state, index) as number;
  let negative = false;
  const ids: string[] = [];
  luaApi.lua_getfield(state, table, toLuaString('nor'));
  if (!luaApi.lua_isnil(state, -1)) negative = true;
  const nor = luaApi.lua_absindex(state, -1) as number;
  const source = negative ? nor : table;
  if (luaApi.lua_istable(state, source)) {
    const length = luaApi.lua_rawlen(state, source) as number;
    for (let item = 1; item <= length; item += 1) {
      luaApi.lua_geti(state, source, item);
      const value = luaString(state, -1);
      if (value !== null) ids.push(...numericRuns(value));
      luaApi.lua_pop(state, 1);
    }
  } else {
    const value = luaString(state, source);
    if (value !== null) ids.push(...numericRuns(value));
  }
  luaApi.lua_pop(state, 1);
  return { ids: [...new Set(ids)], negative };
}

function readTriggerLimit(
  state: LuaState,
  table: number,
  plugin: LuaPluginPackage,
  reporter: DiagnosticReporter,
): LuaTriggerLimit {
  luaApi.lua_getfield(state, table, toLuaString('limit'));
  const valueIndex = luaApi.lua_absindex(state, -1) as number;
  const result = emptyTriggerLimit();
  const unsupported = new Set<string>();
  let userIds: string[] = [];
  let groupIds: string[] = [];
  let userIdNegative = false;
  let groupIdNegative = false;
  let probability = 0;
  const visit = (key: string, itemIndex: number): void => {
    if (key === 'prob') {
      const parsed = luaNumber(state, itemIndex);
      if (parsed !== null && Number.isInteger(parsed) && parsed > 0 && parsed < 100)
        probability = parsed;
      return;
    }
    if (key === 'user_id') {
      const parsed = tableIds(state, itemIndex);
      userIds = parsed.ids;
      userIdNegative = parsed.negative;
      return;
    }
    if (key === 'grp_id') {
      const parsed = tableIds(state, itemIndex);
      groupIds = parsed.ids;
      groupIdNegative = parsed.negative;
      return;
    }
    unsupported.add(key);
  };
  if (luaApi.lua_isstring(state, valueIndex)) {
    const raw = luaString(state, valueIndex) ?? '';
    for (const item of raw.split(';')) {
      const trimmed = item.trim();
      if (trimmed === '') continue;
      const colon = trimmed.indexOf(':');
      if (colon < 0) {
        unsupported.add(trimmed);
        continue;
      }
      // String values need a temporary Lua string to share the same parser.
      luaApi.lua_pushstring(state, toLuaString(trimmed.slice(colon + 1).trim()));
      visit(trimmed.slice(0, colon).trim(), -1);
      luaApi.lua_pop(state, 1);
    }
  } else if (luaApi.lua_istable(state, valueIndex)) {
    luaApi.lua_pushnil(state);
    while (luaApi.lua_next(state, valueIndex) !== 0) {
      const key = luaString(state, -2);
      if (key !== null) visit(key, -1);
      luaApi.lua_pop(state, 1);
    }
  }
  luaApi.lua_pop(state, 1);
  for (const key of unsupported) {
    reporter.report({
      code: 'unsupported-reply-limit',
      detail: key,
      file: plugin.file,
      pluginId: plugin.id,
      severity: 'warning',
      stage: 'registration',
    });
  }
  return {
    ...result,
    userIds,
    userIdNegative,
    groupIds,
    groupIdNegative,
    probability,
    unsupported: [...unsupported].sort(),
  };
}

function readReplyDescriptor(
  state: LuaState,
  title: string,
  plugin: LuaPluginPackage,
  reporter: DiagnosticReporter,
): LuaReplyDescriptor | null {
  if (!luaApi.lua_istable(state, -1)) return null;
  const table = luaApi.lua_absindex(state, -1) as number;
  luaApi.lua_getfield(state, table, toLuaString('keyword'));
  let match: string[] = [];
  let prefix: string[] = [];
  let search: string[] = [];
  let regexSource: string[] = [];
  if (luaApi.lua_istable(state, -1)) {
    const keyword = luaApi.lua_absindex(state, -1) as number;
    match = fieldStrings(state, keyword, ['Match', 'match']);
    prefix = fieldStrings(state, keyword, ['Prefix', 'prefix']);
    search = fieldStrings(state, keyword, ['Search', 'search']);
    regexSource = fieldStrings(state, keyword, ['Regex', 'regex']);
  } else {
    // Dice! defaults a reply's keyword to its table key.
    match = [title];
  }
  luaApi.lua_pop(state, 1);

  const regex: RegExp[] = [];
  for (const source of regexSource) {
    try {
      regex.push(new RegExp(source, 'iu'));
    } catch (error) {
      reporter.report({
        code: 'invalid-reply-regex',
        detail: String(error),
        file: plugin.file,
        pluginId: plugin.id,
        severity: 'warning',
        stage: 'registration',
      });
    }
  }
  if (match.length + prefix.length + search.length + regex.length === 0) return null;

  luaApi.lua_getfield(state, table, toLuaString('echo'));
  let handler: LuaBytecodeHandler | null = null;
  if (luaApi.lua_isfunction(state, -1)) {
    handler = handlerFromStack(state, title, plugin, reporter);
  } else if (luaApi.lua_isstring(state, -1)) {
    handler = staticHandlerFromStack(state, title);
  } else if (luaApi.lua_istable(state, -1)) {
    const echo = luaApi.lua_absindex(state, -1) as number;
    luaApi.lua_getfield(state, echo, toLuaString('lua'));
    if (luaApi.lua_isfunction(state, -1)) {
      handler = handlerFromStack(state, title, plugin, reporter);
    } else {
      luaApi.lua_pop(state, 1);
      luaApi.lua_getfield(state, echo, toLuaString('text'));
      if (luaApi.lua_isstring(state, -1)) handler = staticHandlerFromStack(state, title);
    }
    luaApi.lua_pop(state, 1);
  }
  luaApi.lua_pop(state, 1);
  if (handler === null) return null;

  const limit = readTriggerLimit(state, table, plugin, reporter);

  luaApi.lua_getfield(state, table, toLuaString('type'));
  const type = luaString(state, -1);
  luaApi.lua_pop(state, 1);
  const normalizedType = type?.toLowerCase();
  return {
    ...handler,
    keywords: { match, prefix, regex, search },
    limit,
    type:
      normalizedType === 'both' ? 'Both' :
      normalizedType === 'order' ? 'Order' :
      normalizedType === 'nor' ? 'Nor' :
      normalizedType === 'game' ? 'Game' : 'Reply',
  };
}

function readOrders(
  state: LuaState,
  plugin: LuaPluginPackage,
  reporter: DiagnosticReporter,
): ReadonlyMap<string, LuaBytecodeHandler> {
  const discovered: Array<[string, LuaBytecodeHandler]> = [];
  luaApi.lua_getglobal(state, toLuaString('msg_order'));
  if (!luaApi.lua_istable(state, -1)) {
    luaApi.lua_pop(state, 1);
    return new Map();
  }
  const table = luaApi.lua_absindex(state, -1) as number;
  luaApi.lua_pushnil(state);
  while (luaApi.lua_next(state, table) !== 0) {
    const title = luaString(state, -2);
    if (title !== null) {
      let handler: LuaBytecodeHandler | null = null;
      let limit: LuaTriggerLimit | undefined;
      if (luaApi.lua_isfunction(state, -1)) {
        handler = handlerFromStack(state, title, plugin, reporter);
      } else if (luaApi.lua_isstring(state, -1)) {
        // Dice!'s plugin loader treats a string-valued msg_order entry as the
        // name of a global function in the same source file.
        const functionName = luaString(state, -1);
        if (functionName !== null) {
          luaApi.lua_getglobal(state, toLuaString(functionName));
          if (luaApi.lua_isfunction(state, -1)) {
            handler = { bytecode: new Uint8Array(), sourceFunction: functionName, title };
          } else {
            reporter.report({
              code: 'invalid-order-function',
              detail: functionName,
              file: plugin.file,
              pluginId: plugin.id,
              severity: 'warning',
              stage: 'registration',
            });
          }
          luaApi.lua_pop(state, 1);
        }
      } else if (luaApi.lua_istable(state, -1)) {
        const descriptor = luaApi.lua_absindex(state, -1) as number;
        limit = readTriggerLimit(state, descriptor, plugin, reporter);
        for (const field of ['echo', 'lua', 'func']) {
          luaApi.lua_getfield(state, descriptor, toLuaString(field));
          if (luaApi.lua_isfunction(state, -1)) {
            handler = handlerFromStack(state, title, plugin, reporter);
            luaApi.lua_pop(state, 1);
            break;
          }
          if (field === 'echo' && luaApi.lua_isstring(state, -1)) {
            handler = staticHandlerFromStack(state, title);
            luaApi.lua_pop(state, 1);
            break;
          }
          if (luaApi.lua_istable(state, -1)) {
            const nested = luaApi.lua_absindex(state, -1) as number;
            luaApi.lua_getfield(state, nested, toLuaString('lua'));
            if (luaApi.lua_isfunction(state, -1)) {
              handler = handlerFromStack(state, title, plugin, reporter);
              luaApi.lua_pop(state, 1);
              luaApi.lua_pop(state, 1);
              break;
            }
            luaApi.lua_pop(state, 1);
            luaApi.lua_getfield(state, nested, toLuaString('text'));
            if (luaApi.lua_isstring(state, -1)) {
              handler = staticHandlerFromStack(state, title);
              luaApi.lua_pop(state, 1);
              luaApi.lua_pop(state, 1);
              break;
            }
            luaApi.lua_pop(state, 1);
          }
          luaApi.lua_pop(state, 1);
        }
      }
      if (handler !== null) {
        discovered.push([
          title,
          limit === undefined ? handler : { ...handler, limit },
        ]);
      }
    }
    luaApi.lua_pop(state, 1);
  }
  luaApi.lua_pop(state, 1);
  discovered.sort(([left], [right]) => left.localeCompare(right));
  return new Map(discovered);
}

function readReplies(
  state: LuaState,
  plugin: LuaPluginPackage,
  reporter: DiagnosticReporter,
): readonly LuaReplyDescriptor[] {
  const replies: Array<{ title: string; descriptor: LuaReplyDescriptor }> = [];
  luaApi.lua_getglobal(state, toLuaString('msg_reply'));
  if (!luaApi.lua_istable(state, -1)) {
    luaApi.lua_pop(state, 1);
    return [];
  }
  const table = luaApi.lua_absindex(state, -1) as number;
  luaApi.lua_pushnil(state);
  while (luaApi.lua_next(state, table) !== 0) {
    const title = luaString(state, -2);
    if (title !== null) {
      const descriptor = readReplyDescriptor(state, title, plugin, reporter);
      if (descriptor !== null) replies.push({ title, descriptor });
      else {
        reporter.report({
          code: 'invalid-reply-descriptor',
          file: plugin.file,
          pluginId: plugin.id,
          severity: 'warning',
          stage: 'registration',
        });
      }
    }
    luaApi.lua_pop(state, 1);
  }
  luaApi.lua_pop(state, 1);
  replies.sort(({ title: left }, { title: right }) => left.localeCompare(right));
  return replies.map(({ descriptor }) => descriptor);
}

function readEvents(
  state: LuaState,
  plugin: LuaPluginPackage,
  reporter: DiagnosticReporter,
): readonly LuaEventHandler[] {
  const discovered: Array<{ id: string; handler: LuaEventHandler }> = [];
  luaApi.lua_getglobal(state, toLuaString('event'));
  if (!luaApi.lua_istable(state, -1)) {
    luaApi.lua_pop(state, 1);
    return [];
  }
  const table = luaApi.lua_absindex(state, -1) as number;
  luaApi.lua_pushnil(state);
  while (luaApi.lua_next(state, table) !== 0) {
    const id = luaString(state, -2);
    let handler: LuaEventHandler | null = null;
    if (id !== null && luaApi.lua_istable(state, -1)) {
      const descriptor = luaApi.lua_absindex(state, -1) as number;
      let hook = '';
      for (const field of ['hook', 'Hook', 'Event', 'event']) {
        luaApi.lua_getfield(state, descriptor, toLuaString(field));
        hook = luaString(state, -1) ?? '';
        luaApi.lua_pop(state, 1);
        if (hook !== '') break;
      }
      // Dice!'s native Lua loader stores lifecycle hooks under
      // `trigger = { hook = 'MessageReceived' }`; accept the compact form
      // above as well because older plugins used it.
      if (hook === '') {
        luaApi.lua_getfield(state, descriptor, toLuaString('trigger'));
        if (luaApi.lua_istable(state, -1)) {
          const trigger = luaApi.lua_absindex(state, -1) as number;
          for (const field of ['hook', 'Hook', 'Event', 'event']) {
            luaApi.lua_getfield(state, trigger, toLuaString(field));
            hook = luaString(state, -1) ?? '';
            luaApi.lua_pop(state, 1);
            if (hook !== '') break;
          }
        }
        luaApi.lua_pop(state, 1);
      }
      luaApi.lua_getfield(state, descriptor, toLuaString('action'));
      if (luaApi.lua_istable(state, -1)) {
        const action = luaApi.lua_absindex(state, -1) as number;
        luaApi.lua_getfield(state, action, toLuaString('lua'));
        if (luaApi.lua_isfunction(state, -1)) {
          const bytecode = handlerFromStack(state, id, plugin, reporter);
          if (bytecode !== null) handler = { ...bytecode, hook };
        }
        luaApi.lua_pop(state, 1);
      }
      luaApi.lua_pop(state, 1);
    }
    if (handler !== null && id !== null && handler.hook !== '') discovered.push({ id, handler });
    else if (id !== null) {
      reporter.report({
        code: 'invalid-event-descriptor',
        file: plugin.file,
        pluginId: plugin.id,
        severity: 'warning',
        stage: 'registration',
      });
    }
    luaApi.lua_pop(state, 1);
  }
  luaApi.lua_pop(state, 1);
  discovered.sort(({ id: left }, { id: right }) => left.localeCompare(right));
  return discovered.map(({ handler }) => handler);
}

function reportUnsupportedRegistrations(
  state: LuaState,
  plugin: LuaPluginPackage,
  reporter: DiagnosticReporter,
): void {
  for (const name of ['task_call']) {
    luaApi.lua_getglobal(state, toLuaString(name));
    if (luaApi.lua_istable(state, -1)) {
      const table = luaApi.lua_absindex(state, -1) as number;
      luaApi.lua_pushnil(state);
      if (luaApi.lua_next(state, table) !== 0) {
        reporter.report({
          code: `unsupported-${name}-registration`,
          file: plugin.file,
          pluginId: plugin.id,
          severity: 'warning',
          stage: 'registration',
        });
        luaApi.lua_pop(state, 1);
      }
    }
    luaApi.lua_pop(state, 1);
  }
}

function registrationEnvironment(
  plugin: LuaPluginPackage,
  reporter: DiagnosticReporter,
): LuaBridgeEnvironment {
  return {
    context: { fields: {}, format: (text) => text },
    drawDeck: undefined,
    getDiceQQ: undefined,
    emit: () => undefined,
    getSelfData: () => ({}),
    modules: plugin.modules,
    pluginId: plugin.id,
    readScope: undefined,
    random: Math.random,
    reporter,
    sendMsg: undefined,
    writeScope: undefined,
    writeSelfData: () => true,
  };
}

function setRegistrationTables(state: LuaState): void {
  for (const name of ['msg_order', 'msg_reply', 'event', 'task_call']) {
    luaApi.lua_newtable(state);
    luaApi.lua_setglobal(state, toLuaString(name));
  }
}

function installInstructionBudget(state: LuaState, maxInstructions: number): void {
  const interval = Math.min(1_000, maxInstructions);
  let consumed = 0;
  luaApi.lua_sethook(
    state,
    (hookState: LuaState): void => {
      consumed += interval;
      if (consumed > maxInstructions)
        lauxlibApi.luaL_error(hookState, toLuaString('instruction-budget-exceeded'));
    },
    luaApi.LUA_MASKCOUNT,
    interval,
  );
}

/** Compiles one package in an isolated registration VM. */
export function registerLuaPlugin(
  plugin: LuaPluginPackage,
  config: RuntimeConfig,
  reporter: DiagnosticReporter,
): LuaPluginRuntime | null {
  const state = createLuaState();
  try {
    installDiceBridge(state, registrationEnvironment(plugin, reporter));
    setRegistrationTables(state);
    installInstructionBudget(state, config.maxVmInstructions);
    const loadStatus = lauxlibApi.luaL_loadstring(state, toLuaString(plugin.source)) as number;
    if (loadStatus !== luaApi.LUA_OK) {
      reporter.report({
        code: 'plugin-syntax-error',
        detail: luaErrorText(state),
        file: plugin.file,
        pluginId: plugin.id,
        severity: 'error',
        stage: 'registration',
      });
      return null;
    }
    const callStatus = luaApi.lua_pcall(state, 0, 0, 0) as number;
    if (callStatus !== luaApi.LUA_OK) {
      reporter.report({
        code: 'plugin-registration-failed',
        detail: luaErrorText(state),
        file: plugin.file,
        pluginId: plugin.id,
        severity: 'error',
        stage: 'registration',
      });
      return null;
    }
    const orders = readOrders(state, plugin, reporter);
    const replies = readReplies(state, plugin, reporter);
    const events = readEvents(state, plugin, reporter);
    reportUnsupportedRegistrations(state, plugin, reporter);
    return {
      file: plugin.file,
      id: plugin.id,
      modules: plugin.modules,
      source: plugin.source,
      events,
      orders,
      replies,
      sequence: plugin.sequence,
    };
  } catch (error) {
    reporter.report({
      code: 'plugin-registration-exception',
      detail: String(error),
      file: plugin.file,
      pluginId: plugin.id,
      severity: 'error',
      stage: 'registration',
    });
    return null;
  } finally {
    closeLuaState(state);
  }
}

/** Executes an event handler with the event Context in the global `event`. */
export function invokeLuaEventHandler(
  plugin: LuaPluginRuntime,
  handler: LuaEventHandler,
  host: InvocationHost,
  store: CompatibilityStore,
  config: RuntimeConfig,
  reporter: DiagnosticReporter,
): InvocationResult {
  const state = createLuaState();
  const collector = new OutputCollector(config);
  try {
    const environment = invocationEnvironment(plugin, store, host, collector, reporter);
    installDiceBridge(state, environment);
    installInstructionBudget(state, config.maxVmInstructions);
    const loadStatus = loadBytecode(state, handler.bytecode, handler.title);
    if (loadStatus !== luaApi.LUA_OK) return { failure: 'runtime', outputs: [] };
    pushContext(state, environment);
    luaApi.lua_setglobal(state, toLuaString('event'));
    const callStatus = luaApi.lua_pcall(state, 0, 2, 0) as number;
    if (callStatus !== luaApi.LUA_OK) {
      reporter.report({
        code: 'event-runtime-error',
        detail: luaErrorText(state),
        file: plugin.file,
        pluginId: plugin.id,
        severity: 'error',
        stage: 'invocation',
      });
      return { failure: 'runtime', outputs: [] };
    }
    for (const [index, hidden] of [[-2, false], [-1, true]] as const) {
      const type = luaApi.lua_type(state, index) as number;
      if (type === luaApi.LUA_TNIL) continue;
      if (type !== luaApi.LUA_TSTRING) return { failure: 'invalid-return', outputs: collector.outputs };
      const text = luaString(state, index);
      if (text !== null) collector.add(host.format(text), hidden);
    }
    return collector.didExceed
      ? { failure: 'output-limit', outputs: collector.outputs }
      : { outputs: collector.outputs };
  } catch (error) {
    reporter.report({
      code: 'event-invocation-exception',
      detail: String(error),
      file: plugin.file,
      pluginId: plugin.id,
      severity: 'error',
      stage: 'invocation',
    });
    return { failure: 'runtime', outputs: [] };
  } finally {
    clearStack(state);
    closeLuaState(state);
  }
}

class OutputCollector {
  private characters = 0;

  private exceeded = false;

  private readonly values: LuaOutput[] = [];

  public constructor(private readonly config: RuntimeConfig) {}

  public add(text: string, hidden: boolean): void {
    if (text === '') return;
    if (
      this.values.length >= this.config.maxOutputCount ||
      this.characters + text.length > this.config.maxOutputCharacters
    ) {
      this.exceeded = true;
      return;
    }
    this.characters += text.length;
    this.values.push({ hidden, text });
  }

  public get didExceed(): boolean {
    return this.exceeded;
  }

  public get outputs(): readonly LuaOutput[] {
    return this.values;
  }
}

function invocationEnvironment(
  plugin: LuaPluginRuntime,
  store: CompatibilityStore,
  host: InvocationHost,
  collector: OutputCollector,
  reporter: DiagnosticReporter,
): LuaBridgeEnvironment {
  const todayKey = host.todayKey ?? new Date().toISOString().slice(0, 10);
  const scopedId = (scope: 'group' | 'today' | 'user', id: string): string =>
    scope === 'today' ? `${todayKey}:${id}` : id;
  return {
    context: { fields: host.snapshot, format: host.format },
    drawDeck: host.drawDeck,
    getDiceQQ: host.getDiceQQ,
    emit: (text, hidden) => collector.add(text, hidden),
    getSelfData: (name) => store.readSelfData(plugin.id, name),
    modules: plugin.modules,
    pluginId: plugin.id,
    readScope: (scope, scopeId, key): JsonValue | undefined =>
      store.readScope(plugin.id, scope, scopedId(scope, scopeId), key),
    random: host.random,
    reporter,
    sendMsg: (text, hidden) => collector.add(host.format(text), hidden),
    writeScope: (scope, scopeId, key, value): boolean =>
      store.writeScope(plugin.id, scope, scopedId(scope, scopeId), key, value),
    writeSelfData: (name, value) => store.writeSelfData(plugin.id, name, value),
  };
}

function loadBytecode(
  state: LuaState,
  bytecode: Uint8Array,
  title: string,
): number {
  let read = false;
  return luaApi.lua_load(
    state,
    (): Uint8Array | null => {
      if (read) return null;
      read = true;
      return bytecode;
    },
    null,
    toLuaString(title),
    toLuaString('b'),
  ) as number;
}

function loadSourceFunction(
  state: LuaState,
  source: string,
  functionName: string,
): number {
  setRegistrationTables(state);
  const loadStatus = lauxlibApi.luaL_loadstring(state, toLuaString(source)) as number;
  if (loadStatus !== luaApi.LUA_OK) return loadStatus;
  const callStatus = luaApi.lua_pcall(state, 0, 0, 0) as number;
  if (callStatus !== luaApi.LUA_OK) return callStatus;
  luaApi.lua_getglobal(state, toLuaString(functionName));
  if (luaApi.lua_isfunction(state, -1)) return luaApi.LUA_OK;
  luaApi.lua_pop(state, 1);
  return lauxlibApi.luaL_error(state, toLuaString('source-handler-not-found')) as number;
}

/** Executes a dumped handler in a new VM and returns only bounded output. */
export function invokeLuaHandler(
  plugin: LuaPluginRuntime,
  handler: LuaBytecodeHandler,
  host: InvocationHost,
  store: CompatibilityStore,
  config: RuntimeConfig,
  reporter: DiagnosticReporter,
): InvocationResult {
  const collector = new OutputCollector(config);
  if (handler.staticText !== undefined) {
    try {
      collector.add(host.format(handler.staticText), false);
      return collector.didExceed
        ? { failure: 'output-limit', outputs: collector.outputs }
        : { outputs: collector.outputs };
    } catch (error) {
      reporter.report({
        code: 'handler-static-format-failed',
        detail: String(error),
        file: plugin.file,
        pluginId: plugin.id,
        severity: 'error',
        stage: 'invocation',
      });
      return { failure: 'runtime', outputs: [] };
    }
  }
  const state = createLuaState();
  try {
    const environment = invocationEnvironment(plugin, store, host, collector, reporter);
    installDiceBridge(state, environment);
    installInstructionBudget(state, config.maxVmInstructions);
    const loadStatus = handler.sourceFunction === undefined
      ? loadBytecode(state, handler.bytecode, handler.title)
      : loadSourceFunction(state, plugin.source, handler.sourceFunction);
    if (loadStatus !== luaApi.LUA_OK) {
      reporter.report({
        code: handler.sourceFunction === undefined
          ? 'handler-bytecode-load-failed'
          : 'handler-source-load-failed',
        detail: luaErrorText(state),
        file: plugin.file,
        pluginId: plugin.id,
        severity: 'error',
        stage: 'invocation',
      });
      return { failure: 'runtime', outputs: [] };
    }
    pushContext(state, environment);
    const callStatus = luaApi.lua_pcall(state, 1, 2, 0) as number;
    if (callStatus !== luaApi.LUA_OK) {
      reporter.report({
        code: 'handler-runtime-error',
        detail: luaErrorText(state),
        file: plugin.file,
        pluginId: plugin.id,
        severity: 'error',
        stage: 'invocation',
      });
      return { failure: 'runtime', outputs: [] };
    }
    for (const [index, hidden] of [[-2, false], [-1, true]] as const) {
      const type = luaApi.lua_type(state, index) as number;
      if (type === luaApi.LUA_TNIL) continue;
      if (type !== luaApi.LUA_TSTRING) {
        reporter.report({
          code: 'handler-invalid-return',
          file: plugin.file,
          pluginId: plugin.id,
          severity: 'warning',
          stage: 'invocation',
        });
        return { failure: 'invalid-return', outputs: collector.outputs };
      }
      const text = luaString(state, index);
      if (text !== null) collector.add(host.format(text), hidden);
    }
    if (collector.didExceed) {
      reporter.report({
        code: 'handler-output-limit',
        file: plugin.file,
        pluginId: plugin.id,
        severity: 'warning',
        stage: 'invocation',
      });
      return { failure: 'output-limit', outputs: collector.outputs };
    }
    return { outputs: collector.outputs };
  } catch (error) {
    reporter.report({
      code: 'handler-invocation-exception',
      detail: String(error),
      file: plugin.file,
      pluginId: plugin.id,
      severity: 'error',
      stage: 'invocation',
    });
    return { failure: 'runtime', outputs: [] };
  } finally {
    clearStack(state);
    closeLuaState(state);
  }
}

export function replyMatches(
  reply: LuaReplyDescriptor,
  message: string,
): { matched: boolean; suffix?: string } {
  const foldedMessage = message.toLowerCase();
  if (reply.keywords.match.some((value) => value.toLowerCase() === foldedMessage)) {
    return { matched: true };
  }
  for (const prefix of reply.keywords.prefix) {
    if (foldedMessage.startsWith(prefix.toLowerCase())) {
      return { matched: true, suffix: message.slice(prefix.length) };
    }
  }
  if (reply.keywords.search.some((needle) => foldedMessage.includes(needle.toLowerCase())))
    return { matched: true };
  for (const expression of reply.keywords.regex) {
    const match = expression.exec(message);
    if (match !== null && match.index === 0 && match[0].length === message.length) {
      return { matched: true };
    }
  }
  return { matched: false };
}

/** Applies the supported part of a reply's DiceTriggerLimit before execution. */
export function replyLimitAllows(
  reply: LuaReplyDescriptor,
  host: Pick<InvocationHost, 'random' | 'snapshot'>,
): boolean {
  return triggerLimitAllows(reply.limit, host);
}

/** Applies the supported DiceTriggerLimit subset to any executable handler. */
export function triggerLimitAllows(
  limit: LuaTriggerLimit,
  host: Pick<InvocationHost, 'random' | 'snapshot'>,
): boolean {
  const userId = typeof host.snapshot.uid === 'string' ? host.snapshot.uid : '';
  const groupId = typeof host.snapshot.gid === 'string' ? host.snapshot.gid : '';
  if (
    limit.userIds.length > 0 &&
    (limit.userIdNegative ? limit.userIds.includes(userId) : !limit.userIds.includes(userId))
  ) return false;
  if (
    limit.groupIds.length > 0 &&
    (limit.groupIdNegative ? limit.groupIds.includes(groupId) : !limit.groupIds.includes(groupId))
  ) return false;
  if (limit.probability > 0 && Math.floor(host.random() * 100) + 1 > limit.probability)
    return false;
  return true;
}
