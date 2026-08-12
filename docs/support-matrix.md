# Dice Lua 支持矩阵

状态：Phase 2 Draft v0.3

等级含义见[兼容契约](compatibility-contract.md)：Required、Emulated、Best-effort、Unsupported、Forbidden。

## 1. 插件注册与触发

| 能力 | 第一版 | 说明 |
| --- | --- | --- |
| 声明式 Lua 源码包 | Required | 从受校验的静态 index/envelope 资源加载；不扫描宿主目录 |
| 运行时 Lua 插件 CRUD | Emulated | `.luaplug` 仅接受达到配置权限门槛的用户，默认仅骰主私聊；单条消息提交小型单文件源码，先隔离校验再写入独立扩展 storage 并重建注册表 |
| `msg_order` 函数值 | Required | 注册为 SealDice 命令；以 Lua handler 接收 Context |
| `msg_order` 字符串函数名 | Emulated | 按 Dice! 语义从插件源码重新加载顶层函数；支持依赖同一文件中其他顶层函数/数据 |
| `msg_order` 描述表 | Emulated | 支持 `echo`/`lua`/`func` 中的 Lua 函数，以及纯文本 `echo`；支持 `limit` 的 `user_id`、`grp_id`、`prob` 子集；deck、JS/Python echo 不支持 |
| `msg_reply` | Required | 支持完全匹配、前缀、模糊和整串正则四种匹配；关键词比较与 Dice! 一样按 ASCII 大小写不敏感处理；支持 `limit` 的 `user_id`、`grp_id`、`prob` 子集 |
| `msg_reply.type` | Emulated | `Reply`/`Both` 接入非命令 hook；`Order`/`Nor`/`Game` 不在第一版 hook 中执行 |
| `event` 生命周期事件 | Emulated | 支持 `hook` 直写或 Dice! 原生 `trigger.hook` 形式的 `StartUp`、`MessageReceived`、`GroupJoined`、`GroupMemberJoined`、`GuildJoined`、`BecomeFriend`、`Poke`、`GroupLeave`；通过独立 VM 注入全局 `event` Context |
| `task_call` | Unsupported | 当前不创建宿主 task；后续按异步生命周期单独设计 |
| `.toml` reply/event 文件 | Unsupported | 需先转换为 Lua envelope |
| `require` / `loadLua` | Emulated | 仅能加载插件 envelope `modules` 中声明的虚拟模块；拒绝路径和动态模块 |
| Dice! 原生命令 | Unsupported | 本项目不移植命令 |
| Dice! 全局文案 | Unsupported | 仅兼容插件产生的文案 |
| 宿主 `/plugin` 目录扫描 | Forbidden | Sealpack 运行时不拥有该能力 |

## 2. 全局 Lua 函数

| API | 第一版 | 兼容语义 |
| --- | --- | --- |
| `log` | Required | 映射到扩展日志；Dice! 的通知级别参数暂不参与过滤 |
| `loadLua` | Emulated | 只解析虚拟模块名，不接受宿主路径 |
| `getDiceQQ` | Best-effort | 返回当前消息 endpoint 的 userId；无 endpoint 时返回空字符串 |
| `getDiceDir` | Unsupported | 不暴露宿主路径 |
| `mkDirs` | Forbidden | 禁止文件系统写入 |
| `getSelfData` | Required | 映射到插件命名空间下的 JSON 存储 |
| `getGroupConf` / `setGroupConf` | Emulated | 映射到插件隔离的扩展存储；不读取或修改 SealDice 原生群配置 |
| `getUserConf` / `setUserConf` | Emulated | 映射到插件隔离的扩展存储；不读取或修改 SealDice 原生用户配置 |
| `getUserToday` / `setUserToday` | Emulated | 使用 UTC 日期分区的插件隔离扩展存储；不等同 Dice! 今日统计 |
| `getPlayerCardAttr` / `setPlayerCardAttr` / `getPlayerCard` | Emulated | 支持 `(uid, gid)` 角色卡键；映射到插件隔离存储，不修改 SealDice 原生角色卡 |
| `ranint` | Required | 使用宿主可测试的随机源，测试场景支持固定 seed |
| `sleepTime` | Unsupported | 不阻塞 Goja 扩展循环 |
| `drawDeck` | Emulated | 复用 `seal.deck.draw` 在当前消息上下文抽牌；Lua 传入的 gid/uid 仅用于兼容签名，不允许跨目标投递 |
| `sendMsg` | Best-effort | 仅允许投递到当前消息的群或用户目标，复用 SealDice 当前回复队列；跨目标投递返回 Lua 错误 |
| `eventMsg` | Unsupported | 不伪造第二套消息队列或虚拟事件 |
| `askExtra` | Unsupported | SealDice 1.6.0 没有对应通用扩展 API |

## 3. Lua 模块与 userdata

| 模块/API | 第一版 | 兼容语义 |
| --- | --- | --- |
| `Set.new`、`in`、`add`、`remove`、`totable` | Required | 使用 Lua 语义的受控 Set |
| `Context` 字段读取 | Required | 映射消息、用户、群组和匹配字段 |
| `Context:get` | Required | 支持默认值和安全字段访问 |
| `Context:__newindex` | Emulated | 只写当前调用 scratch；不得修改宿主 `MsgContext`，持久化必须走显式 API |
| `Context:format` | Required | 使用 SealDice 模板格式化；不得暴露 Dice! 全局命令 |
| `Context:echo` | Required | 公开回复；第三参数按 Dice! 语义表示“不做模板格式化” |
| `Context:inc` | Required | 对兼容上下文数值字段递增 |
| `SelfData` 属性读写 | Required | 自动 JSON 持久化；无真实文件对象 |
| `GameTable` 字段读写 | Unsupported | DiceSession、日志、旁观和链接无等价 SealDice API |
| `GameTable:message` | Unsupported | 不伪造 DiceSession 广播 |
| `Actor:get/set` | Emulated | 读写插件隔离角色卡字段；属性赋值和 `nil` 删除均持久化 |
| `Actor:rollDice` | Unsupported | Actor bridge 尚未接入 |
| `Actor:locked/lock/unlock` | Emulated | 使用插件隔离锁键；不影响 SealDice 原生锁或群组状态 |
| `http.get` | Unsupported | SealDice 公开 JS 设施是 Promise `fetch`，无法安全地实现 Dice! 同步返回；后续单独设计异步 bridge |
| `http.post` | Unsupported | 同上；不得阻塞 Goja 等待网络结果 |
| `http.urlEncode/urlDecode` | Required | 纯函数，无宿主权限 |
| `io` | Forbidden | 不打包 Fengari Node io 库 |
| `os` 文件/进程 API | Forbidden | 不暴露文件、环境、进程和退出能力 |
| `debug.debug` | Unsupported | 不提供同步终端交互 |
| `package.loadlib` | Forbidden | 禁止动态 C/JS 模块加载 |

## 4. `msg` / `event` 字段

| 字段/行为 | 第一版 | 备注 |
| --- | --- | --- |
| `fromMsg` / 原始消息文本 | Required | UTF-8 字符串 |
| `uid` / `gid` / `chid` | Required | 缺失域使用 0 或空字符串，具体由 bridge 规范化 |
| `msgid` | Best-effort | 只有宿主提供稳定 raw ID 时可用 |
| `nick` / 用户名 | Required | 使用 SealDice sender/player 信息 |
| `grp` / `group` | Emulated | 只提供兼容层可读群组对象 |
| `user` / 用户上下文 | Emulated | 只提供兼容层可读用户对象 |
| `game` | Unsupported | 不连接 DiceSession |
| `msg:echo(text[, noFormat])` | Required | 通过 `seal.replyToSender` 输出；`noFormat=true` 时跳过模板格式化 |
| handler 第二返回值 | Emulated | 映射 `seal.replyPerson`，失败不得公开发送 |
| Lua 返回 `(public, hidden)` | Required | 字符串或 nil；发送前按 SealDice 模板格式化，其他类型视为错误 |

## 5. 触发限制

| Dice! 限制 | 第一版 | 说明 |
| --- | --- | --- |
| `user_id` / `grp_id` / `prob` | Emulated | 在 `msg_order`/`msg_reply` 分发前执行用户/群组白名单或黑名单，以及 1–99% 概率门槛；从 `msg.uid`/`msg.gid` 读取身份 |
| `lock` / `cd` / `today` | Unsupported | 需要 Dice! 的锁和调度器状态，不能映射为一次性 SealDice hook；注册时记录诊断并跳过这些条件 |
| `user_var` / `grp_var` / `self_var` | Unsupported | 依赖 Dice! 属性变量比较器，当前不执行 |
| `dicemaid:only/off` | Best-effort | 只在能可靠识别当前 endpoint 身份时生效 |
| Dice! 群组“禁用回复/停用指令”开关 | Unsupported | 不移植 Dice! 原生命令和群设置 |

## 6. 安全与限制

| 限制 | 第一版要求 |
| --- | --- |
| Lua 指令预算 | Required；超限终止当前调用 |
| coroutine/递归深度 | Best-effort | Fengari 保留 coroutine 库；独立递归配额尚未接入 |
| 单次输出数量与字符数 | Required |
| HTTP 主机、超时、响应体 | Unsupported | 同步 HTTP 未实现；URL 编解码仍为 Required |
| 存储字节数、键数、嵌套深度 | Required |
| Lua 错误隔离 | Required；单插件失败不拖垮扩展 |
| 动态路径、文件、进程、原生模块 | Forbidden |
| 运行时插件源码回显 | Forbidden | `list`/`info` 只能显示 ID、状态、字符数和非加密展示指纹 |
| 运行时 Lua 模块上传 | Unsupported | 消息管理模式只保存一个源码文件；需要 `loadLua` 模块时使用静态 envelope |

## 7. 第一版验收样例

第一版至少需要以下 Lua fixture 和 Sealwrapper 场景：

1. `msg_order` 函数返回公开文本。
2. `msg_order` 函数返回公开和隐藏文本。
3. `msg_reply` 的完全匹配、前缀匹配和正则匹配。
4. `getSelfData` 跨消息保存、重载后恢复、非法状态隔离。
5. `ranint` 和 `http.urlEncode`。
6. 不支持的 `event`、`task_call` 和同步 HTTP 产生诊断。
7. Lua 语法错误、运行时异常、冲突 ID、超指令预算和不支持 API 的诊断。

未通过上述验收前，不把支持等级从 Draft 提升为稳定契约。
