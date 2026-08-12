/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * SealDice host adapter. Lua execution is delegated to src/lua/runtime.ts;
 * this file only translates SealDice messages and reuses its command/reply,
 * formatting and extension-storage facilities.
 */

import { extensionName, readConfig, registerConfig, type RuntimeConfig } from './config';
import { DiagnosticCollector, logDiagnostic, reportException } from './diagnostics';
import { isSafePluginId, loadPluginPackages, type LuaPluginPackage } from './package-loader';
import {
  invokeLuaHandler,
  invokeLuaEventHandler,
  registerLuaPlugin,
  replyLimitAllows,
  replyMatches,
  triggerLimitAllows,
  type InvocationHost,
  type InvocationResult,
  type LuaOutput,
  type LuaPluginRuntime,
} from './lua/runtime';
import { CompatibilityStore, type JsonObject } from './storage';
import {
  RuntimePluginRegistry,
  type ManagedPluginInfo,
  type RuntimePluginRegistryResult,
} from './runtime-plugin-registry';

interface OwnedState {
  commandNames: string[];
  runtimes: readonly LuaPluginRuntime[];
}

const existing = seal.ext.find(extensionName);
const extension = existing ?? seal.ext.new(extensionName, 'BegoniaStar', '0.1.1');

// The declared API returns null, while the managed Goja bridge exposes a
// missing extension as undefined. Treat both as an unregistered extension.
if (existing === null || existing === undefined) {
  seal.ext.register(extension);
}
extension.autoActive = true;
registerConfig(extension);

const reporter = new DiagnosticCollector();
const config = readConfig(extension);
// ExtInfo is a non-extensible Go object in the real Goja host. Keep reload
// bookkeeping in a JS-owned side table rather than assigning private fields.
const ownedStates = new WeakMap<seal.ExtInfo, OwnedState>();
const priorState = ownedStates.get(extension);
if (priorState !== undefined) {
  for (const commandName of priorState.commandNames) {
    if (extension.cmdMap[commandName] !== undefined) delete extension.cmdMap[commandName];
  }
}

const store = new CompatibilityStore(extension, {
  maxBytes: config.maxStorageBytes,
  maxDepth: config.maxStorageDepth,
  maxKeys: config.maxStorageKeys,
}, reporter);

const runtimeRegistry = new RuntimePluginRegistry(extension, {
  maxBytes: config.managementMaxBytes,
  maxPlugins: config.managementMaxPlugins,
  maxSourceCharacters: config.maxSourceCharacters,
}, reporter);

function safeMessageId(rawId: unknown): string {
  if (typeof rawId === 'string') return rawId;
  if (typeof rawId === 'number' && Number.isFinite(rawId)) return String(rawId);
  return '';
}

function snapshotFor(ctx: seal.MsgContext, msg: seal.Message, suffix = ''): JsonObject {
  const groupId = msg.groupId || ctx.group?.groupId || '';
  const channelId = msg.channelId || ctx.group?.channelId || '';
  const senderId = msg.sender.userId || '';
  const nickname = msg.sender.nickname || ctx.player?.name || senderId;
  const fields: JsonObject = {
    chid: channelId,
    gid: groupId,
    fromMsg: msg.message,
    group: { id: groupId, name: ctx.group?.groupName ?? '' },
    grp: { id: groupId, name: ctx.group?.groupName ?? '' },
    isPrivate: ctx.isPrivate,
    msgid: safeMessageId(msg.rawId),
    nick: nickname,
    platform: msg.platform,
    suffix,
    uid: senderId,
    user: { id: senderId, name: nickname },
  };
  return fields;
}

function invocationHost(
  ctx: seal.MsgContext,
  msg: seal.Message,
  suffix = '',
): InvocationHost {
  return {
    drawDeck: (groupId, _userId, name) => {
      const result = seal.deck.draw(ctx, name, true) as {
        exists?: boolean;
        result?: string;
      };
      if (result.exists === false) return `{${name}}`;
      return result.result ?? null;
    },
    format: (text) => seal.format(ctx, text),
    getDiceQQ: () => ctx.endPoint?.userId ?? '',
    random: () => Math.random(),
    snapshot: snapshotFor(ctx, msg, suffix),
  };
}

function configuredFailure(configValue: RuntimeConfig, result: InvocationResult): string {
  switch (result.failure) {
    case 'invalid-return':
      return configValue.invalidReturn;
    case 'output-limit':
      return configValue.outputLimited;
    case 'runtime':
      return configValue.runtimeError;
    default:
      return configValue.runtimeError;
  }
}

function sendOutputs(
  ctx: seal.MsgContext,
  msg: seal.Message,
  outputs: readonly LuaOutput[],
): void {
  for (const output of outputs) {
    try {
      if (output.hidden) seal.replyPerson(ctx, msg, output.text);
      else seal.replyToSender(ctx, msg, output.text);
    } catch (error) {
      reportException(
        reporter,
        { code: 'host-reply-failed', pluginId: undefined, severity: 'error', stage: 'invocation' },
        error,
      );
    }
  }
}

function runHandler(
  plugin: LuaPluginRuntime,
  handler: Parameters<typeof invokeLuaHandler>[1],
  ctx: seal.MsgContext,
  msg: seal.Message,
  suffix = '',
): InvocationResult {
  const result = invokeLuaHandler(
    plugin,
    handler,
    invocationHost(ctx, msg, suffix),
    store,
    config,
    reporter,
  );
  sendOutputs(ctx, msg, result.outputs);
  if (result.failure !== undefined && config.showUserErrors) {
    sendOutputs(ctx, msg, [{ hidden: false, text: configuredFailure(config, result) }]);
  }
  return result;
}

function normalizedEventHook(value: string): string {
  return value.toLowerCase().replace(/[\s_-]/gu, '');
}

function eventHost(
  hook: string,
  ctx?: seal.MsgContext,
  msg?: seal.Message,
  eventFields?: JsonObject,
): InvocationHost {
  if (ctx !== undefined && msg !== undefined) {
    return {
      ...invocationHost(ctx, msg),
      snapshot: { ...snapshotFor(ctx, msg), hook },
    };
  }
  return {
    format: (text) => text,
    getDiceQQ: undefined,
    random: Math.random,
    snapshot: { hook, ...(eventFields ?? {}) },
    todayKey: new Date().toISOString().slice(0, 10),
  };
}

function runEventHandlers(
  hook: string,
  ctx?: seal.MsgContext,
  msg?: seal.Message,
  eventFields?: JsonObject,
): void {
  const normalized = normalizedEventHook(hook);
  for (const runtime of runtimes) {
    for (const event of runtime.events) {
      if (normalizedEventHook(event.hook) !== normalized) continue;
      const result = invokeLuaEventHandler(
        runtime,
        event,
        eventHost(hook, ctx, msg, eventFields),
        store,
        config,
        reporter,
      );
      if (ctx !== undefined && msg !== undefined) sendOutputs(ctx, msg, result.outputs);
    }
  }
}

const messageEventHooks = new Set([
  'messagereceived',
  'groupjoined',
  'groupmemberjoined',
  'guildjoined',
  'becomefriend',
  'poke',
  'groupleave',
]);

function validCommandName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && !/[\u0000-\u001F\u007F]/u.test(name);
}

/** SealDice parses the leading command prefix before looking in cmdMap. */
function hostCommandName(orderName: string): string {
  return orderName.startsWith('.') ? orderName.slice(1) : orderName;
}

let loggedDiagnosticCount = 0;
let runtimes: LuaPluginRuntime[] = [];
const commandNames: string[] = [];
const pluginCommandNames = new Set<string>();
const packages = loadPluginPackages(reporter, {
  maxSourceCharacters: config.maxSourceCharacters,
});
const staticPluginIds = new Set(packages.map((plugin) => plugin.id));

function renderConfigured(template: string, values: Record<string, string>): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );
}

function statusText(plugin: ManagedPluginInfo): string {
  return plugin.enabled ? config.managementStatusEnabled : config.managementStatusDisabled;
}

function removeOwnedCommand(name: string): void {
  if (extension.cmdMap[name] !== undefined) delete extension.cmdMap[name];
  const index = commandNames.indexOf(name);
  if (index >= 0) commandNames.splice(index, 1);
}

function clearPluginCommands(): void {
  for (const name of pluginCommandNames) removeOwnedCommand(name);
  pluginCommandNames.clear();
}

function compilePackages(pluginPackages: readonly LuaPluginPackage[]): LuaPluginRuntime[] {
  const compiled: LuaPluginRuntime[] = [];
  for (const plugin of pluginPackages) {
    const runtime = registerLuaPlugin(plugin, config, reporter);
    if (runtime !== null) compiled.push(runtime);
  }
  return compiled;
}

function validateEventHooks(nextRuntimes: readonly LuaPluginRuntime[]): void {
  for (const runtime of nextRuntimes) {
    for (const event of runtime.events) {
      const hook = normalizedEventHook(event.hook);
      if (hook !== 'startup' && !messageEventHooks.has(hook)) {
        reporter.report({
          code: 'unsupported-event-hook',
          file: runtime.file,
          pluginId: runtime.id,
          detail: event.hook,
          severity: 'warning',
          stage: 'registration',
        });
      }
    }
  }
}

function installPluginCommands(nextRuntimes: readonly LuaPluginRuntime[]): void {
  const owners = new Map<string, string>();
  const managementName = config.managementEnabled ? config.managementCommand : '';
  if (managementName !== '') owners.set(managementName, 'management');
  for (const runtime of nextRuntimes) {
    for (const [orderName, handler] of runtime.orders) {
      const name = hostCommandName(orderName);
      if (!validCommandName(name)) {
        reporter.report({
          code: 'invalid-command-name',
          file: runtime.file,
          pluginId: runtime.id,
          detail: orderName,
          severity: 'warning',
          stage: 'registration',
        });
        continue;
      }
      if (owners.has(name)) {
        reporter.report({
          code: name === managementName ? 'reserved-command-name' : 'duplicate-command-name',
          file: runtime.file,
          pluginId: runtime.id,
          severity: 'warning',
          stage: 'registration',
        });
        continue;
      }
      const command = seal.ext.newCmdItemInfo();
      command.name = name;
      command.help = config.commandHelp;
      command.raw = true;
      command.allowDelegate = false;
      command.disabledInPrivate = false;
      command.enableExecuteTimesParse = false;
      command.checkCurrentBotOn = true;
      command.checkMentionOthers = false;
      command.solve = (ctx, msg) => {
        if (handler.limit !== undefined && !triggerLimitAllows(handler.limit, invocationHost(ctx, msg))) {
          return seal.ext.newCmdExecuteResult(true);
        }
        runHandler(runtime, handler, ctx, msg);
        return seal.ext.newCmdExecuteResult(true);
      };
      extension.cmdMap[name] = command;
      owners.set(name, runtime.id);
      pluginCommandNames.add(name);
      commandNames.push(name);
    }
  }
}

function runtimePackages(): readonly LuaPluginPackage[] {
  const managed = runtimeRegistry.enabledPackages(packages.length).filter((plugin) => {
    if (!staticPluginIds.has(plugin.id)) return true;
    reporter.report({
      code: 'runtime-plugin-id-conflicts-static',
      file: plugin.file,
      pluginId: plugin.id,
      severity: 'warning',
      stage: 'load',
    });
    return false;
  });
  return [...packages, ...managed];
}

function refreshRuntimePlugins(): void {
  const nextRuntimes = compilePackages(runtimePackages());
  clearPluginCommands();
  runtimes = nextRuntimes;
  installPluginCommands(runtimes);
  validateEventHooks(runtimes);
  ownedStates.set(extension, { commandNames, runtimes });
}

function flushDiagnostics(): void {
  const diagnostics = reporter.all();
  for (const diagnostic of diagnostics.slice(loggedDiagnosticCount)) logDiagnostic(diagnostic);
  loggedDiagnosticCount = diagnostics.length;
}

function managementReply(ctx: seal.MsgContext, msg: seal.Message, text: string): void {
  try {
    seal.replyToSender(ctx, msg, text);
  } catch (error) {
    reportException(
      reporter,
      { code: 'management-reply-failed', severity: 'error', stage: 'invocation' },
      error,
    );
  }
}

function validateManagedSource(id: string, source: string): boolean {
  const validationReporter = new DiagnosticCollector();
  const runtime = registerLuaPlugin({
    file: `runtime:${id}`,
    id,
    modules: {},
    sequence: packages.length,
    source,
  }, config, validationReporter);
  for (const diagnostic of validationReporter.all()) logDiagnostic(diagnostic);
  return runtime !== null;
}

function registrySucceeded(result: RuntimePluginRegistryResult): boolean {
  if (result.ok) return true;
  reporter.report({
    code: `runtime-plugin-registry-${result.reason}`,
    severity: 'warning',
    stage: 'storage',
  });
  return false;
}

function managementAllowed(ctx: seal.MsgContext): boolean {
  return (
    ctx.privilegeLevel >= config.managementMinPrivilege &&
    (!config.managementPrivateOnly || ctx.isPrivate)
  );
}

function managementInput(args: seal.CmdArgs): { action: string; id: string; source: string } {
  const raw = args.rawArgs;
  const match = raw.match(/^\s*(\S+)(?:\s+(\S+))?([\s\S]*)$/u);
  if (match !== null) {
    return {
      action: match[1].toLowerCase(),
      id: match[2] ?? '',
      source: match[3].trimStart(),
    };
  }
  return {
    action: args.getArgN(1).toLowerCase(),
    id: args.getArgN(2).trim(),
    source: args.getRestArgsFrom(3).trimStart(),
  };
}

function installManagementCommand(): void {
  if (!config.managementEnabled) return;
  if (!validCommandName(config.managementCommand)) {
    reporter.report({
      code: 'invalid-management-command-name',
      severity: 'error',
      stage: 'registration',
    });
    return;
  }
  const command = seal.ext.newCmdItemInfo();
  command.name = config.managementCommand;
  command.help = config.managementHelp;
  command.raw = true;
  command.allowDelegate = false;
  command.disabledInPrivate = false;
  command.enableExecuteTimesParse = false;
  command.checkCurrentBotOn = true;
  command.checkMentionOthers = false;
  command.solve = (ctx, msg, args) => {
    if (!managementAllowed(ctx)) {
      managementReply(ctx, msg, config.managementDenied);
      return seal.ext.newCmdExecuteResult(true);
    }
    const { action, id, source } = managementInput(args);
    if (action === 'list') {
      const plugins = runtimeRegistry.list();
      if (plugins.length === 0) managementReply(ctx, msg, config.managementEmpty);
      else {
        const items = plugins.map((plugin) => renderConfigured(config.managementListItem, {
          fingerprint: plugin.fingerprint,
          id: plugin.id,
          sourceCharacters: String(plugin.sourceCharacters),
          status: statusText(plugin),
        })).join('\n');
        managementReply(ctx, msg, renderConfigured(config.managementList, { items }));
      }
    } else if (action === 'info' && id !== '') {
      const plugin = runtimeRegistry.get(id);
      if (plugin === undefined) managementReply(ctx, msg, config.managementFailure);
      else managementReply(ctx, msg, renderConfigured(config.managementInfo, {
        fingerprint: plugin.fingerprint,
        id: plugin.id,
        sourceCharacters: String(plugin.sourceCharacters),
        status: statusText(plugin),
      }));
    } else if ((action === 'validate' || action === 'add' || action === 'update') && id !== '' && source !== '') {
      if (!isSafePluginId(id) || staticPluginIds.has(id)) {
        managementReply(ctx, msg, config.managementFailure);
      } else if (!validateManagedSource(id, source)) {
        managementReply(ctx, msg, renderConfigured(config.managementValidationFailed, { id }));
      } else if (action === 'validate') {
        managementReply(ctx, msg, renderConfigured(config.managementValidationSucceeded, { id }));
      } else {
        const result = action === 'add'
          ? runtimeRegistry.add(id, source)
          : runtimeRegistry.update(id, source);
        if (!registrySucceeded(result)) managementReply(ctx, msg, config.managementFailure);
        else {
          refreshRuntimePlugins();
          managementReply(ctx, msg, renderConfigured(config.managementSuccess, { action, id }));
        }
      }
    } else if ((action === 'enable' || action === 'disable' || action === 'remove') && id !== '') {
      const sourceToEnable = action === 'enable' ? runtimeRegistry.sourceForValidation(id) : undefined;
      if (action === 'enable' && (
        !isSafePluginId(id) ||
        staticPluginIds.has(id) ||
        sourceToEnable === undefined ||
        !validateManagedSource(id, sourceToEnable)
      )) {
        managementReply(ctx, msg, renderConfigured(config.managementValidationFailed, { id }));
      } else {
        const result = action === 'remove'
          ? runtimeRegistry.remove(id)
          : runtimeRegistry.setEnabled(id, action === 'enable');
        if (!registrySucceeded(result)) managementReply(ctx, msg, config.managementFailure);
        else {
          refreshRuntimePlugins();
          managementReply(ctx, msg, renderConfigured(config.managementSuccess, { action, id }));
        }
      }
    } else {
      managementReply(ctx, msg, config.managementHelp);
    }
    flushDiagnostics();
    return seal.ext.newCmdExecuteResult(true);
  };
  extension.cmdMap[command.name] = command;
  commandNames.push(command.name);
}

installManagementCommand();
refreshRuntimePlugins();

extension.onNotCommandReceived = (ctx, msg): void => {
  for (const runtime of runtimes) {
    for (const reply of runtime.replies) {
      if (reply.type !== 'Reply' && reply.type !== 'Both') continue;
      const match = replyMatches(reply, msg.message);
      if (!match.matched) continue;
      if (!replyLimitAllows(reply, invocationHost(ctx, msg))) continue;
      runHandler(runtime, reply, ctx, msg, match.suffix ?? '');
      return;
    }
  }
};

extension.onLoad = (): void => {
  runEventHandlers('StartUp');
};

extension.onMessageReceived = (ctx, msg): void => {
  runEventHandlers('MessageReceived', ctx, msg);
};

extension.onGroupJoined = (ctx, msg): void => {
  runEventHandlers('GroupJoined', ctx, msg);
};

extension.onGroupMemberJoined = (ctx, msg): void => {
  runEventHandlers('GroupMemberJoined', ctx, msg);
};

extension.onGuildJoined = (ctx, msg): void => {
  runEventHandlers('GuildJoined', ctx, msg);
};

extension.onBecomeFriend = (ctx, msg): void => {
  runEventHandlers('BecomeFriend', ctx, msg);
};

extension.onPoke = (ctx, event): void => {
  runEventHandlers('Poke', ctx, undefined, {
    groupId: event.groupId,
    isPrivate: event.isPrivate,
    senderId: event.senderId,
    targetId: event.targetId,
  });
};

extension.onGroupLeave = (ctx, event): void => {
  runEventHandlers('GroupLeave', ctx, undefined, {
    groupId: event.groupId,
    operatorId: event.operatorId,
    userId: event.userId,
  });
};

extension.getDescText = (): string => '';
ownedStates.set(extension, { commandNames, runtimes });

flushDiagnostics();
