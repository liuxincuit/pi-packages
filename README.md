# pi-packages

pi 插件集合。每个插件一个独立 npm 包，可单独安装，不捆绑。

## 包列表

| 包 | 目录 | 做什么 | 发布 |
|---|---|---|---|
| `@liuxincuit/pi-ask-user-question` | `packages/ask-user-question` | 让模型把选择题交给用户 | 未发布 |
| `@liuxincuit/pi-auto-prepend` | `packages/auto-prepend` | 每 N 轮注入一条自定义消息 | 未发布 |
| `@liuxincuit/pi-bash-approver` | `packages/bash-approver` | 自动批准 bash 命令的权限询问 | 未发布 |
| `@liuxincuit/pi-compact-tools` | `packages/compact-tools` | 紧凑渲染内置工具 | 未发布 |
| `@liuxincuit/pi-costtime` | `packages/costtime` | working 行显示每轮耗时 | 未发布 |
| `@liuxincuit/pi-deepseek-web` | `packages/deepseek-web` | DeepSeek 的 `web_search` / `web_fetch` | 未发布 |
| `@liuxincuit/pi-fix-nul-redirect` | `packages/fix-nul-redirect` | 把 `> nul` 改写为 `> /dev/null` | 未发布 |
| `@liuxincuit/pi-inject-model-name` | `packages/inject-model-name` | 把当前模型名注入系统提示 | 未发布 |
| `@liuxincuit/pi-model-profiles` | `packages/model-profiles` | `/profile` 档案切换 | 未发布 |
| `@liuxincuit/pi-notify-on-reply` | `packages/notify-on-reply` | Windows 回复通知 | 未发布 |
| `@liuxincuit/pi-persistent-history` | `packages/persistent-history` | 跨会话保留输入历史 | 未发布 |
| `@liuxincuit/pi-pi-graph` | `packages/pi-graph` | `/pi-graph` 查看注册全貌 | 未发布 |
| `@liuxincuit/pi-rules-context` | `packages/rules-context` | 按文件路径注入规则 | 未发布 |
| `@liuxincuit/pi-subdir-context` | `packages/subdir-context` | 加载子目录的 `AGENTS.md` | 未发布 |
| `@liuxincuit/pi-tree-summaries` | `packages/tree-summaries` | 会话树摘要预设 | 未发布 |
| `@liuxincuit/pi-prompts` | `packages/prompts` | 提示词模板 | 未发布 |
| `@liuxincuit/pi-codegraph` | `packages/codegraph` | CodeGraph 符号与调用路径 | 已发布 |
| `@liuxincuit/pi-skills` | `packages/skill-manager` | `/skills` 管理与用量统计 | 已发布 |

`package.json` 里带 `private: true` 的包暂不发布。`codegraph` 和 `skill-manager` 保留各自已发布的包名与包内布局。

## 安装

从 npm 安装单个插件：

```bash
pi install npm:@liuxincuit/pi-codegraph
pi install npm:@liuxincuit/pi-skills
```

从本地工作区安装单个插件：

```bash
pi install D:/code/pi-packages/packages/costtime
```

本地路径包不会被安装依赖，运行时依赖由 pi 宿主提供。需要 typecheck 或 smoke 时先在仓库根执行 `npm install`。

## 本地开发

验证所有扩展能加载：

```bash
node .tmp/verify-load.mjs
```

跑纯逻辑单测：

```bash
npm test
```

`codegraph` 额外有类型检查和冒烟测试：

```bash
npm run typecheck --workspace=@liuxincuit/pi-codegraph
npm run smoke --workspace=@liuxincuit/pi-codegraph
```

## 包布局

普通包：

```
packages/costtime/
├── package.json      # pi.extensions 指向 ./index.ts
├── index.ts
└── README.md
```

带辅助模块的包把辅助文件一起列进 `files`；`tree-summaries` 还要带上 `builtin/`。

`attic/next-phase` 是停用扩展，不是包，不参与加载。

## 相关仓库

- `D:/code/skills`：技能集合与依赖技能的工作流，继续通过 `D:/code/skills` 加载 skills。
