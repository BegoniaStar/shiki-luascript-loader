# Dice Lua Compatibility Layer

本项目的目标是在 SealDice 1.6.0 的 JavaScript/Goja 扩展运行时中，加载并执行 Dice!（溯洄骰）Lua 插件。

## 兼容矩阵

### 1. 插件注册与触发

| 能力 | 第一版 | 说明 |
| --- | --- | --- |
| 声明式 Lua 源码包 | Required | 从受校验的 index/envelope 资源加载；不扫描宿主目录 |
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

### 2. 全局 Lua 函数

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

### 3. Lua 模块与 userdata

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

### 4. `msg` / `event` 字段

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

### 5. 触发限制

| Dice! 限制 | 第一版 | 说明 |
| --- | --- | --- |
| `user_id` / `grp_id` / `prob` | Emulated | 在 `msg_order`/`msg_reply` 分发前执行用户/群组白名单或黑名单，以及 1–99% 概率门槛；从 `msg.uid`/`msg.gid` 读取身份 |
| `lock` / `cd` / `today` | Unsupported | 需要 Dice! 的锁和调度器状态，不能映射为一次性 SealDice hook；注册时记录诊断并跳过这些条件 |
| `user_var` / `grp_var` / `self_var` | Unsupported | 依赖 Dice! 属性变量比较器，当前不执行 |
| `dicemaid:only/off` | Best-effort | 只在能可靠识别当前 endpoint 身份时生效 |
| Dice! 群组“禁用回复/停用指令”开关 | Unsupported | 不移植 Dice! 原生命令和群设置 |

### 6. 安全与限制

| 限制 | 第一版要求 |
| --- | --- |
| Lua 指令预算 | Required；超限终止当前调用 |
| coroutine/递归深度 | Best-effort | Fengari 保留 coroutine 库；独立递归配额尚未接入 |
| 单次输出数量与字符数 | Required |
| HTTP 主机、超时、响应体 | Unsupported | 同步 HTTP 未实现；URL 编解码仍为 Required |
| 存储字节数、键数、嵌套深度 | Required |
| Lua 错误隔离 | Required；单插件失败不拖垮扩展 |
| 动态路径、文件、进程、原生模块 | Forbidden |


`msg_order` 描述表支持 Lua 函数和纯文本 `echo`，并支持 `limit` 的 `user_id`、`grp_id`、`prob` 子集；`msg_reply` 支持缺省条目名关键词、Match/Prefix/Search/Regex（大小写不敏感，其中 Regex 为整串匹配）及同样的限制。`sendMsg` 仅能发送到当前消息目标。Lua 返回文本和默认 `msg:echo` 文本会经过 SealDice 模板格式化。

## 使用教程

### 1. 准备工具链

Node、npm 和 Go 版本由 mise 管理。首次使用时在项目根目录执行：

```sh
mise install
mise exec -- npm ci
```

`sealwrapper`/`sealw` 必须在 PATH 中；可以用下面的命令确认：

```sh
which sealwrapper
sealwrapper doctor
```

### 2. 把 Lua 插件封装为资源

兼容层不会扫描宿主的 `/plugin` 目录，也不会读取任意 Lua 路径。插件必须先放入
`assets/dice-lua/plugins/`，并封装为 JSON envelope：

```json
{
  "format": "sealdice-dice-lua-plugin-v1",
  "id": "compat-demo",
  "modules": {},
  "source": "-- 完整 Lua 源码"
}
```

`source` 是完整 Lua 源码，`modules` 是可由 `loadLua(name)` 加载的虚拟模块表；
模块名不能包含路径。推荐用 Node 生成 envelope，避免手工转义 Lua 中的换行和引号：

```sh
mkdir -p assets/dice-lua/plugins
LUA_FILE='tests/lua/compat-demo.lua' mise exec -- node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync(process.env.LUA_FILE, 'utf8');
const envelope = {
  format: 'sealdice-dice-lua-plugin-v1',
  id: 'compat-demo',
  modules: {},
  source,
};
writeFileSync(
  'assets/dice-lua/plugins/compat-demo.lua.json',
  `${JSON.stringify(envelope, null, 2)}\n`,
);
NODE
```

然后编辑 `assets/dice-lua/index.json`，将 envelope 路径加入 `plugins`：

```json
{
  "format": "sealdice-dice-lua-index-v1",
  "plugins": ["plugins/compat-demo.lua.json"]
}
```

索引路径必须是 `plugins/<普通文件名>.lua.json`；插件 `id` 在所有 envelope 中必须唯一。

### 3. 本地验证插件

先运行 Lua VM 和资源测试：

```sh
mise exec -- npm test
mise exec -- sealwrapper typecheck --target 1.6.0
mise exec -- sealwrapper goja scan --target 1.6.0
mise exec -- sealwrapper resource check --target 1.6.0
mise exec -- sealwrapper scenario test --target 1.6.0
```

仓库自带的原创示例 `tests/lua/compat-demo.lua` 可以直接复用真实加载回归测试，
覆盖字符串函数名、同文件 helper、SelfData、群组存储、Actor、回复限制和事件。
插件使用 `msg_order['.dlhelp'] = 'compat_help'` 这类字符串函数名时，
兼容层会按 Dice! 语义重新执行同一源码，再取得顶层函数及其 helper。

### 4. 通过消息管理小型 Lua 插件

默认管理命令为 `.luaplug`，只接受满足 `management.min-privilege` 的用户；默认值为
`100`（骰主），并且默认仅允许私聊。命令名、权限门槛、是否限于私聊、大小/数量上限、
帮助和所有管理回复都可在扩展配置的 `management.*` 中修改。

`add`、`update` 和 `validate` 将 `<id>` 后的全部内容视作一份 Lua 源码，因此源码必须在
同一条消息中提交；可以包含换行，适合很小的单文件脚本。消息管理模式下的运行时插件
不支持模块上传，因此不能使用 `loadLua` 加载自定义模块。

```text
.luaplug list
.luaplug info demo
.luaplug validate demo msg_order = { ping = function(msg) return "pong" end }
.luaplug add demo msg_order = { ping = function(msg) return "pong" end }
.luaplug update demo msg_order = { ping = function(msg) return "updated" end }
.luaplug disable demo
.luaplug enable demo
.luaplug remove demo
```

`add`、`update` 和 `enable` 会先在隔离 Lua VM 中校验。只有校验成功才会写入扩展
storage，并重建命令、回复和事件注册表；校验失败或超过配置上限时保留旧版本。`list` 和
`info` 只显示 ID、启用状态、源码字符数和非加密指纹，不会在消息中回显源码。运行时插件
不能使用静态 sealpack 中已有的插件 ID，也不会修改 `assets/dice-lua/index.json`。

单条消息放不下的 Lua 源码应改用上文的 sealpack envelope；运行时管理面有意不提供任意
文件路径、压缩包或分片上传能力。

### 5. 构建并安装

运行：

```sh
mise exec -- sealwrapper package
```

或使用项目脚本：

```sh
mise exec -- npm run build
```

构建结果位于 `release/sealdice-dice-lua-compat@0.1.0.sealpack`，同时会生成
`.sha256` 和 release provenance 文件。将 `.sealpack` 导入 SealDice 1.6.0 的扩展/插件
管理器，启用扩展并重载 JS 扩展即可；实际菜单名称由 SealDice 版本决定。
