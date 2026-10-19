# deepseek-web

用 DeepSeek 官方 [Search / Fetch API](https://api-docs.deepseek.com/zh-cn/guides/search) 提供 `web_search` 与 `web_fetch` 两个工具，替代 pi-web-access。

## 做什么

| | pi-web-access | 本扩展 |
|---|---|---|
| 搜索 provider | 30+ 个可选 | 只有 DeepSeek 自研引擎 |
| 抓取方式 | 客户端（Readability + Turndown），各自的 header/cookie/代理 | 服务端抓完直接给 Markdown |
| 全文 | 搜索后逐个抓，存盘，用 `get_search_content` 分页 | 内联 + 截断；或在同一次搜索里用 `includeContent` 取回 |
| PDF / YouTube / GitHub 克隆 / 图片 | 支持 | 不支持 |
| 计费 | 各 provider 不同 | 每 1000 次成功请求 $0.75，失败不计费 |

DeepSeek 的两个端点各 5 QPS（账户级、互相独立），所以多 query 与多 URL 都是**串行**执行，见下。

### 参数

`web_search`：`query` / `queries`（最多 4 条）/ `numResults`（默认 5，上限 20）/ `includeContent` / `recencyFilter` / `domainFilter`

`web_fetch`：`url` / `urls`

`domainFilter` 与 `recencyFilter` 会被编译进查询串（`site:`、`-site:`、`after:`），**计入 128 字符上限**，超了报错而不是静默截断——截断会悄悄改变检索范围。

### domainFilter 的补搜

服务端的 `site:` 是软过滤（见「陷阱」），所以结果拿回来后要按 host 再滤一遍，滤完可能不足 `numResults`。这时会**自动补搜**：

| 轮次 | `count` | 说明 |
|---|---|---|
| 1 | 目标条数 | 首轮 |
| 2 | 目标 × 3 | 结果有序，必须放大 count 才能拿到排在后面的新结果 |
| 3 | 目标 × 9 | 最多 3 轮；超过 API 上限 50 就封顶 |

补搜只在**给了 `domainFilter`** 时发生。跨轮结果按 URL 去重（先到的位置保留）。

停止条件：① 够数；② 引擎返回的条数少于请求的 `count`（结果池已耗尽）；③ 3 轮用完。

**成本**：每补搜一次就多一次计费请求。TUI 里会在结果行显示 `· N requests`（仅当 N > query 数时），`details.requests` 也带着这个数。

### 输出上限

| 常量（`logic.ts`） | 值 | 作用 |
|---|---|---|
| `MAX_SUMMARY_CHARS` | 1200 | 每条结果的摘要；服务端标称 600-800，实测能到 2600+ |
| `MAX_ITEM_CONTENT_CHARS` | 8000 | `includeContent` 时每条结果的正文 |
| `MAX_FETCH_CONTENT_CHARS` | 30000 | 每个 URL 的抓取正文，超出附一行截断提示 |
| `MAX_QUERY_CHARS` | 128 | 服务端硬限制 |

## 配置

配置**只**从 `~/.pi/agent/extensions/deepseek-web/config.json` 读。不读环境变量、不读 `~/.pi/web-search.json`、也不借用 pi 的 DeepSeek 登录态（`auth.json`）——用哪把 key、连哪个地址始终可预测。

```json
{
  "baseURL": "https://api.deepseek.com/v1/tools",
  "apiKey": "sk-...",
  "enabled": {
    "search": true,
    "fetch": true
  }
}
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `baseURL` | `https://api.deepseek.com/v1/tools` | 到 `/v1/tools` 这一级，代码再拼 `/search` 与 `/fetch`。可换自建代理，仅限 http/https |
| `apiKey` | 空 | **必填**。为空时工具仍注册，但调用会报出完整配置指引 |
| `enabled.search` | `true` | `false` 时 `web_search` **不注册**，模型完全看不到 |
| `enabled.fetch` | `true` | `false` 时 `web_fetch` **不注册** |

开关注入也接受扁平写法（顶层 `"search": false`），但嵌套写法优先。开关只认 `false`——写 `"false"`（字符串）或 `0` 都算开启，避免配置静默失效。

### 生效时机

| 改动 | 需要 `/reload`？ |
|---|---|
| `apiKey` / `baseURL` | **不需要**，下次调用即生效（每次请求前重读文件） |
| `enabled.search` / `enabled.fetch` | **需要**，开关在扩展工厂执行时读 |

### 配置缺失或损坏时

- **文件不存在** → 两个工具都注册，`apiKey` 为空；调用时返回带配置路径的错误
- **JSON 语法错误** → 打到 stderr，两个工具仍注册，调用时报错
- **JSON 合法但不是对象**（如 `"sk-abc"`）→ 同上
- **`baseURL` 协议不对** → 同上，错误里指出字段名

失败时不静默降级—否则你会以为配置生效了。

## 调试

```bash
# 纯逻辑单测（零依赖，Node ≥ 22）
node --test pi/extensions/deepseek-web/*.test.mts

# 用 pi 自己的 loader 加载本仓库全部扩展（比打包更能发现 jiti 解析与工厂抛错）：
# errors 为空、且工具列表里出现 web_search/web_fetch 才算通过。
# 脚本见 skills/pi-extension-dev/SKILL.md 的「验证」节。

# 端到端：真实 pi 会话里让模型调一次
pi -p --no-extensions -e "$(pwd)/pi/extensions/deepseek-web/index.ts" \
  --session-dir .tmp/s1 "调用 web_search 搜索 'OpenSpec 是什么'，只回复第一条结果的标题"
```

验证开关行为不需要改真实配置：用临时 HOME 跑扩展工厂，看注册到哪几个工具即可（`config.test.mts` 覆盖纯函数部分）。

改动后**要 `/reload` 才生效**：pi 的 loader 按路径缓存模块。

pi 1.3.0 起安装里**不再自带 esbuild**，`AGENTS.md` 里那条 esbuild 打包验证的路径已失效；改用上面的 loader 验证。

## 陷阱

- **`domainFilter` 已做客户端二次过滤**：服务端的 `site:` 是**软过滤**，实测 `site:github.com` 会返回 `https://pkg.go.dev/github.com/...`——引擎按 URL 字符串里是否出现 `github.com` 匹配，不看 host。所以拿回结果后 `logic.ts` 的 `filterByDomain` 再按 host 滤一遍（含子域，排除优先），不足数时自动补搜。

- **5 QPS 是账户级的**，实测 8 路并发搜索必现 429（`Your current QPS: 5`）。限速器在 `api.ts` 顶层，父子会话共享同一实例——这是有意的，对应的正是账户级配额。不要把它挪进 `execute`，那会让每个会话各拿一份配额。
- **Fetch API 对"目标站页面不存在"照样返回 200**：`api-docs.deepseek.com/zh-cn/no-such-page` 返回 200 + 一页 "Page Not Found"，而 `httpbin.org/status/404` 返回 404。服务端只反映抓取动作本身，状态码不是有效性判据，这里也不猜内容有效性。
- **抓回来的 Markdown 有一层多余转义**：`#` → `\#`、`/` → `\/`、`,` → `\,`，连 `<`、`=`、`{}` 都不放过。渲染出来没问题，纯文本里全是噪音，所以 `logic.ts` 的 `unescapeMarkdown` 会按 CommonMark 规则还原 ASCII 标点转义（字母数字前的反斜杠不动，`C:\path\to` 安全）。
- **`summary` 字段不能折叠空白**：它是多行 Markdown，压成一行会把标题和正文挤在一起。`logic.ts` 里 `text()`（折叠，用于标题/片段）与 `block()`（保留换行，用于摘要/正文）的区别就是这个。
- **没有 `get_search_content`**：全文只在当次输出里，超出上限的部分就丢了。需要长文档时抓更具体的 URL 或章节，别指望分页。
- **`recencyFilter` 可能筛掉中文内容**：`after:` 按页面的发布日期过滤，而中文站点的 `date` 常为 `null`（实测知乎/搜狐类结果多为空），这类页面会被一并过滤。
