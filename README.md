# pi-kit

一个 pi 包，装齐我在多台机器上用的扩展、技能与提示词。`pi update --extensions` 一条命令同步。

## 安装

```bash
pi install npm:@liuxincuit/pi-kit
```

依赖只有 pi 宿主提供的 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`，不需要额外安装。装完 `/reload` 生效。

本地开发用仓库根直接装：

```bash
pi install .
```

## 只装其中一部分

整包默认全开，17 个扩展都加载。不想要其中几个有两种做法。

### 改 settings.json

把 `~/.pi/agent/settings.json` 里那条字符串改写成对象，加 `extensions` 过滤列表：

```json
{
  "packages": [
    {
      "source": "npm:@liuxincuit/pi-kit",
      "extensions": [
        "!extensions/notify-on-reply/index.ts",
        "!extensions/compact-tools/index.ts"
      ]
    }
  ]
}
```

结果就是只去掉这两个，其余 15 个照常加载。语法（都实测过）：

| 写法 | 效果 |
|---|---|
| 不写 `extensions` 字段 | 全部加载 |
| `["!extensions/<名字>/index.ts"]` | 只去掉它，其余照常 |
| `["!extensions/<名字>/**"]` | 同上，按目录排除 |
| `[]` | 一个扩展都不加载 |
| `["extensions/pi-graph/index.ts", "extensions/costtime/index.ts"]` | 白名单，只加载这两个 |
| `["!extensions/*/index.ts", "+extensions/costtime/index.ts"]` | 全关，再加回一个 |

`+` 是强制包含（精确路径），`-` 是强制排除（连包含和强制包含一起盖掉）。

技能与提示词用同样语法，写在 `skills` / `prompts` 字段里，路径是 `skills/<名字>/SKILL.md`、`prompts/<文件名>.md`：

```json
{
  "source": "npm:@liuxincuit/pi-kit",
  "skills": ["!skills/codegraph/SKILL.md"],
  "prompts": []
}
```

要点：

- **路径相对包根**，不是相对你的 cwd。写错路径不会报错，只是过滤不生效。
- **技能与扩展是独立的**：去掉 `codegraph` 扩展，`skills/codegraph` 还会加载，要一起去掉得在 `skills` 里单独排除。
- 过滤只能**收窄**包自己声明过的资源，无法加出包里没有的东西。
- 改完 `/reload`。

### 用 pi config

跑 `pi config`，Tab 切到包作用域，逐项开关扩展、技能、提示词。效果与手写 `settings.json` 相同，只是不用记路径。

## 里面有什么

`pi` 字段声明三个约定目录，pi 按它们加载：

```json
"pi": {
  "extensions": ["./extensions"],
  "skills": ["./skills"],
  "prompts": ["./prompts/*.md"]
}
```

### 扩展（17 个）

每个扩展一个目录，入口固定是 `index.ts`；辅助模块放在同一目录，`extensions/` 的一层子目录只认 `index.ts`，所以辅助文件不会被误当扩展加载。

| 目录 | 做什么 |
|---|---|
| `ask-user-question/` | 让模型把选择题交给用户，而不是自己猜 |
| `auto-prepend/` | 每 N 轮自动往对话注入一条自定义消息 |
| `bash-approver/` | 自动批准 pi-permission-system 对 bash 命令的询问 |
| `codegraph/` | CodeGraph 符号与调用路径，含 `/codegraph-*` 命令 |
| `compact-tools/` | 覆盖内置 `read`/`bash`/`edit`/`write` 的紧凑渲染，附 bash 默认超时与 `.env` 注入 |
| `costtime/` | working 行显示每轮耗时，结束后写入对话流 |
| `deepseek-web/` | 用 DeepSeek Search/Fetch API 提供 `web_search` 与 `web_fetch` |
| `fix-nul-redirect/` | 把 bash 命令里的 `> nul` 改写成 `> /dev/null` |
| `inject-model-name/` | 把当前模型名注入系统提示 |
| `model-profiles/` | `/profile` 按会话切换一组资源与系统提示 |
| `notify-on-reply/` | Windows 上收到回复时弹系统通知 |
| `persistent-history/` | 跨 `/reload`、`/new` 和新会话保留输入历史 |
| `pi-graph/` | `/pi-graph` 查看插件与生命周期的注册全貌 |
| `rules-context/` | 按文件路径注入规则 |
| `skill-manager/` | `/skills` 管理与用量统计（数据目录固定 `pi-skills`） |
| `subdir-context/` | 读取文件时自动加载该文件所在子目录的 `AGENTS.md` |
| `tree-summaries/` | 把「回到会话树开头 + 留下上下文」做成 `/tree:<名字>` 预设 |

每个目录下有自己的 `README.md`，写清了配置、调试步骤和陷阱。

几个有副作用的，装之前先看对应 README：

- `compact-tools` 不只改渲染：默认 120 秒超时、注入 `~/.pi/agent/.env`、移除代理变量
- `bash-approver` 需要 `@gotgenes/pi-permission-system`，还要在它的 `authorizerChain` 里显式启用
- `persistent-history` 用 `setEditorComponent` 替换编辑器，和同样改编辑器的扩展互斥
- `notify-on-reply` 仅 Windows

### 技能与提示词

| 路径 | 是什么 |
|---|---|
| `skills/pi-extension-dev/` | pi 扩展开发与验证的流程 |
| `skills/codegraph/` | CodeGraph 查询技能的说明 |
| `prompts/prompt_init.md` 等 4 个 | 提示词模板 |

## 本地开发

仓库无运行时依赖。改完扩展后：

```bash
npm test                       # 纯逻辑单测（Node >= 22）
node .tmp/verify-kit.mjs 17    # 用 pi 自己的包管理器 + loader 全量加载，核对 17 个扩展
```

`verify-kit.mjs` 用隔离的临时 `settings.json`，不动真实配置，判据是 `reduce errors` 与 `load errors` 都为空、且扩展数等于预期。

需要 pi 运行时的行为（对话框、切会话、消息注入、UI 渲染）只能靠 TUI 手动验证，步骤写在各扩展的 README「调试」节。

## 结构约定

- 扩展放 `extensions/<名字>/index.ts`，辅助模块同目录。
- 带数据文件的扩展要保证数据随包分发：`tree-summaries` 的 `builtin/`、`codegraph` 的 `docs/` 都在各自目录内，路径用 `import.meta.url` 定位，不依赖仓库位置。
- 新增技能放 `skills/<名字>/SKILL.md`，新增提示词放 `prompts/`。
- `files` 排除 `*.test.mts`，其余随 `extensions/`、`skills/`、`prompts/` 整个打包。
