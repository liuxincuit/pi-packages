# pi-skills

给 pi 用的扩展集合。

## skill-manager

查看已加载的 skill，并控制哪些 skill 对模型可见。不改动任何 `SKILL.md`、目录名或 pi 自身的 settings。

### 命令

```
/skills                                  列出全部 skill
/skills disable <name>                   禁用（默认只作用于当前会话）
/skills enable  <name>                   启用（默认只作用于当前会话）
/skills disable <name> --project         禁用并写入项目配置
/skills enable  <name> --project         启用并写入项目配置
/skills disable <name> --global          禁用并写入全局配置
/skills enable  <name> --global          启用并写入全局配置
```

输入 `/skills` 后按 Tab 逐级补全：子命令 → skill 名 → 作用域 flag。

列表输出：

```
  名称              可见  来源     状态          描述
  openspec-explore  yes   project  默认          进入探索模式，把想法聊清楚
  supermap-search   no    package  作者声明隐藏  搜索超图内部资料
  xlsx              no    package  禁用(会话)    读写电子表格文件
```

「可见」列为 `no` 有两种原因，「状态」列负责区分：skill 作者在 `SKILL.md` 里声明了
`disable-model-invocation: true`，或者被本工具禁用（括号里是生效的作用域）。

### 三层作用域

| 层 | 存哪 | 生效范围 |
|---|---|---|
| 会话 | 进程内存 | 当前会话，退出即失效 |
| 项目 | `<cwd>/.pi/extensions/pi-skills/config.json` | 该项目下之后启动的会话 |
| 全局 | `<agentDir>/extensions/pi-skills/config.json` | 任何项目 |

`agentDir` 默认是 `~/.pi/agent`（可用 `PI_CODING_AGENT_DIR` 覆盖）。

合并规则是 `会话 > 项目 > 全局`，每层取「禁用」「启用」「未提及」三态之一，
生效的是优先级最高的那个**显式设定**。所以「全局禁用 xlsx，本项目启用 xlsx」是可行的。

### 配置文件

```json
{
	"version": 1,
	"skills": {
		"xlsx": "disabled"
	}
}
```

取值只有 `"disabled"` 和 `"enabled"`。文件缺失、内容损坏或出现未知取值时，
该层按「未提及」处理，不影响其他层。项目配置只在项目受信任时读取。

### 行为边界

- 禁用只影响**模型的自动路由**：被禁用的 skill 不再出现在系统提示里，
  但 `/skill:<name>` 仍可显式调用
- 开关在下一个模型请求生效，不需要 `/reload`
- 会话层状态纯内存，且不随 `/tree` 分支切换回滚
- `/skills` 的输出只进终端，不进入模型上下文

### 安装

本仓库是一个 pi package。

1. 把仓库路径加进 `~/.pi/agent/settings.json` 的 `packages`：

```json
{
	"packages": ["D:/code/pi-skills"]
}
```

2. 重启 pi 或执行 `/reload`，然后 `/skills` 即可用

临时试用（不改任何配置）：

```bash
pi -e <仓库路径>/pi/extensions/skill-manager/index.ts
```

### 开发

纯逻辑模块（`skills.ts`、`scope.ts`、`render.ts`）不 import pi 运行时，可以直接跑测试：

```bash
node --test pi/extensions/skill-manager/*.test.mts
```

代码结构：

```
pi/extensions/skill-manager/
  index.ts    入口：注册 /skills 命令，在 before_agent_start 里过滤提示中的 skill
  skills.ts   清单读取：优先命令上下文的 getSystemPromptOptions()，降级解析系统提示
  scope.ts    三层配置的读写与合并
  render.ts   文本表渲染（按终端显示宽度对齐）
```
