# Dice Lua 兼容契约

状态：Draft v0.2

本文定义兼容层在 SealDice 1.6.0 中加载 Dice! Lua 插件时的稳定边界。实现、测试和发布门禁都必须以本文为准；未列出的 Dice! 行为不自动视为兼容。

## 1. 范围

### 1.1 目标

兼容层需要能够：

1. 在 SealDice 的 JS 扩展生命周期中加载 Lua 插件源代码。
2. 识别 Dice! 插件常见的 `msg_order`、`msg_reply`、`event` 和 `task_call` 注册表。
3. 为插件提供 Dice! Lua API 的受控实现，并把输出、牌堆、变量和持久化数据接到 SealDice。
4. 在单个插件失败时隔离错误，不阻止其他插件和宿主继续工作。
5. 在重载时清理命令、回复匹配器、事件和任务；持久化数据按插件 ID 保留。

### 1.2 明确不做

兼容层不负责：

- 移植 Dice! 原生命令、`.help`、管理员命令或 Dice! 全局文案。
- 复刻 Dice! 原生 C++ 核心、QQ 适配器、后台线程或文件目录管理。
- 运行 SealDice 1.6.0 JS API 未暴露的任意宿主文件扫描。
- 保证所有 Dice! 插件都能无修改运行；插件使用未声明 API 时必须给出诊断。

## 2. 目标运行时

| 项目 | 契约值 |
| --- | --- |
| 宿主 | SealDice 1.6.0 |
| JS 引擎 | Goja；bundle 输出目标为 ES6 |
| 构建 | sealwrapper，目标矩阵当前为 `1.6.0` |
| Lua 语义 | Lua 5.3，基于 Fengari 的纯 VM 子集 |
| 工具链 | mise 管理 Node 26.5.0、npm 12.0.1、Go 1.25.0 |
| 编码 | Lua 源码和宿主桥接统一使用 UTF-8 |

Fengari 的 Node `io`、`os`、动态 `loadlib` 和依赖宿主文件系统的功能不属于默认运行时。实现不得把 Node 内置模块或 `require()` 留到最终 Goja bundle 中。

## 3. 兼容等级

每个 API 和插件能力必须标记一个等级：

- **Required**：第一版必须实现，并有 Sealwrapper 场景或单元测试覆盖。
- **Emulated**：提供同名或等价能力，但底层数据来自 SealDice 存储/上下文，可能与 Dice! 原生数据不相同。
- **Best-effort**：在宿主能力允许时实现；失败时返回约定的空值/错误并记录诊断。
- **Unsupported**：第一版不提供。调用不能越过沙箱；应返回 Lua 可捕获的错误或安全的失败值。
- **Forbidden**：无论配置如何都不允许，例如任意文件读写、进程执行、动态 JS/C 模块加载。

兼容等级是 API 契约的一部分。升级时只能把 `Unsupported` 提升为 `Best-effort`、`Emulated` 或 `Required`，不能悄悄改变已有等级的语义。

## 4. 插件包与加载

### 4.1 包来源

第一版只接受构建产物中可确定的插件集合。推荐的作者目录为：

```text
assets/dice-lua/index.json
assets/dice-lua/plugins/<plugin>.lua.json
```

`index.json` 使用固定格式：

```json
{
  "format": "sealdice-dice-lua-index-v1",
  "plugins": ["plugins/example.lua.json"]
}
```

每个插件包使用：

```json
{
  "format": "sealdice-dice-lua-plugin-v1",
  "id": "example",
  "source": "msg_order = { ping = function(msg) return 'pong' end }",
  "modules": {
    "util": "return { version = 1 }"
  }
}
```

`plugins` 中的文件名必须是项目内、无 `..`、无斜杠逃逸、无重复项的普通 JSON 文件。插件 ID 必须非空、稳定且唯一。`modules` 的键是安全的逻辑模块名，值是 Lua 源码；模块不能通过相对路径或绝对路径互相引用。运行时通过受限的资源模块加载器读取 `index.json` 和索引列出的 envelope。sealpack bundle 位于 `scripts/` 时，逻辑资源路径必须映射到固定的 `../assets/dice-lua/`；实现不得扫描宿主目录、拼接任意路径或读取未声明文件。若构建目标不支持外部资源，构建器必须在打包阶段生成等价的静态资源表，但不能改变上述校验规则。

### 4.1.1 运行时小型插件

管理命令可额外保存单条消息提交的小型单文件 Lua 源码。该模式不改变上述固定资源
边界：运行时源码只写入独立、版本化的扩展 storage 根键
`sealdice-dice-lua-runtime-plugins-v1`，不会修改 index、envelope 或宿主文件系统。

- 管理命令、权限门槛和是否只允许私聊均为配置项；默认命令为 `.luaplug`，默认仅
  `privilegeLevel >= 100` 的私聊可使用。
- `add`、`update`、`validate` 的 `<id>` 后全部文本是一份 Lua 源码。运行时插件没有
  模块表，不能通过该管理面上传或加载自定义 `loadLua` 模块。
- 每次新增、更新和启用必须先在隔离 VM 中完成注册校验；只有成功后才能持久化。持久化
  成功后重建本扩展拥有的命令、回复和事件注册表；失败必须保留之前的可运行版本。
- 运行时 ID 必须符合与静态 envelope 相同的安全 ID 规则，且不得与静态资源 ID 冲突。
  `list`/`info` 不得回显源码，只可展示 ID、启用状态、字符数和非加密展示指纹。
- 消息管理面不提供路径、文件、压缩包、分片上传、动态 JS/C 模块或宿主 `/plugin` 扫描。
  需要较大源码或虚拟模块的插件必须使用静态 sealpack envelope。

### 4.2 加载生命周期

1. 扩展注册时读取并校验静态 index，并读取已校验的运行时 storage registry；单个包错误只隔离该包。
2. 为每个插件创建注册 VM，注入空的 `msg_order`、`msg_reply`、`event`、`task_call` 表。
3. 执行插件顶层源码，读取上述注册表并建立不可变的运行时注册信息；函数值按 Fengari `lua_dump` 语义保存为可验证的 bytecode descriptor。
4. 命令匹配、非命令回复、事件和任务触发时创建调用 VM，用 `lua_load` 恢复 handler，注入当前 `msg` 或 `event`。
5. 调用完成后回收调用 VM；插件持久化状态只能通过约定的存储 API 保留。
6. 扩展重载时取消已注册任务、清空内存注册表和调用状态，再按相同顺序重新加载。静态包
   先于运行时包；运行时包 ID 不能覆盖静态包 ID。

普通 bytecode handler 的插件顶层代码只保证在加载时执行一次；但字符串值
`msg_order` 为了兼容 Dice! 的“源码文件 + 顶层函数名”语义，会在每次调用时
重新执行源码。此类插件不得依赖跨消息保留的 Lua 全局变量，也应避免不可重复
的顶层副作用；需要跨消息状态时必须使用 `SelfData`、用户/群组/今日存储或等价 API。

函数 bytecode 的闭包 upvalue 是否可在新 VM 中恢复必须通过 fixture 验证；无法恢复的局部 helper、模块返回闭包或运行时 upvalue 不得静默视为兼容。

### 4.3 注册表语义

- `msg_order`：按 Dice! 的命令/前缀注册语义注册到 SealDice 扩展命令表。Dice! 条目名的前导 `.` 是输入前缀，不写入 SealDice `cmdMap`；例如 `msg_order[".a"]` 对应 SealDice key `a`，而输入仍是 `.a`。函数值作为 Lua handler；字符串值按顶层函数名解析，调用时重新执行同一插件源码后取得该函数，以保留文件内 helper 和常量；描述表只支持矩阵中列出的字段。
- `msg_reply`：通过非命令消息钩子匹配 `match`、`prefix`、`search`、`regex` 四类关键词。回复顺序按 index 文件顺序、插件顺序和表遍历稳定顺序确定。
- `msg_order`/`msg_reply.limit`：在 handler 执行前按 `msg.uid`/`msg.gid` 执行 `user_id`、`grp_id` 和 `prob` 条件；正向列表表示仅允许列表内身份，`!` 或 `nor` 表示排除列表，`prob` 使用 1–99 的整数百分比。`lock`、`cd`、`today`、变量比较和 `dicemaid` 条件不执行，并在注册阶段记录诊断。
- `event`：接受直接 `hook` 字段或 Dice! 原生 `trigger.hook` 字段，只映射到契约列出的 SealDice 生命周期事件；当前为 `StartUp`、`MessageReceived`、`GroupJoined`、`GroupMemberJoined`、`GuildJoined`、`BecomeFriend`、`Poke` 和 `GroupLeave`。未知 Dice! hook 名称不得猜测映射。
- `task_call`：映射到 SealDice `registerTask` 或等价调度器；任务回调没有消息上下文时，`msg` 不可用。

兼容层内部同名命令、回复键或事件 ID 按声明顺序处理，并生成可配置的冲突诊断；与 SealDice 内置命令或其他扩展冲突时不得声称可以控制宿主最终优先级，实现必须记录插件 ID 和来源。

## 5. 调用与返回值

### 5.1 `msg` 调用

Lua handler 接收一个受控的 Dice Context userdata。它是当前消息的快照和调用 scratch，不是可直接修改的 SealDice `MsgContext`；持久化必须走显式 storage API。其字段和方法由支持矩阵定义。handler 返回值遵循 Dice! 常见语义：

- 第一个返回值为非空字符串：发送公开回复。
- 第二个返回值为非空字符串：发送隐藏/私聊回复的兼容形式。
- `nil`：不自动发送；插件仍可通过 `msg:echo` 或 `sendMsg` 主动发送。
- 其他返回类型：视为插件错误，记录诊断并使用兼容层错误文案。

`msg:echo(text[, noFormat])` 发送公开回复；第三参数为真时跳过 SealDice 模板格式化。隐藏输出只由 handler 的第二返回值产生，在 SealDice 中优先映射为当前发送者私聊；无法取得可用 endpoint 时不得退化为公开群消息。

当 `msg_reply` 未声明 `keyword` 时，关键词回退为注册表中的条目名。四种关键词比较均按 Dice! 的 ASCII 大小写不敏感语义处理；正则使用 Unicode、大小写不敏感的整串匹配，而不是任意子串搜索。

### 5.2 错误

Lua 语法错误、运行时异常、返回类型错误、超预算和不支持 API 都必须：

1. 隔离当前调用或插件。
2. 记录结构化诊断：插件 ID、阶段、API 名、错误类型和截断后的详细信息。
3. 默认只记录诊断；若配置启用用户可见提示，则使用 `message.*` 配置中的文案。源码中不得硬编码面向用户的中文错误文案。

详细 Lua 异常最多保留配置的字符数，避免把堆栈或敏感数据完整发送到群聊。

## 6. 存储契约

所有持久化数据通过扩展 `storageGet/storageSet` 保存，使用一个版本化根键：

```text
sealdice-dice-lua-state-v1
```

建议结构：

```json
{
  "version": 1,
  "plugins": {
    "example": {
      "selfdata": {},
      "group": {},
      "user": {},
      "today": {}
    }
  }
}
```

要求：

- 插件 ID、数据域和文件名必须命名空间隔离。
- `SelfData` 文件名只能是安全的逻辑名，不得解释为宿主路径。
- 读到非法 JSON 时忽略损坏状态并记录 warning；不得让整个扩展加载失败。
- 写入采用内存状态快照加一次 JSON 提交，避免半写状态。
- 必须有最大字节数、最大键数和最大嵌套深度限制；超限写入失败且不破坏旧值。
- 迁移只允许显式的 `vN -> vN+1` 函数，不自动猜测旧 Dice! 文件路径。

`getGroupConf/setGroupConf`、`getUserConf/setUserConf` 和
`getUserToday/setUserToday` 使用同一存储根键下的插件命名空间。它们是
Emulated 能力：群组/用户 ID 和配置键只作为逻辑键保存，不访问 SealDice 原生
配置对象；今日域使用 UTC 日期前缀分区。缺失值遵循 Lua 第三个参数的默认值，删除通过
传入 `nil` 完成。

`getDiceQQ` 只返回当前 SealDice 消息 endpoint 的 `userId`，不暴露宿主路径、环境变量或
其他 endpoint 管理信息。

角色卡 API 使用 `user` 存储域中的独立 `actor:<uid>:<gid>` 逻辑键保存字段和锁状态。
`getPlayerCard` 返回的 Actor userdata 只属于当前插件；不同插件之间不会共享角色卡数据。

## 7. 安全与资源限制

默认禁止：

- `io`、`os` 的文件/进程操作。
- Node `fs`、`path`、`child_process`、`tmp`、动态 C/JS 模块。
- 任意宿主目录、环境变量和进程信息读取。
- 未声明网络主机的 HTTP 请求。

每次 Lua 调用必须受以下限制保护：

- 最大 VM 指令数或等价执行预算。
- 最大递归深度和 coroutine 数量。
- 最大公开/隐藏消息数和总输出字符数。
- 最大单次 HTTP 请求数、响应体大小和超时。
- 最大存储 JSON 大小。

`sleepTime` 不提供阻塞等价实现；第一版应标记为 `Unsupported`。`sendMsg` 只接受当前消息的群/用户目标并复用当前输出队列，跨目标投递必须失败；`eventMsg` 必须有重入深度和每条入站消息的派生事件上限，因此当前仍为 `Unsupported`。

## 8. 文案与配置

兼容层自身所有用户可见文本使用 SealDice 配置项，至少包括：加载状态、加载失败、运行时失败、不支持 API、冲突、超限、管理/诊断帮助和网络失败。

Lua 插件在源码中返回的业务文案仍归插件自身；如需管理员覆盖，后续增加按插件 ID 和文案键索引的可选覆盖表，不把任意 Lua 字符串自动注册成数百个宿主配置项。

## 9. 版本与测试门禁

契约版本、Lua bridge 版本和状态格式版本必须独立记录。任何支持矩阵变更都必须增加：

- Lua VM 单元测试。
- API bridge 单元测试。
- 至少一个加载、命令、回复、存储和错误隔离的 sealwrapper scenario。
- `sealw typecheck`、`sealw goja scan`、`sealw resource check`、`sealw test` 和 `sealw scenario test`。

发布包只能包含项目内确定的 bundle、声明的资源和 README；不能依赖运行时当前工作目录或宿主的 Dice! 安装目录。
