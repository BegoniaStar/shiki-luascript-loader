/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { DiagnosticReporter } from '../diagnostics';
import type { JsonObject, JsonValue } from '../storage';
import { luaApi, lauxlibApi, toJsString, toLuaString, type LuaState } from './fengari-runtime';

const contextType = 'DiceCompat.Context';
const selfDataType = 'DiceCompat.SelfData';
const setType = 'DiceCompat.Set';
const actorType = 'DiceCompat.Actor';
const maxBridgeDepth = 16;

export interface LuaContextSnapshot {
  readonly fields: JsonObject;
  readonly format: (text: string) => string;
}

export interface LuaBridgeEnvironment {
  readonly context: LuaContextSnapshot;
  readonly drawDeck?: (groupId: string, userId: string, name: string) => string | null;
  readonly getDiceQQ?: () => string;
  readonly emit: (text: string, hidden: boolean) => void;
  readonly getSelfData: (name: string) => JsonValue;
  readonly modules: Readonly<Record<string, string>>;
  readonly pluginId: string;
  readonly readScope?: (
    scope: 'group' | 'today' | 'user',
    scopeId: string,
    key: string,
  ) => JsonValue | undefined;
  readonly random: () => number;
  readonly reporter: DiagnosticReporter;
  readonly sendMsg?: (text: string, hidden: boolean) => void;
  readonly writeScope?: (
    scope: 'group' | 'today' | 'user',
    scopeId: string,
    key: string,
    value: JsonValue | undefined,
  ) => boolean;
  readonly writeSelfData: (name: string, value: JsonValue) => boolean;
}

interface ContextData {
  environment: LuaBridgeEnvironment;
  scratch: JsonObject;
}

interface SelfDataData {
  environment: LuaBridgeEnvironment;
  name: string;
}

interface SetData {
  values: Map<string, JsonValue>;
}

interface ActorData {
  environment: LuaBridgeEnvironment;
  groupId: string;
  userId: string;
}

function luaString(state: LuaState, index: number): string | null {
  const value = luaApi.lua_tolstring(state, index) as Uint8Array | null;
  return value === null ? null : toJsString(value);
}

function luaError(state: LuaState, code: string): never {
  return lauxlibApi.luaL_error(state, toLuaString(code)) as never;
}

function userdata<T>(state: LuaState, index: number, type: string): T {
  return lauxlibApi.luaL_checkudata(state, index, toLuaString(type)) as T;
}

function jsonClone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > maxBridgeDepth) return false;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function pushJson(state: LuaState, value: JsonValue, depth = 0): void {
  if (depth > maxBridgeDepth) {
    luaApi.lua_pushnil(state);
    return;
  }
  if (value === null) {
    luaApi.lua_pushnil(state);
  } else if (typeof value === 'boolean') {
    luaApi.lua_pushboolean(state, value);
  } else if (typeof value === 'number') {
    if (Number.isInteger(value)) luaApi.lua_pushinteger(state, value);
    else luaApi.lua_pushnumber(state, value);
  } else if (typeof value === 'string') {
    luaApi.lua_pushstring(state, toLuaString(value));
  } else if (Array.isArray(value)) {
    luaApi.lua_createtable(state, value.length, 0);
    for (let index = 0; index < value.length; index += 1) {
      pushJson(state, value[index], depth + 1);
      luaApi.lua_seti(state, -2, index + 1);
    }
  } else {
    const entries = Object.entries(value);
    luaApi.lua_createtable(state, 0, entries.length);
    for (const [key, child] of entries) {
      pushJson(state, child, depth + 1);
      luaApi.lua_setfield(state, -2, toLuaString(key));
    }
  }
}

function luaValueToJson(
  state: LuaState,
  index: number,
  depth = 0,
  seen = new Set<unknown>(),
): JsonValue | undefined {
  if (depth > maxBridgeDepth) return undefined;
  switch (luaApi.lua_type(state, index)) {
    case luaApi.LUA_TNIL:
      return null;
    case luaApi.LUA_TBOOLEAN:
      return luaApi.lua_toboolean(state, index) as boolean;
    case luaApi.LUA_TNUMBER: {
      const value = luaApi.lua_tonumberx(state, index) as number | false;
      return value === false || !Number.isFinite(value) ? undefined : value;
    }
    case luaApi.LUA_TSTRING: {
      const value = luaString(state, index);
      return value === null ? undefined : value;
    }
    case luaApi.LUA_TTABLE:
      break;
    default:
      return undefined;
  }

  const pointer = luaApi.lua_topointer(state, index);
  if (seen.has(pointer)) return undefined;
  seen.add(pointer);
  const tableIndex = luaApi.lua_absindex(state, index) as number;
  const numericEntries = new Map<number, JsonValue>();
  // Null-prototype objects prevent Lua-controlled keys such as `__proto__`
  // from mutating the Goja host object during registration or invocation.
  const objectEntries = Object.create(null) as JsonObject;
  let canBeArray = true;
  luaApi.lua_pushnil(state);
  while (luaApi.lua_next(state, tableIndex) !== 0) {
    const keyType = luaApi.lua_type(state, -2);
    const child = luaValueToJson(state, -1, depth + 1, seen);
    if (child === undefined) {
      luaApi.lua_pop(state, 1);
      seen.delete(pointer);
      return undefined;
    }
    if (keyType === luaApi.LUA_TNUMBER) {
      const numberKey = luaApi.lua_tointegerx(state, -2) as number | false;
      if (numberKey === false || numberKey < 1) {
        luaApi.lua_pop(state, 1);
        seen.delete(pointer);
        return undefined;
      }
      numericEntries.set(numberKey, child);
    } else if (keyType === luaApi.LUA_TSTRING) {
      const key = luaString(state, -2);
      if (key === null) {
        luaApi.lua_pop(state, 1);
        seen.delete(pointer);
        return undefined;
      }
      canBeArray = false;
      objectEntries[key] = child;
    } else {
      luaApi.lua_pop(state, 1);
      seen.delete(pointer);
      return undefined;
    }
    luaApi.lua_pop(state, 1);
  }
  seen.delete(pointer);
  if (canBeArray) {
    const length = numericEntries.size;
    const array: JsonValue[] = [];
    for (let indexValue = 1; indexValue <= length; indexValue += 1) {
      const child = numericEntries.get(indexValue);
      if (child === undefined) return undefined;
      array.push(child);
    }
    return array;
  }
  for (const [key, value] of numericEntries) objectEntries[String(key)] = value;
  return objectEntries;
}

function contextValue(data: ContextData, key: string): JsonValue | undefined {
  if (Object.prototype.hasOwnProperty.call(data.scratch, key)) return data.scratch[key];
  return data.environment.context.fields[key];
}

function formattedContextKey(data: ContextData, key: string): string {
  return data.environment.context.format(key);
}

function contextIndex(state: LuaState): number {
  const data = userdata<ContextData>(state, 1, contextType);
  const key = luaString(state, 2);
  if (key === null) return 0;
  if (key === 'echo') {
    luaApi.lua_pushcfunction(state, contextEcho);
    return 1;
  }
  if (key === 'format') {
    luaApi.lua_pushcfunction(state, contextFormat);
    return 1;
  }
  if (key === 'get') {
    luaApi.lua_pushcfunction(state, contextGet);
    return 1;
  }
  if (key === 'inc') {
    luaApi.lua_pushcfunction(state, contextIncrement);
    return 1;
  }
  const value = contextValue(data, key);
  if (value === undefined) return 0;
  pushJson(state, value);
  return 1;
}

function contextNewIndex(state: LuaState): number {
  const data = userdata<ContextData>(state, 1, contextType);
  const key = luaString(state, 2);
  if (key === null) return luaError(state, 'invalid-context-key');
  const resolvedKey = formattedContextKey(data, key);
  if (luaApi.lua_isnoneornil(state, 3)) {
    delete data.scratch[resolvedKey];
    return 0;
  }
  const value = luaValueToJson(state, 3);
  if (value === undefined) return luaError(state, 'invalid-context-value');
  data.scratch[resolvedKey] = value;
  return 0;
}

function contextEcho(state: LuaState): number {
  const data = userdata<ContextData>(state, 1, contextType);
  const text = luaString(state, 2);
  if (text === null) return luaError(state, 'echo-requires-string');
  // Dice! uses the optional third argument as the inverse of formatting:
  // `msg:echo(text, true)` sends text verbatim, while the default formats it.
  const format = luaApi.lua_gettop(state) < 3 || !luaApi.lua_toboolean(state, 3);
  data.environment.emit(format ? data.environment.context.format(text) : text, false);
  return 0;
}

function contextFormat(state: LuaState): number {
  const data = userdata<ContextData>(state, 1, contextType);
  const text = luaString(state, 2);
  if (text === null) return luaError(state, 'format-requires-string');
  luaApi.lua_pushstring(state, toLuaString(data.environment.context.format(text)));
  return 1;
}

function contextGet(state: LuaState): number {
  const data = userdata<ContextData>(state, 1, contextType);
  if (luaApi.lua_isnoneornil(state, 2)) {
    pushJson(state, { ...data.environment.context.fields, ...data.scratch });
    return 1;
  }
  const key = luaString(state, 2);
  if (key === null) return luaError(state, 'invalid-context-key');
  const value = contextValue(data, formattedContextKey(data, key));
  if (value !== undefined) {
    pushJson(state, value);
    return 1;
  }
  if (luaApi.lua_gettop(state) >= 3) {
    luaApi.lua_pushvalue(state, 3);
    return 1;
  }
  return 0;
}

function contextIncrement(state: LuaState): number {
  const data = userdata<ContextData>(state, 1, contextType);
  const key = luaString(state, 2);
  if (key === null) return luaError(state, 'invalid-context-key');
  const resolvedKey = formattedContextKey(data, key);
  const current = contextValue(data, resolvedKey);
  if (current !== undefined && typeof current !== 'number')
    return luaError(state, 'context-value-is-not-number');
  const delta = luaApi.lua_gettop(state) >= 3
    ? (luaApi.lua_tonumberx(state, 3) as number | false)
    : 1;
  if (delta === false || !Number.isFinite(delta)) return luaError(state, 'invalid-increment');
  const next = (current ?? 0) + delta;
  data.scratch[resolvedKey] = next;
  luaApi.lua_pushnumber(state, next);
  return 1;
}

function selfDataIndex(state: LuaState): number {
  const data = userdata<SelfDataData>(state, 1, selfDataType);
  const key = luaString(state, 2);
  if (key === null) return 0;
  if (key === 'get') {
    luaApi.lua_pushcfunction(state, selfDataGet);
    return 1;
  }
  if (key === 'set') {
    luaApi.lua_pushcfunction(state, selfDataSet);
    return 1;
  }
  const value = data.environment.getSelfData(data.name);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 0;
  const child = value[key];
  if (child === undefined) return 0;
  pushJson(state, child);
  return 1;
}

function selfDataNewIndex(state: LuaState): number {
  const data = userdata<SelfDataData>(state, 1, selfDataType);
  const key = luaString(state, 2);
  if (key === null) return luaError(state, 'invalid-selfdata-key');
  const current = data.environment.getSelfData(data.name);
  const next: JsonObject =
    typeof current === 'object' && current !== null && !Array.isArray(current)
      ? jsonClone(current)
      : {};
  if (luaApi.lua_isnoneornil(state, 3)) delete next[key];
  else {
    const child = luaValueToJson(state, 3);
    if (child === undefined) return luaError(state, 'invalid-selfdata-value');
    next[key] = child;
  }
  if (!data.environment.writeSelfData(data.name, next))
    return luaError(state, 'selfdata-write-rejected');
  return 0;
}

function selfDataGet(state: LuaState): number {
  const data = userdata<SelfDataData>(state, 1, selfDataType);
  const value = data.environment.getSelfData(data.name);
  if (luaApi.lua_isnoneornil(state, 2)) {
    pushJson(state, value);
    return 1;
  }
  const key = luaString(state, 2);
  if (key === null || typeof value !== 'object' || value === null || Array.isArray(value))
    return 0;
  const child = value[key];
  if (child !== undefined) {
    pushJson(state, child);
    return 1;
  }
  if (luaApi.lua_gettop(state) >= 3) {
    luaApi.lua_pushvalue(state, 3);
    return 1;
  }
  return 0;
}

function selfDataSet(state: LuaState): number {
  const data = userdata<SelfDataData>(state, 1, selfDataType);
  if (luaApi.lua_istable(state, 2)) {
    const value = luaValueToJson(state, 2);
    if (value === undefined || !data.environment.writeSelfData(data.name, value))
      return luaError(state, 'selfdata-write-rejected');
    return 0;
  }
  return selfDataNewIndex(state);
}

function actorScope(data: ActorData): string {
  return `actor:${data.userId}:${data.groupId}`;
}

function actorRead(data: ActorData, key: string): JsonValue | undefined {
  return data.environment.readScope?.('user', actorScope(data), `attr:${key}`);
}

function actorWrite(data: ActorData, key: string, value: JsonValue | undefined): boolean {
  return data.environment.writeScope?.('user', actorScope(data), `attr:${key}`, value) ?? false;
}

function actorLocked(data: ActorData, key: string): boolean {
  return data.environment.readScope?.('user', actorScope(data), `lock:${key}`) === true;
}

function actorIndex(state: LuaState): number {
  const data = userdata<ActorData>(state, 1, actorType);
  const key = luaString(state, 2);
  if (key === null) return 0;
  const methods: Record<string, (state: LuaState) => number> = {
    get: actorGet,
    set: actorSet,
    rollDice: unsupported,
    locked: actorLockedMethod,
    lock: actorLock,
    unlock: actorUnlock,
  };
  const method = methods[key];
  if (method !== undefined) {
    luaApi.lua_pushcfunction(state, method);
    return 1;
  }
  const value = actorRead(data, key);
  if (value === undefined) return 0;
  pushJson(state, value);
  return 1;
}

function actorNewIndex(state: LuaState): number {
  const data = userdata<ActorData>(state, 1, actorType);
  const key = luaString(state, 2);
  if (key === null) return luaError(state, 'invalid-actor-key');
  const value = luaApi.lua_isnoneornil(state, 3) ? undefined : luaValueToJson(state, 3);
  if (luaApi.lua_gettop(state) >= 3 && value === undefined && !luaApi.lua_isnoneornil(state, 3)) {
    return luaError(state, 'invalid-actor-value');
  }
  if (!actorWrite(data, key, value)) return luaError(state, 'actor-write-rejected');
  return 0;
}

function actorGet(state: LuaState): number {
  const data = userdata<ActorData>(state, 1, actorType);
  const key = luaString(state, 2);
  if (key === null) return 0;
  const value = actorRead(data, key);
  if (value === undefined) {
    if (luaApi.lua_gettop(state) >= 3) luaApi.lua_pushvalue(state, 3);
    else luaApi.lua_pushnil(state);
    return 1;
  }
  pushJson(state, value);
  return 1;
}

function actorSet(state: LuaState): number {
  const data = userdata<ActorData>(state, 1, actorType);
  if (luaApi.lua_istable(state, 2)) {
    const value = luaValueToJson(state, 2);
    if (!Array.isArray(value) && value !== null && typeof value === 'object') {
      let count = 0;
      for (const [key, child] of Object.entries(value)) {
        if (actorWrite(data, key, child)) count += 1;
      }
      luaApi.lua_pushinteger(state, count);
      return 1;
    }
    return luaError(state, 'invalid-actor-value');
  }
  const key = luaString(state, 2);
  if (key === null) return 0;
  const value = luaApi.lua_isnoneornil(state, 3) ? undefined : luaValueToJson(state, 3);
  if (luaApi.lua_gettop(state) >= 3 && value === undefined && !luaApi.lua_isnoneornil(state, 3)) {
    return luaError(state, 'invalid-actor-value');
  }
  if (!actorWrite(data, key, value)) return luaError(state, 'actor-write-rejected');
  luaApi.lua_pushboolean(state, value !== undefined);
  return 1;
}

function actorLockedMethod(state: LuaState): number {
  const data = userdata<ActorData>(state, 1, actorType);
  const key = luaString(state, 2);
  luaApi.lua_pushboolean(state, key !== null && actorLocked(data, key));
  return 1;
}

function actorLock(state: LuaState): number {
  const data = userdata<ActorData>(state, 1, actorType);
  const key = luaString(state, 2);
  if (key === null) return luaError(state, 'invalid-actor-key');
  const changed = !actorLocked(data, key);
  if (changed && !(data.environment.writeScope?.('user', actorScope(data), `lock:${key}`, true) ?? false)) {
    return luaError(state, 'actor-lock-rejected');
  }
  luaApi.lua_pushboolean(state, changed);
  return 1;
}

function actorUnlock(state: LuaState): number {
  const data = userdata<ActorData>(state, 1, actorType);
  const key = luaString(state, 2);
  if (key === null) return luaError(state, 'invalid-actor-key');
  const changed = actorLocked(data, key);
  if (changed && !(data.environment.writeScope?.('user', actorScope(data), `lock:${key}`, undefined) ?? false)) {
    return luaError(state, 'actor-unlock-rejected');
  }
  luaApi.lua_pushboolean(state, changed);
  return 1;
}

function actorUserId(state: LuaState, index: number): string | null {
  return scopeArgument(state, index);
}

function pushActor(state: LuaState, environment: LuaBridgeEnvironment, userId: string, groupId: string): number {
  const data = luaApi.lua_newuserdata(state, 0) as ActorData;
  data.environment = environment;
  data.userId = userId;
  data.groupId = groupId;
  lauxlibApi.luaL_setmetatable(state, toLuaString(actorType));
  return 1;
}

function getPlayerCard(state: LuaState): number {
  const environment = stateEnvironment(state);
  const userId = actorUserId(state, 1);
  const groupId = actorUserId(state, 2);
  if (userId === null || groupId === null) return 0;
  return pushActor(state, environment, userId, groupId);
}

function getPlayerCardAttr(state: LuaState): number {
  const environment = stateEnvironment(state);
  const userId = actorUserId(state, 1);
  const groupId = actorUserId(state, 2);
  const key = luaString(state, 3);
  if (userId === null || groupId === null || key === null) return 0;
  const data: ActorData = { environment, userId, groupId };
  const value = actorRead(data, key);
  if (value === undefined) {
    if (luaApi.lua_gettop(state) >= 4) luaApi.lua_pushvalue(state, 4);
    else luaApi.lua_pushnil(state);
  } else pushJson(state, value);
  return 1;
}

function setPlayerCardAttr(state: LuaState): number {
  const environment = stateEnvironment(state);
  const userId = actorUserId(state, 1);
  const groupId = actorUserId(state, 2);
  const key = luaString(state, 3);
  if (userId === null || groupId === null || key === null) return 0;
  const data: ActorData = { environment, userId, groupId };
  const value = luaApi.lua_isnoneornil(state, 4) ? undefined : luaValueToJson(state, 4);
  if (luaApi.lua_gettop(state) >= 4 && value === undefined && !luaApi.lua_isnoneornil(state, 4)) {
    return luaError(state, 'invalid-actor-value');
  }
  if (!actorWrite(data, key, value)) return luaError(state, 'actor-write-rejected');
  return 0;
}

function setKey(value: JsonValue): string {
  return `${typeof value}:${JSON.stringify(value)}`;
}

function setIndex(state: LuaState): number {
  const data = userdata<SetData>(state, 1, setType);
  const key = luaString(state, 2);
  if (key === 'in') {
    luaApi.lua_pushcfunction(state, setIn);
    return 1;
  }
  if (key === 'add') {
    luaApi.lua_pushcfunction(state, setAdd);
    return 1;
  }
  if (key === 'remove') {
    luaApi.lua_pushcfunction(state, setRemove);
    return 1;
  }
  if (key === 'totable') {
    luaApi.lua_pushcfunction(state, setToTable);
    return 1;
  }
  const value = luaValueToJson(state, 2);
  if (value === undefined) return 0;
  luaApi.lua_pushboolean(state, data.values.has(setKey(value)));
  return 1;
}

function setNew(state: LuaState): number {
  const data = luaApi.lua_newuserdata(state, 0) as SetData;
  data.values = new Map<string, JsonValue>();
  lauxlibApi.luaL_setmetatable(state, toLuaString(setType));
  return 1;
}

function setIn(state: LuaState): number {
  const data = userdata<SetData>(state, 1, setType);
  const value = luaValueToJson(state, 2);
  luaApi.lua_pushboolean(state, value !== undefined && data.values.has(setKey(value)));
  return 1;
}

function setAdd(state: LuaState): number {
  const data = userdata<SetData>(state, 1, setType);
  const value = luaValueToJson(state, 2);
  if (value === undefined) return luaError(state, 'invalid-set-value');
  const key = setKey(value);
  const isNew = !data.values.has(key);
  data.values.set(key, value);
  luaApi.lua_pushboolean(state, isNew);
  return 1;
}

function setRemove(state: LuaState): number {
  const data = userdata<SetData>(state, 1, setType);
  const value = luaValueToJson(state, 2);
  luaApi.lua_pushboolean(
    state,
    value !== undefined && data.values.delete(setKey(value)),
  );
  return 1;
}

function setLength(state: LuaState): number {
  const data = userdata<SetData>(state, 1, setType);
  luaApi.lua_pushinteger(state, data.values.size);
  return 1;
}

function setToTable(state: LuaState): number {
  const data = userdata<SetData>(state, 1, setType);
  pushJson(state, [...data.values.values()]);
  return 1;
}

function registerMetatable(
  state: LuaState,
  name: string,
  members: Record<string, (state: LuaState) => number>,
): void {
  const created = lauxlibApi.luaL_newmetatable(state, toLuaString(name)) as number;
  if (created !== 0) lauxlibApi.luaL_setfuncs(state, members, 0);
  luaApi.lua_pop(state, 1);
}

function getSelfData(state: LuaState): number {
  const name = luaString(state, 1);
  if (name === null) return luaError(state, 'selfdata-name-requires-string');
  const environment = stateEnvironment(state);
  const data = luaApi.lua_newuserdata(state, 0) as SelfDataData;
  data.environment = environment;
  data.name = name;
  lauxlibApi.luaL_setmetatable(state, toLuaString(selfDataType));
  return 1;
}

function randomInteger(state: LuaState): number {
  const environment = stateEnvironment(state);
  const lower = lauxlibApi.luaL_checkinteger(state, 1) as number;
  const upper = lauxlibApi.luaL_checkinteger(state, 2) as number;
  if (lower > upper) return luaError(state, 'invalid-random-range');
  luaApi.lua_pushinteger(
    state,
    lower + Math.floor(environment.random() * (upper - lower + 1)),
  );
  return 1;
}

function scopeArgument(state: LuaState, index: number): string | null {
  if (luaApi.lua_isstring(state, index)) return luaString(state, index);
  if (luaApi.lua_isnumber(state, index)) {
    const value = luaApi.lua_tonumberx(state, index) as number | false;
    return value !== false && Number.isFinite(value) ? String(value) : null;
  }
  return null;
}

function readScopeValue(
  state: LuaState,
  scope: 'group' | 'user' | 'today',
): number {
  const environment = stateEnvironment(state);
  const scopeId = scopeArgument(state, 1);
  const key = luaString(state, 2);
  if (
    scopeId === null ||
    key === null ||
    environment.readScope === undefined
  ) return 0;
  const value = environment.readScope(scope, scopeId, key);
  if (value !== undefined) {
    pushJson(state, value);
    return 1;
  }
  if (luaApi.lua_gettop(state) >= 3) {
    luaApi.lua_pushvalue(state, 3);
    return 1;
  }
  if (scope === 'today') {
    luaApi.lua_pushinteger(state, 0);
    return 1;
  }
  return 0;
}

function writeScopeValue(
  state: LuaState,
  scope: 'group' | 'user' | 'today',
): number {
  const environment = stateEnvironment(state);
  const scopeId = scopeArgument(state, 1);
  const key = luaString(state, 2);
  if (
    scopeId === null ||
    key === null ||
    environment.writeScope === undefined
  ) return 0;
  const value = luaApi.lua_isnoneornil(state, 3)
    ? undefined
    : luaValueToJson(state, 3);
  if (luaApi.lua_gettop(state) >= 3 && value === undefined && !luaApi.lua_isnoneornil(state, 3)) {
    return luaError(state, 'invalid-scoped-value');
  }
  if (!environment.writeScope(scope, scopeId, key, value)) {
    return luaError(state, 'scoped-write-rejected');
  }
  return 0;
}

function getGroupConf(state: LuaState): number {
  return readScopeValue(state, 'group');
}

function setGroupConf(state: LuaState): number {
  return writeScopeValue(state, 'group');
}

function getUserConf(state: LuaState): number {
  return readScopeValue(state, 'user');
}

function setUserConf(state: LuaState): number {
  return writeScopeValue(state, 'user');
}

function getUserToday(state: LuaState): number {
  return readScopeValue(state, 'today');
}

function setUserToday(state: LuaState): number {
  return writeScopeValue(state, 'today');
}

function drawDeck(state: LuaState): number {
  const environment = stateEnvironment(state);
  const groupId = luaString(state, 1) ?? String(luaApi.lua_tointegerx(state, 1) as number);
  const userId = luaString(state, 2) ?? String(luaApi.lua_tointegerx(state, 2) as number);
  const name = luaString(state, 3);
  if (name === null || environment.drawDeck === undefined) return 0;
  const result = environment.drawDeck(groupId, userId, name);
  if (result === null) return 0;
  luaApi.lua_pushstring(state, toLuaString(result));
  return 1;
}

function messageTargetId(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value === '0' ? '' : value;
  if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? '' : String(value);
  return '';
}

/** Sends only to the current SealDice target; cross-target queueing is forbidden. */
function sendMsg(state: LuaState): number {
  const environment = stateEnvironment(state);
  if (environment.sendMsg === undefined) return luaError(state, 'unsupported-api');
  let text: string | null = null;
  let groupId = '';
  let userId = '';
  if (luaApi.lua_istable(state, 1)) {
    const value = luaValueToJson(state, 1);
    if (value === undefined || value === null || Array.isArray(value) || typeof value !== 'object')
      return luaError(state, 'invalid-send-message');
    text = typeof value.fwdMsg === 'string' ? value.fwdMsg : null;
    groupId = messageTargetId(value.gid);
    userId = messageTargetId(value.uid);
  } else {
    text = luaString(state, 1);
    groupId = messageTargetId(scopeArgument(state, 2));
    userId = messageTargetId(scopeArgument(state, 3));
  }
  if (text === null || text === '') return 0;
  const currentGroup = messageTargetId(environment.context.fields.gid);
  const currentUser = messageTargetId(environment.context.fields.uid);
  const isGroup = groupId !== '';
  const targetMatches = isGroup
    ? groupId === currentGroup
    : userId !== '' && userId === currentUser;
  if (!targetMatches) return luaError(state, 'cross-target-send-unsupported');
  environment.sendMsg(text, !isGroup);
  return 0;
}

function getDiceQQ(state: LuaState): number {
  const environment = stateEnvironment(state);
  if (environment.getDiceQQ === undefined) return 0;
  luaApi.lua_pushstring(state, toLuaString(environment.getDiceQQ()));
  return 1;
}

function log(state: LuaState): number {
  const text = luaString(state, 1);
  if (text !== null) console.info(`[DiceLuaCompat][plugin-log] ${text}`);
  return 0;
}

function loadLua(state: LuaState): number {
  const environment = stateEnvironment(state);
  const name = luaString(state, 1);
  if (name === null || !Object.prototype.hasOwnProperty.call(environment.modules, name))
    return luaError(state, 'module-not-declared');
  const source = environment.modules[name];
  const status = lauxlibApi.luaL_loadstring(state, toLuaString(source)) as number;
  if (status !== luaApi.LUA_OK) return luaError(state, 'module-load-failed');
  const callStatus = luaApi.lua_pcall(state, 0, 1, 0) as number;
  if (callStatus !== luaApi.LUA_OK) return luaError(state, 'module-execution-failed');
  return 1;
}

function urlEncode(state: LuaState): number {
  const text = luaString(state, 1);
  if (text === null) return luaError(state, 'urlencode-requires-string');
  luaApi.lua_pushstring(state, toLuaString(encodeURIComponent(text)));
  return 1;
}

function urlDecode(state: LuaState): number {
  const text = luaString(state, 1);
  if (text === null) return luaError(state, 'urldecode-requires-string');
  try {
    luaApi.lua_pushstring(state, toLuaString(decodeURIComponent(text)));
    return 1;
  } catch {
    return luaError(state, 'invalid-url-encoding');
  }
}

function unsupported(state: LuaState): number {
  return luaError(state, 'unsupported-api');
}

const environmentByState = new WeakMap<object, LuaBridgeEnvironment>();

function stateEnvironment(state: LuaState): LuaBridgeEnvironment {
  const environment = environmentByState.get(state as object);
  if (environment === undefined) throw new Error('Lua bridge environment missing');
  return environment;
}

export function pushContext(state: LuaState, environment: LuaBridgeEnvironment): void {
  const data = luaApi.lua_newuserdata(state, 0) as ContextData;
  data.environment = environment;
  data.scratch = Object.create(null) as JsonObject;
  lauxlibApi.luaL_setmetatable(state, toLuaString(contextType));
}

/** Installs only the explicit Dice! compatibility bridge into a pure Lua VM. */
export function installDiceBridge(
  state: LuaState,
  environment: LuaBridgeEnvironment,
): void {
  environmentByState.set(state as object, environment);
  registerMetatable(state, contextType, {
    __index: contextIndex,
    __newindex: contextNewIndex,
  });
  registerMetatable(state, selfDataType, {
    __index: selfDataIndex,
    __newindex: selfDataNewIndex,
  });
  registerMetatable(state, setType, {
    __index: setIndex,
    __len: setLength,
  });
  registerMetatable(state, actorType, {
    __index: actorIndex,
    __newindex: actorNewIndex,
  });

  luaApi.lua_register(state, toLuaString('getSelfData'), getSelfData);
  luaApi.lua_register(state, toLuaString('log'), log);
  luaApi.lua_register(state, toLuaString('loadLua'), loadLua);
  luaApi.lua_register(state, toLuaString('ranint'), randomInteger);
  luaApi.lua_register(state, toLuaString('drawDeck'), drawDeck);
  luaApi.lua_register(state, toLuaString('sendMsg'), sendMsg);
  luaApi.lua_register(state, toLuaString('getDiceQQ'), getDiceQQ);
  luaApi.lua_register(state, toLuaString('getGroupConf'), getGroupConf);
  luaApi.lua_register(state, toLuaString('setGroupConf'), setGroupConf);
  luaApi.lua_register(state, toLuaString('getUserConf'), getUserConf);
  luaApi.lua_register(state, toLuaString('setUserConf'), setUserConf);
  luaApi.lua_register(state, toLuaString('getUserToday'), getUserToday);
  luaApi.lua_register(state, toLuaString('setUserToday'), setUserToday);
  luaApi.lua_register(state, toLuaString('getPlayerCard'), getPlayerCard);
  luaApi.lua_register(state, toLuaString('getPlayerCardAttr'), getPlayerCardAttr);
  luaApi.lua_register(state, toLuaString('setPlayerCardAttr'), setPlayerCardAttr);

  luaApi.lua_newtable(state);
  luaApi.lua_pushcfunction(state, urlEncode);
  luaApi.lua_setfield(state, -2, toLuaString('urlEncode'));
  luaApi.lua_pushcfunction(state, urlDecode);
  luaApi.lua_setfield(state, -2, toLuaString('urlDecode'));
  luaApi.lua_pushcfunction(state, unsupported);
  luaApi.lua_setfield(state, -2, toLuaString('get'));
  luaApi.lua_pushcfunction(state, unsupported);
  luaApi.lua_setfield(state, -2, toLuaString('post'));
  luaApi.lua_setglobal(state, toLuaString('http'));

  luaApi.lua_newtable(state);
  luaApi.lua_pushcfunction(state, setNew);
  luaApi.lua_setfield(state, -2, toLuaString('new'));
  luaApi.lua_setglobal(state, toLuaString('Set'));

  // The constructor is intentionally absent; Actor instances come from
  // getPlayerCard and remain scoped to the current plugin storage namespace.
  luaApi.lua_newtable(state);
  luaApi.lua_setglobal(state, toLuaString('Actor'));
}

export function luaToJsonValue(
  state: LuaState,
  index: number,
): JsonValue | undefined {
  return luaValueToJson(state, index);
}
