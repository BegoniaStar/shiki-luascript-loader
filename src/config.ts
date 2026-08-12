/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const extensionName = 'shiki-luascript-loader';

const configGroup = 'Dice Lua Compatibility';

const keys = {
  managementCommand: 'management.command',
  managementDenied: 'management.message.denied',
  managementEmpty: 'management.message.empty',
  managementFailure: 'management.message.failure',
  managementHelp: 'management.message.help',
  managementInfo: 'management.message.info',
  managementList: 'management.message.list',
  managementListItem: 'management.message.list-item',
  managementSuccess: 'management.message.success',
  managementStatusDisabled: 'management.message.status-disabled',
  managementStatusEnabled: 'management.message.status-enabled',
  managementValidationFailed: 'management.message.validation-failed',
  managementValidationSucceeded: 'management.message.validation-succeeded',
  managementEnabled: 'management.enabled',
  managementMaxBytes: 'management.limits.max-bytes',
  managementMaxPlugins: 'management.limits.max-plugins',
  managementMinPrivilege: 'management.min-privilege',
  managementPrivateOnly: 'management.private-only',
  commandHelp: 'message.command-help',
  invalidReturn: 'message.invalid-return',
  outputLimited: 'message.output-limited',
  runtimeError: 'message.runtime-error',
  showUserErrors: 'message.show-runtime-errors',
  maxOutputCount: 'limits.max-output-count',
  maxOutputCharacters: 'limits.max-output-characters',
  maxSourceCharacters: 'limits.max-source-characters',
  maxStorageBytes: 'limits.max-storage-bytes',
  maxStorageDepth: 'limits.max-storage-depth',
  maxStorageKeys: 'limits.max-storage-keys',
  maxVmInstructions: 'limits.max-vm-instructions',
} as const;

export interface RuntimeConfig {
  commandHelp: string;
  managementCommand: string;
  managementDenied: string;
  managementEmpty: string;
  managementEnabled: boolean;
  managementFailure: string;
  managementHelp: string;
  managementInfo: string;
  managementList: string;
  managementListItem: string;
  managementMaxBytes: number;
  managementMaxPlugins: number;
  managementMinPrivilege: number;
  managementPrivateOnly: boolean;
  managementSuccess: string;
  managementStatusDisabled: string;
  managementStatusEnabled: string;
  managementValidationFailed: string;
  managementValidationSucceeded: string;
  invalidReturn: string;
  maxOutputCount: number;
  maxOutputCharacters: number;
  maxSourceCharacters: number;
  maxStorageBytes: number;
  maxStorageDepth: number;
  maxStorageKeys: number;
  maxVmInstructions: number;
  outputLimited: string;
  runtimeError: string;
  showUserErrors: boolean;
}

function positive(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Registers every text sent to users as a SealDice configuration value. */
export function registerConfig(extension: seal.ExtInfo): void {
  seal.ext.registerStringConfig(
    extension,
    keys.managementCommand,
    'luaplug',
    undefined,
    configGroup,
  );
  seal.ext.registerBoolConfig(
    extension,
    keys.managementEnabled,
    true,
    undefined,
    configGroup,
  );
  seal.ext.registerIntConfig(
    extension,
    keys.managementMinPrivilege,
    100,
    undefined,
    configGroup,
  );
  seal.ext.registerBoolConfig(
    extension,
    keys.managementPrivateOnly,
    true,
    undefined,
    configGroup,
  );
  seal.ext.registerIntConfig(
    extension,
    keys.managementMaxPlugins,
    16,
    undefined,
    configGroup,
  );
  seal.ext.registerIntConfig(
    extension,
    keys.managementMaxBytes,
    256_000,
    undefined,
    configGroup,
  );
  seal.ext.registerStringConfig(
    extension,
    keys.managementHelp,
    'Lua 插件管理：\n.luaplug list\n.luaplug info <id>\n.luaplug validate <id> <Lua 源码>\n.luaplug add <id> <Lua 源码>\n.luaplug update <id> <Lua 源码>\n.luaplug enable|disable|remove <id>',
    undefined,
    configGroup,
  );
  seal.ext.registerStringConfig(
    extension,
    keys.managementDenied,
    '权限不足。',
    undefined,
    configGroup,
  );
  seal.ext.registerStringConfig(
    extension,
    keys.managementEmpty,
    '没有运行时 Lua 插件。',
    undefined,
    configGroup,
  );
  seal.ext.registerStringConfig(
    extension,
    keys.managementList,
    '运行时 Lua 插件：\n{items}',
    undefined,
    configGroup,
  );
  seal.ext.registerStringConfig(
    extension,
    keys.managementListItem,
    '- {id} [{status}] {sourceCharacters} 字符，{fingerprint}',
    undefined,
    configGroup,
  );
  seal.ext.registerStringConfig(
    extension,
    keys.managementInfo,
    'ID：{id}\n状态：{status}\n源码字符数：{sourceCharacters}\n指纹：{fingerprint}',
    undefined,
    configGroup,
  );
  seal.ext.registerStringConfig(
    extension,
    keys.managementSuccess,
    '操作完成：{action} {id}。',
    undefined,
    configGroup,
  );
  seal.ext.registerStringConfig(
    extension,
    keys.managementStatusEnabled,
    '启用',
    undefined,
    configGroup,
  );
  seal.ext.registerStringConfig(
    extension,
    keys.managementStatusDisabled,
    '停用',
    undefined,
    configGroup,
  );
  seal.ext.registerStringConfig(
    extension,
    keys.managementFailure,
    '操作失败。',
    undefined,
    configGroup,
  );
  seal.ext.registerStringConfig(
    extension,
    keys.managementValidationSucceeded,
    'Lua 校验通过：{id}。',
    undefined,
    configGroup,
  );
  seal.ext.registerStringConfig(
    extension,
    keys.managementValidationFailed,
    'Lua 校验失败：{id}。',
    undefined,
    configGroup,
  );
  seal.ext.registerStringConfig(
    extension,
    keys.commandHelp,
    '由 Dice! Lua 插件注册的命令。',
    undefined,
    configGroup,
  );
  seal.ext.registerStringConfig(
    extension,
    keys.runtimeError,
    'Lua 插件执行失败。',
    undefined,
    configGroup,
  );
  seal.ext.registerStringConfig(
    extension,
    keys.invalidReturn,
    'Lua 插件返回了不支持的值。',
    undefined,
    configGroup,
  );
  seal.ext.registerStringConfig(
    extension,
    keys.outputLimited,
    'Lua 插件输出超过安全限制。',
    undefined,
    configGroup,
  );
  seal.ext.registerBoolConfig(
    extension,
    keys.showUserErrors,
    false,
    undefined,
    configGroup,
  );
  seal.ext.registerIntConfig(
    extension,
    keys.maxVmInstructions,
    100_000,
    undefined,
    configGroup,
  );
  seal.ext.registerIntConfig(
    extension,
    keys.maxOutputCount,
    4,
    undefined,
    configGroup,
  );
  seal.ext.registerIntConfig(
    extension,
    keys.maxOutputCharacters,
    4_000,
    undefined,
    configGroup,
  );
  seal.ext.registerIntConfig(
    extension,
    keys.maxSourceCharacters,
    200_000,
    undefined,
    configGroup,
  );
  seal.ext.registerIntConfig(
    extension,
    keys.maxStorageBytes,
    512_000,
    undefined,
    configGroup,
  );
  seal.ext.registerIntConfig(
    extension,
    keys.maxStorageDepth,
    16,
    undefined,
    configGroup,
  );
  seal.ext.registerIntConfig(
    extension,
    keys.maxStorageKeys,
    2_000,
    undefined,
    configGroup,
  );
}

export function readConfig(extension: seal.ExtInfo): RuntimeConfig {
  return {
    commandHelp: seal.ext.getStringConfig(extension, keys.commandHelp),
    managementCommand: seal.ext.getStringConfig(extension, keys.managementCommand),
    managementDenied: seal.ext.getStringConfig(extension, keys.managementDenied),
    managementEmpty: seal.ext.getStringConfig(extension, keys.managementEmpty),
    managementEnabled: seal.ext.getBoolConfig(extension, keys.managementEnabled),
    managementFailure: seal.ext.getStringConfig(extension, keys.managementFailure),
    managementHelp: seal.ext.getStringConfig(extension, keys.managementHelp),
    managementInfo: seal.ext.getStringConfig(extension, keys.managementInfo),
    managementList: seal.ext.getStringConfig(extension, keys.managementList),
    managementListItem: seal.ext.getStringConfig(extension, keys.managementListItem),
    managementMaxBytes: positive(
      seal.ext.getIntConfig(extension, keys.managementMaxBytes),
      256_000,
    ),
    managementMaxPlugins: positive(
      seal.ext.getIntConfig(extension, keys.managementMaxPlugins),
      16,
    ),
    managementMinPrivilege: positive(
      seal.ext.getIntConfig(extension, keys.managementMinPrivilege),
      100,
    ),
    managementPrivateOnly: seal.ext.getBoolConfig(extension, keys.managementPrivateOnly),
    managementSuccess: seal.ext.getStringConfig(extension, keys.managementSuccess),
    managementStatusDisabled: seal.ext.getStringConfig(extension, keys.managementStatusDisabled),
    managementStatusEnabled: seal.ext.getStringConfig(extension, keys.managementStatusEnabled),
    managementValidationFailed: seal.ext.getStringConfig(extension, keys.managementValidationFailed),
    managementValidationSucceeded: seal.ext.getStringConfig(extension, keys.managementValidationSucceeded),
    invalidReturn: seal.ext.getStringConfig(extension, keys.invalidReturn),
    maxOutputCount: positive(
      seal.ext.getIntConfig(extension, keys.maxOutputCount),
      4,
    ),
    maxOutputCharacters: positive(
      seal.ext.getIntConfig(extension, keys.maxOutputCharacters),
      4_000,
    ),
    maxSourceCharacters: positive(
      seal.ext.getIntConfig(extension, keys.maxSourceCharacters),
      200_000,
    ),
    maxStorageBytes: positive(
      seal.ext.getIntConfig(extension, keys.maxStorageBytes),
      512_000,
    ),
    maxStorageDepth: positive(
      seal.ext.getIntConfig(extension, keys.maxStorageDepth),
      16,
    ),
    maxStorageKeys: positive(
      seal.ext.getIntConfig(extension, keys.maxStorageKeys),
      2_000,
    ),
    maxVmInstructions: positive(
      seal.ext.getIntConfig(extension, keys.maxVmInstructions),
      100_000,
    ),
    outputLimited: seal.ext.getStringConfig(extension, keys.outputLimited),
    runtimeError: seal.ext.getStringConfig(extension, keys.runtimeError),
    showUserErrors: seal.ext.getBoolConfig(extension, keys.showUserErrors),
  };
}
