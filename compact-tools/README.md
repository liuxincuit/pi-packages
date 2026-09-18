# compact-tools

覆盖内置的 `read` / `bash` / `edit` / `write` 四个工具，换成自绘的紧凑渲染；顺带给 bash 注入默认超时与 `.env` 环境。

## 做什么

- **紧凑渲染**：四个工具改为 `renderShell: "self"`，自绘调用行与结果行。成功命令无输出时折叠成一行，失败或展开时才铺开全文。执行期间用 spinner + 耗时提示（按 `toolCallId` 分别计状态，并发工具互不干扰）。
- **ANSI 清洗**：剥掉工具输出里的背景色 SGR 参数，保留前景色，避免主题色串到整个终端。
- **bash 默认超时**：LLM 没传 `timeout` 时按 `DEFAULT_BASH_TIMEOUT_SECONDS`（120 秒）执行，防止 `find` 全盘搜索之类的长驻命令无限阻塞。
- **bash 环境注入**：从 `~/.pi/agent/.env` 读 `KEY=VALUE` 注入 bash 环境，同时移除 `HTTP_PROXY` / `HTTPS_PROXY` / `http_proxy` / `https_proxy` / `all_proxy`。

## 配置

| 项 | 位置 | 说明 |
|---|---|---|
| 环境变量 | `~/.pi/agent/.env` | `KEY=VALUE`，支持 `#` 注释、空行、单双引号；文件不存在时不改动 env |
| 默认超时 | 源码导出的 `DEFAULT_BASH_TIMEOUT_SECONDS` | 改动需编辑源码后 `/reload` |

## 调试

不传 `timeout` 跑 `sleep 200`，应在 120 秒时中断，且错误消息里附带默认超时的说明——用来区分"LLM 自己设的超时"和"扩展注入的默认超时"。LLM 显式传入的 `timeout` 原样透传，并保持 pi 原生的错误格式。

## 陷阱

**超时改不动 `spawnHook`。** `spawnHook` 只能改 `command` / `cwd` / `env`，注入默认超时得整体包装 `operations`（`createLocalBashOperations()` 保持原生行为）。

**`renderCall` 与 `renderResult` 有明确分工。** 只在参数流式期间出调用行（那时还没有 partial result，`renderResult` 不会被调，否则模型产出参数时界面整段空白）；执行开始或已有结果时让 `renderResult` 独占，包括 `/reload` 重放历史的情况——那时不会再发 `tool_execution_start`。

**要主动发一次空 partial。** `renderResult` 只在有 result 时被调用，read/edit/write 这类不产生流式输出的工具执行期间会整行不可见，所以 `execute` 开头手动 `onUpdate({ content: [], details: undefined })`。

**覆盖的是工具名而非实现细节**：`name` / `description` / `parameters` 全部沿用内置工具的定义，只替换渲染与执行包装。改完必须 `/reload` 才生效。
