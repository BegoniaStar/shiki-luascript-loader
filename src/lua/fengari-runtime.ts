/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The low-level VM is vendored Fengari MIT source. This file deliberately
 * opens only pure Lua libraries; filesystem, process, native-module and
 * debugger entry points are absent from the Lua global environment.
 */

// Vendored Fengari is CommonJS JavaScript. TypeScript infers these modules as
// `any`; all use is contained in this adapter rather than leaking into bridge
// code.
// @ts-ignore -- vendored CommonJS implementation
import * as core from '../vendor/fengari/fengaricore.js';
// @ts-ignore -- vendored CommonJS implementation
import * as lua from '../vendor/fengari/lua.js';
// @ts-ignore -- vendored CommonJS implementation
import * as lauxlib from '../vendor/fengari/lauxlib.js';
// @ts-ignore -- vendored CommonJS implementation
import * as base from '../vendor/fengari/lbaselib.js';
// @ts-ignore -- vendored CommonJS implementation
import * as coroutine from '../vendor/fengari/lcorolib.js';
// @ts-ignore -- vendored CommonJS implementation
import * as math from '../vendor/fengari/lmathlib.js';
// @ts-ignore -- vendored CommonJS implementation
import * as string from '../vendor/fengari/lstrlib.js';
// @ts-ignore -- vendored CommonJS implementation
import * as table from '../vendor/fengari/ltablib.js';
// @ts-ignore -- vendored CommonJS implementation
import * as utf8 from '../vendor/fengari/lutf8lib.js';

export type LuaState = unknown;

export const luaApi = lua as Record<string, any>;
export const lauxlibApi = lauxlib as Record<string, any>;

export const toLuaString = (value: string): Uint8Array => core.to_luastring(value);
export const toJsString = (value: Uint8Array): string => core.to_jsstring(value);

function requireLibrary(
  state: LuaState,
  name: string,
  open: (state: LuaState) => number,
): void {
  lauxlibApi.luaL_requiref(state, toLuaString(name), open, 1);
  luaApi.lua_pop(state, 1);
}

/** Creates a Lua 5.3 state with only deterministic, pure standard libraries. */
export function createLuaState(): LuaState {
  const state = lauxlibApi.luaL_newstate() as LuaState;
  requireLibrary(state, '_G', base.luaopen_base);
  requireLibrary(state, 'coroutine', coroutine.luaopen_coroutine);
  requireLibrary(state, 'table', table.luaopen_table);
  requireLibrary(state, 'string', string.luaopen_string);
  requireLibrary(state, 'utf8', utf8.luaopen_utf8);
  requireLibrary(state, 'math', math.luaopen_math);

  // Base library exports these helpers, but their implementations load from
  // the host filesystem. They must not exist in the compatibility sandbox.
  luaApi.lua_pushnil(state);
  luaApi.lua_setglobal(state, toLuaString('dofile'));
  luaApi.lua_pushnil(state);
  luaApi.lua_setglobal(state, toLuaString('loadfile'));
  return state;
}

export function closeLuaState(state: LuaState): void {
  luaApi.lua_close(state);
}
