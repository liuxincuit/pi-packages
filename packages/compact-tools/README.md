# compact-tools

覆盖内置的 `read` / `bash` / `edit` / `write` 四个工具，换成自绘的紧凑渲染；顺带给 bash 注入默认超时与 `.env` 环境。

## 做什么

- **紧凑渲染**：四个工具改为 `renderShell: "self"`，自绘调用行与结果行。成功命令无输出时折叠成一行，失败或展开时才铺开全文。执行期间用 spinner + 耗时提示（按 `toolCallId` 分别计状态，并发工具互不干扰）。
- **技能读取折叠**：路径末段是 `SKILL.md` 时（pi 把技能当普通文件读，只能靠文件名认），未展开渲染成单行 `│ [skill] <父目录名>  (ctrl+o to expand)`，颜色跟随成功/失败；展开后退回 `read <路径>`，保留文件位置。普通文件不受影响，仍是原来的两行 `read <路径>` + `↳ loaded N lines`。判定只看文件名、不校验目录：任何叫 `SKILL.md` 的文件都这样显示。
- **ANSI 清洗**：剥掉工具输出里的背景色 SGR 参数，保留前景色，避免主题色串到整个终端。
- **bash 默认超时**：LLM 没传 `timeout` 时按 `DEFAULT_BASH_TIMEOUT_SECONDS`（120 秒）执行，防止 `find` 全盘搜索之类的长驻命令无限阻塞。
- **bash 环境注入**：从 `~/.pi/agent/.env` 读 `KEY=VALUE` 注入 bash 环境，同时移除 `HTTP_PROXY` / `HTTPS_PROXY` / `http_proxy` / `https_proxy` / `all_proxy`。

## 配置

| 项 | 位置 | 说明 |
|---|---|---|
| 环境变量 | `~/.pi/agent/.env` | `KEY=VALUE`，支持 `#` 注释、空行、单双引号；文件不存在时不改动 env |
| 默认超时 | 源码导出的 `DEFAULT_BASH_TIMEOUT_SECONDS` | 改动需编辑源码后 `/reload` |

## 调试

改完必须 `/reload`。

技能折叠：让模型读一个 `SKILL.md`（如本仓库的 `skills/supermap-jira/SKILL.md`），未展开应是单行 `│ [skill] supermap-jira  (ctrl+o to expand)`；按 expand 键后首行退回 `│ read <绝对路径>` 并铺开正文。读不存在的技能文件时整行转红，不出现展开提示。读普通文件应保持 `│ read <路径>` + `  ↳ loaded N lines` 两行。

bash 超时：不传 `timeout` 跑 `sleep 200`，应在 120 秒时中断，且错误消息里附带默认超时的说明——用来区分“LLM 自己设的超时”和“扩展注入的默认超时”。LLM 显式传入的 `timeout` 原样透传，并保持 pi 原生的错误格式。

## 陷阱

**超时改不动 `spawnHook`。** `spawnHook` 只能改 `command` / `cwd` / `env`，注入默认超时得整体包装 `operations`（`createLocalBashOperations()` 保持原生行为）。

**技能折叠的判定分散在两处，必须同步改。** `getDetail` 把标题行换成 `[skill] <名字>` 并挂展开提示，`getSummary` 对同一路径返回 `undefined` 省掉第二行摘要；两处共用 `skillNameFromPath`。只改一处会出现“只有名字没提示”或“提示重复两遍”。展开提示只在终态挂：`isPartial` 为真（参数流式、执行中、结果流式）不挂，`isError` 为真（没内容可展开）也不挂。

**`getDetail` 的第三个参数是 pi 的渲染上下文。** `expanded` / `isPartial` / `isError` / `cwd` 都在里面，技能折叠靠它判断；返回值多出的 `label` 字段可覆盖工具默认名，其余渲染分支照用。

**`renderCall` 与 `renderResult` 有明确分工。** 只在参数流式期间出调用行（那时还没有 partial result，`renderResult` 不会被调，否则模型产出参数时界面整段空白）；执行开始或已有结果时让 `renderResult` 独占，包括 `/reload` 重放历史的情况——那时不会再发 `tool_execution_start`。

**要主动发一次空 partial。** `renderResult` 只在有 result 时被调用，read/edit/write 这类不产生流式输出的工具执行期间会整行不可见，所以 `execute` 开头手动 `onUpdate({ content: [], details: undefined })`。

**覆盖的是工具名而非实现细节**：`name` / `description` / `parameters` 全部沿用内置工具的定义，只替换渲染与执行包装。改完必须 `/reload` 才生效。
