# model-profiles

`/profile` 档案切换：按会话加载/卸载一组资源与系统提示。

## 做什么

档案是 `~/.pi/agent/profiles/<name>/` 下的一个目录，可含：

| 文件 | 作用 |
|---|---|
| `AGENTS.md` | 存在时通过 `before_agent_start` 注入 `systemPrompt` |
| `settings.json` | 声明要加载的资源，路径全部相对档案目录解析 |

`settings.json` 支持的键：

| 键 | 说明 |
|---|---|
| `packages` | 本地目录包（读其 `package.json` 的 `pi` 字段）或 `git:` 包（自动 clone 到 `~/.pi/agent/git/`）；`npm:` 暂不支持 |
| `extensions` | 直接列出的扩展文件/目录 |
| `skills` | 技能目录（通过 `resources_discover` 贡献） |
| `prompts` | 提示词目录 |
| `themes` | 主题目录 |

档案状态是**会话级**的：档案名用 `pi.appendEntry` 持久化到当前会话文件，`/new` / `/resume` / `/fork` 触发扩展重建时自动恢复；卸载由重建天然完成（注册进扩展对象的工具/事件/命令随旧实例丢弃）。footer 常驻 `profile: <name>`，对话流里会插一条激活清单（`CustomEntry` 不参与 LLM 上下文）。

## 命令

| 命令 | 作用 |
|---|---|
| `/profile` | 弹出选择器（含"无档案"选项） |
| `/profile <name>` | 切换档案 |
| `/profile off` | 清除会话档案 |

## 调试

切到某个档案后看 footer 的 `profile: <name>`，以及对话流末尾的激活清单。切换会触发 reload，观察扩展列表是否变化。

## 陷阱

**加载扩展只能用 `loadExtensions(paths)`**（进口 pi 包的 `loader.js`，走官方 jiti + alias），再把注册内容迁移到本扩展 API 上。不要用 `discoverAndLoadExtensions`——它会自动发现并执行全局/项目扩展目录的工厂，产生重复副作用。

档案目录来自 `getAgentDir()`，即 `~/.pi/agent/profiles/`。
