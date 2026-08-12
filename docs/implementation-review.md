# 实现方案审查与修订

状态：Phase 2 implementation review v0.4

Phase 0/1 已落地：资源 loader、版本化 storage、纯 Lua VM、userdata bridge、
bytecode handler、`msg_order`/`msg_reply` 分发和 SealDice smoke gate。对 Dice!
常见的字符串函数名 `msg_order`，调用 VM 会按源文件重新加载顶层函数，以保留
同文件 helper 和常量。已按复用
宿主设施的原则补充 `seal.deck` 抽牌、生命周期事件、插件隔离的群/用户/今日
存储、Actor 角色卡、当前目标 `sendMsg` 以及 `msg_reply.limit` 的安全子集。
任务调度、同步 HTTP、虚拟事件和 Dice! 原生变量比较仍保持 Unsupported。

本文审查兼容契约对应的实现方案，目标是尽量复用 SealDice 1.6.0 JS 扩展设施，而不是在兼容层中重新实现宿主能力。

运行时小型插件管理复用 `extension.cmdMap`、`CmdArgs`、`storageGet/storageSet` 和现有 Lua
注册流程。其管理命令默认只向骰主私聊开放；每次变更遵循“隔离校验 → 单次 storage 提交 →
重建本扩展注册表”的顺序。它不扫描文件，也不改变 sealpack 静态资源；管理回复不回显 Lua
源码。大脚本和带 `loadLua` 模块的插件仍使用静态 envelope。

## 1. 审查结论

总体方向可行，但原方案不能直接进入“全量实现”。需要先修正以下高风险问题：

| 风险 | 严重度 | 原方案问题 | 修订 |
| --- | --- | --- | --- |
| Lua 函数跨 VM | 高 | 注册 VM 中的函数不能直接交给新调用 VM | 按 Dice! 的 `lua_dump`/`lua_load` 语义传递 handler bytecode；为闭包/upvalue 增加明确验收样例 |
| 同步 HTTP | 高 | Dice! `http.get/post` 是同步返回，SealDice JS 的 `fetch` 返回 Promise，不能阻塞 Goja 等待 | 第一版将 `http.get/post` 保持 Unsupported；先支持纯函数 URL 编解码，后续单独设计异步 Lua API |
| 资源路径 | 高 | bundle 位于 sealpack `scripts/`，不能假设 `./assets` 相对路径 | 采用回雪加载器模式：逻辑路径固定，实际通过 `../assets/dice-lua/` 加载；不接受插件提供的路径 |
| 重载清理 | 中 | `cmdMap`、hook 和 task 可能来自上一次扩展实例 | 记录本扩展拥有的命令；重载时清除/替换 hook，并对同一 VM 内替换调用 `JsScriptTask.off()`；真实重载必须由 sealwrapper smoke test 验证 |
| 命令冲突 | 中 | “后加载覆盖”无法决定 Dice! 内置命令或其他扩展的全局优先级 | 只承诺兼容层内部的确定顺序；宿主冲突只诊断，不声称覆盖成功 |
| Context 可变性 | 高 | 直接暴露宿主 `MsgContext` 会让 Lua 修改宿主状态 | Lua 只获得调用快照和受控 scratch 字段；持久化必须走显式存储 API |
| 第一版范围过大 | 高 | VM、所有 bridge、网络、事件、任务和限制同时 Required，难以定位失败 | 分阶段提升支持等级，每阶段只增加可验收能力 |
| 错误刷屏/泄漏 | 中 | 运行时异常直接回复用户可能泄漏堆栈或造成刷屏 | 默认只写结构化日志；用户可见错误回复由配置开关控制，内容只能来自配置模板 |

## 2. SealDice 设施复用表

| 需求 | 直接复用的 SealDice 设施 | 兼容层只负责的部分 |
| --- | --- | --- |
| 扩展生命周期 | `seal.ext.find/new/register`、`autoActive`、`getDescText`、`onLoad` | 创建 Lua registry、加载资源、安装/替换自有 hook |
| `msg_order` | `seal.ext.newCmdItemInfo`、`extension.cmdMap`、`cmdArgs`、`newCmdExecuteResult` | 将 Lua handler 包装为 `solve`，把 `CmdArgs` 规范化为 Lua Context |
| `msg_reply` | `extension.onNotCommandReceived` | 顺序匹配、限流、Lua 调用和输出队列；不另造宿主消息分发器 |
| Dice! 事件 | `onMessageReceived`、`onMessageSend`、`onMessageDeleted`、`onMessageEdit`、`onGroupJoined`、`onGroupMemberJoined`、`onGuildJoined`、`onBecomeFriend`、`onPoke`、`onGroupLeave` | 只映射有对应 hook 的 Dice! 事件，未知事件拒绝加载 |
| `task_call` | `seal.ext.registerTask` 返回的 `JsScriptTask`，使用 `on/off` | 解析 Dice! 任务描述、记录 task owner、隔离无消息上下文的回调 |
| 回复 | `seal.replyToSender`、`seal.replyPerson`、`seal.replyGroup` | 将 Lua 返回值和 `msg:echo` 转成宿主调用；不伪造 QQ 适配器 |
| 牌堆 | `seal.deck.draw`、`seal.deck.reload` | 只转换 `DeckResult`，不实现第二套牌堆引擎 |
| 格式化 | `seal.format`、`seal.formatTmpl` | 对显式 Lua table 做最小安全字段替换；不复制 Dice! 全局命令/文案 |
| 变量 | `seal.vars.intGet/intSet`、`strGet/strSet`、`computedGet/computedSet` | 只在变量域语义一致时复用；`SelfData` 和插件私有域仍使用扩展 storage |
| 存储 | `extension.storageGet/storageSet` | 版本化 envelope、插件命名空间、大小/深度校验和损坏隔离 |
| 虚拟消息 | `seal.newMessage`、`seal.createTempCtx`、`seal.getEndPoints` | 构造受限 eventMsg；控制重入深度和派生消息数量 |
| 网络权限 | `extension.getPackageConfig()`、sealpack `permissions.network/networkHosts` | 在 Lua bridge 中执行 host 白名单；不能把 manifest 权限扩大为任意网络 |
| 资源加载 | `require('../assets/dice-lua/...')` 的固定适配器 | 校验 index/envelope、拒绝目录扫描和路径穿越 |
| 测试 | sealwrapper 的 `resource check`、`test`、`scenario test`、Goja scan | 增加 Lua fixture、桥接场景和重载断言 |

以下能力不应在兼容层重写：SealDice 命令解析、群/私聊回复、牌堆抽取、扩展存储、模板格式化和任务注册。

## 3. 修订后的调用架构

### 3.1 资源与注册阶段

1. 通过固定的 `../assets/dice-lua/index.json` 资源适配器读取索引；索引列出的文件名只允许普通 JSON 文件名。
2. 逐个校验 envelope、插件 ID、模块名、源码大小和重复 ID。单个插件失败不阻断其他插件。
3. 为插件创建注册 VM，先注入纯 Lua 库和受控 bridge，再执行顶层源码。
4. 将 `msg_order`、`msg_reply`、`event`、`task_call` 转成纯 TypeScript descriptor，不保留可跨 VM 直接调用的 Lua 对象。
5. 对函数值使用 Fengari 的 `lua_dump` 保存 bytecode；调用时在新 VM 中用 `lua_load` 恢复。这与 Dice! 当前 C++ 实现的函数调用路径一致。
6. 注册 VM 在提取 descriptor 后销毁。插件全局变量不作为跨消息状态；需要持久化必须使用约定 API。

`lua_dump` 不保证把任意闭包 upvalue 的运行时值带到新 VM。使用局部 helper、模块返回闭包或依赖顶层可变全局的插件必须有专门 fixture；失败时给出诊断，不能静默假装兼容。

### 3.2 消息调用阶段

1. SealDice 命令或消息 hook 只负责生成一次调用记录，并选择已验证的 descriptor。
2. 为该调用创建独立 Lua VM，重新注入 bridge 和 envelope 中声明的虚拟模块。
3. 使用 `lua_load` 恢复 handler bytecode，注入不可变的 Lua Context 快照和调用预算。
4. 在受保护调用中执行 handler，收集 `(public, hidden)` 返回值和受限发送队列。
5. 将输出交给 `seal.replyToSender/replyPerson/replyGroup`；调用结束后关闭 VM，不允许 Lua 回调持有宿主对象。

### 3.3 Hook 与冲突边界

- 兼容层只拥有一个 `onNotCommandReceived` 分发器；插件顺序由 index 顺序固定。
- `extension.cmdMap` 中的命令 key 必须先经过宿主命令名校验；非法 key 进入诊断，不写入 `cmdMap`。
- 兼容层内部重复 key 按声明顺序处理并报警；与 SealDice 内置命令或其他扩展冲突时只记录诊断，最终优先级以宿主为准。
- task 句柄保存于当前 JS VM；同一 VM 内重载/替换先调用 `off()`。`.master reload js` 的跨 VM 清理必须由真实宿主测试确认，不能仅凭 TypeScript 假设。

## 4. 分阶段实现门禁

### Phase 0：宿主骨架与资源

只实现 TypeScript 扩展注册、回雪式资源 loader、诊断、配置和 storage service。用静态 Lua fixture 验证 index/envelope、重复 ID、坏 JSON、重载和 assets 路径。

### Phase 1：纯 Lua 最小闭环

实现 Fengari 核心子集、`msg_order`、`msg_reply`、Context 快照、返回值、`msg:echo`、`log`、`ranint`、`Set`、`SelfData`、`http.urlEncode/urlDecode`。不实现同步 HTTP、GameTable、Actor card、`sleepTime`。

### Phase 2：复用宿主设施（已部分落地）

已接入 `seal.deck`、`seal.format`、当前目标 `sendMsg` 和 SealDice 生命周期事件；
`seal.vars` 只在语义一致时复用，群/用户/今日配置仍使用插件隔离 storage。
`task_call` 没有等价的 Dice! 调度语义，继续保持 Unsupported；没有对应宿主
hook 的事件同样不猜测映射。

### Phase 3：扩展兼容面（已部分落地）

Actor 兼容数据、属性和锁已映射到插件隔离 storage；触发限制目前只执行
`user_id`、`grp_id`、`prob`。在确认异步模型后再评估 HTTP，`cd`/`today` 和
受限 `eventMsg` 仍不实现。任何新增能力先进入 Best-effort，不直接升为 Required。

### 每阶段共同门禁

- Lua VM 原始 Fengari 测试与 Goja bundle 测试分开运行。
- 每次调用启用 instruction count hook、最大递归/协程数、输出和存储上限。
- 诊断默认只写日志；用户回复必须由配置启用并使用 `message.*` 模板。
- `sealw typecheck`、`sealw goja scan`、`sealw resource check`、`sealw test`、`sealw scenario test` 全部通过。

## 5. 本次审查后的决策

1. 保留兼容契约的总体边界，但将“注册 VM 到调用 VM”的 bytecode 传递写入正式契约。
2. 第一版不承诺同步 `http.get/post`；只保留纯 URL API。
3. 将 SealDice API 作为唯一宿主能力来源，禁止新增自定义命令解析、牌堆、消息队列和模板引擎。
4. 以当前支持矩阵为准继续收集真实 Lua 插件样本；新增能力必须先补充契约、fixture 和安全边界。
