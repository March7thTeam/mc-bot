# 扩展与接入

机器人能在四个地方定制：AI 后端、外部 agent 接入、工作流、模组扩展。每一种都有明确的边界，写错了只会被拒绝并在日志里说明原因，不会让机器人带着半套配置跑。

## AI 后端

在 `.env` 里用 `AI_PROVIDER` 选后端，也可以写进 `config.json` 的 `ai.provider`。

| 后端 | 用途 | 关键设置 |
|---|---|---|
| `deepseek`（默认） | DeepSeek 官方接口，带思考模式 | `DEEPSEEK_API_KEY` |
| `openai` | 任何 OpenAI 兼容的 `/chat/completions`：OpenAI、通义、Kimi、智谱、OpenRouter、Ollama、LM Studio、vLLM 等 | `AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY`（本机地址可以不填） |
| `anthropic` | Claude（官方 SDK），默认 `claude-opus-5-5` | `ANTHROPIC_API_KEY`，可选 `AI_MODEL`、`AI_BASE_URL` |
| `external` | 不用内置 AI：玩家说的自然语言变成 `request` 事件，交给连着 Agent API 或 MCP 的外部 agent 处理 | 需要开 Agent API |
| `off` | 只认固定指令 | |

边界：
- **地址**：`AI_BASE_URL` 必须是 https，只有本机地址能用 http；地址里不能带账号或查询参数。
- **额度**：`AI_RPM`、`AI_RPH` 限制请求数，失败、取消和超时的请求也算进去。
- **AI 的权限**：所有后端的 AI 都走同一套动作白名单，AI 不能自己 `drop`、`say`、`goal`。
- **Claude 拒绝时**：默认会自动换个模型重试（只有官方地址支持）。设 `AI_FALLBACKS=off` 关掉。

## 本机 Agent API 和 MCP

设置 `MC_AGENT_PORT` 和 `MC_AGENT_TOKEN`（至少 24 位，可以用 `openssl rand -hex 24` 生成）后，会在 `http://127.0.0.1:<端口>/v1` 开一个 HTTP 接口。

| 接口 | 作用 |
|---|---|
| `GET /state` | 坐标、血量、饥饿、维度、背包、忙不忙、附近玩家、启用的扩展 |
| `GET /commands` | 可用指令（含扩展指令） |
| `POST /command` `{cmd, args, wait, as}` | 执行固定指令。`wait` 默认 true，等做完再返回结果和机器人说的话。`as` 指定代哪个在线玩家下令（`come`、`follow` 需要） |
| `POST /say` `{text}` | 在公屏说话（以 `/` 开头的会被改写，不能借此执行服务器指令） |
| `POST /ask` `{text}` | 交给内置 AI 理解并执行 |
| `POST /stop` | 全部停下 |
| `GET /workflows`、`POST /workflows/<id>/run` | 列出、运行工作流 |
| `GET /events`（SSE）、`GET /events/recent?since=<id>` | 事件：`chat`、`request`、`say`、`task`、`workflow`、`death` |

边界：
- **令牌**：每个请求都要带 `Authorization: Bearer <令牌>`。
- **防网页借道**：带 `Origin` 头的浏览器请求一律拒绝，`Host` 头不对也拒绝，所以网页没法借你的浏览器打过来（含 DNS 重绑定）。
- **请求限制**：请求体最多 16KB；每分钟最多 120 个请求；事件流最多 4 个连接。
- **校验**：指令和玩家在聊天里下的走同一套参数校验。
- **正忙时**：机器人忙的时候下干活指令会返回 409，不会偷偷排队。
- **监听地址**：默认只听 127.0.0.1。改了 `MC_AGENT_HOST` 会在日志里警告。

**MCP**：`scripts/mcp-server.js` 把上面的接口包成 MCP 工具（`minecraft_state`、`minecraft_command`、`minecraft_events` 等 9 个），没有额外依赖。在 Claude Code 里注册：

```bash
claude mcp add minecraft -e MC_AGENT_TOKEN=<令牌> -e MC_AGENT_PORT=25599 -- node /path/to/mc-bot/scripts/mcp-server.js
```

Claude Desktop、Cursor 等客户端按各自的方式配置同一条命令即可。配合 `AI_PROVIDER=external`，就能让外部 agent 当机器人的大脑：用 `minecraft_events` 读到玩家的请求，再用 `minecraft_command` 去执行。

## 工作流

在 `workflows/` 里放 `.json`（换目录用 `MC_WORKFLOWS_DIR`），把一串指令编成一件事。运行方式：
- 玩家：`bot run <id>`；`bot workflows` 列出全部。
- AI：工作流写了 `"ai": true` 才能调用。
- Agent API / MCP：直接运行。
- 自动触发：按 `trigger` 设置。

```json
{
  "id": "wood", "name": "补木头", "description": "木头不够 16 就去砍，再做个箱子",
  "ai": true,
  "trigger": { "on": "idle", "cooldown": 600 },
  "onFail": "stop",
  "steps": [
    { "if": { "has": "oak_log", "lt": 16 }, "do": "chop", "args": ["16"] },
    { "do": "craft", "args": ["chest", "1"] },
    { "say": "箱子做好了" },
    { "wait": 5 },
    { "repeat": 3, "steps": [{ "do": "fish", "args": ["1"] }] }
  ]
}
```

- **步骤**有五种：`do`（任意固定指令或扩展指令）、`say`、`wait`（秒）、`repeat`（重复一组步骤）、`ask`（交给 AI）。
- **条件** `if` 有四种：`has` 加 `lt` 或 `gte`（背包里某物品的数量）、`time: day/night`、`healthBelow`、`foodBelow`。
- **触发** `trigger.on` 有七种：`manual`（默认）、`spawn`、`night`、`day`、`playerJoined`、`idle`（空闲 1 分钟）、`interval`（配合 `every` 秒）。每个工作流都有 `cooldown` 冷却。

边界：
- **校验**：每一步都过玩家指令的参数校验。
- **不能嵌套**：工作流里不能调用 `run`、`goal`、`auto`，所以不会套娃。
- **AI 可调用的工作流**：只能包含 AI 本来就能下的指令，也不能用 `ask`，免得 AI 和工作流互相等待。
- **规模**：展开后最多 200 步，`repeat` 最多嵌套 2 层，`wait` 最多 600 秒，整个工作流最多 `maxMinutes`（默认 30，最多 240）分钟。
- **停止**：`bot stop` 随时能停。
- **自动触发**：只在完全空闲时进行（不在跟随、站岗、干活或执行目标），`MC_WORKFLOWS_AUTO=off` 可以全局关掉。

## 模组扩展

内置的模组支持在 `mods/` 里，你自己写的放 `extensions/`，与内置同 id 时会覆盖内置的。示例在 `extensions/examples/`。

**`.json` 扩展**只有数据，不执行任何代码，别人发来的也能放心装：

```json
{
  "id": "my-mod",
  "namespaces": ["mymod"],
  "summary": "背包里出现 mymod:xxx 物品时 AI 会看到这句说明",
  "components": { "mymod:charge": "varint" },
  "tips": [{ "keys": ["mymod", "充能"], "text": "MyMod 的机器要先充能再右键" }],
  "prompt": "本服装了 MyMod：它的机器别拆",
  "features": { "sharedInventory": false }
}
```

- `activate`：何时启用。
  - `auto`（默认）：服务器注册表里出现了 `namespaces` 里的命名空间才启用。只有 Fabric 服会同步注册表。
  - `always`：总是启用。
  - `manual`：只有 `MC_MODS` 点名才启用。纯服务端模组（比如共享背包）只能这样开。
- `components`：模组物品组件的编码。模组组件在网络包里没有长度前缀，不知道编码，带这种组件的物品就读不出来。
  - 只能声明自己命名空间下的组件。
  - 编码只能用 `bool u8 i8 i16 i32 i64 f32 f64 varint varlong string UUID anonymousNbt GlobalPos position vec3f`。
  - 两个扩展给同一个组件写了不同编码时，两个都不用。宁可读不出来，也不按错的编码读歪后面的数据。
- `features`：服务器规则。`sharedInventory` 和 `sharedHealth` 打开后会写进 AI 的提示。
- `tips`、`prompt`、`summary`：给 AI 和 `bot tip` 用的知识，有长度上限。

### Refined Storage 3.2.1

Fabric 26.1.2 的隔离服务器上，使用带非空组件的 `/give` 物品捕获了下面 9 个 `set_slot` 样本。它们使用组合字段、可选值、列表或嵌套物品栈，现有扩展的基础类型无法表达。带这些组件的物品在背包或容器包中不受支持。

- `refinedstorage:regulator_upgrade_state`
- `refinedstorage:security_card_bound_player`
- `refinedstorage:security_card_permissions`
- `refinedstorage:configuration_card_state`
- `refinedstorage:pattern_state`
- `refinedstorage:crafting_pattern_state`
- `refinedstorage:processing_pattern_state`
- `refinedstorage:stonecutter_pattern_state`
- `refinedstorage:smithing_table_pattern_state`

### JavaScript 扩展

**`.js` 扩展**在数据之外还能写 `setup(api)`：

```js
module.exports = {
  id: 'ping', activate: 'always',
  setup(api) {
    api.command('ping', { help: '看延迟', read: true, run: () => api.say(`延迟 ${api.bot.player?.ping} ms`) })
    api.on('death', () => api.log('死了一次'))
  },
}
```

- **只装信得过的**：`.js` 扩展和机器人本身一样有本机的全部权限，只装自己看过、信得过的。
- **扩展指令**：
  - 不能和已有指令重名；只有玩家能用，AI 调用不到。
  - 参数最多 8 个，每个最长 64 字。
  - `read: true` 的指令忙的时候也能用，私聊来的私聊回；其他指令走任务系统，有超时，`bot stop` 能停。
- **出错**：`setup` 或事件回调出错只记日志；同一个扩展连续出错 10 次，会自动停掉它的事件监听。
- **读取**：扩展目录只读普通文件，不跟随符号链接，单个文件最大 256KB、最多 64 个。

## config.json

除了密钥以外的设置都可以写进 `config.json`，参考 `config.example.json`，也可以用 `MC_CONFIG` 指定别的路径。

- **优先级**：环境变量优先于文件。
- **严格校验**：不认识的键和类型不对的值都会直接报错退出。
- **密钥**：键名里带 key、password、token、secret 的一律拒绝，密钥只能放 `.env`。
