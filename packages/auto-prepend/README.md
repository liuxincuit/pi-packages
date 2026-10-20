# auto-prepend

每 N 轮自动往对话里注入一条自定义消息。

## 做什么

在 `agent_end` 计轮次，达到间隔后在下一轮的 `before_agent_start` 注入一条 `customType: "auto-prepend"` 的消息。典型用途是每隔若干轮提醒模型"详细解释推理过程"。

会话恢复时从 `ctx.sessionManager.getBranch()` 数 assistant 历史条目重建计数，所以 `pi -r` 续跑不会从头开始。

## 配置

`~/.pi/agent/auto-prepend.json`，缺失或解析失败时用默认值：

```json
{
  "enabled": true,
  "interval": 7,
  "message": "请详细解释你的推理过程"
}
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关 |
| `interval` | number | `7` | 每多少轮注入一次，需 > 0 |
| `message` | string | 见上 | 注入的正文 |

## 命令

| 命令 | 作用 |
|---|---|
| `/auto-prepend` 或 `/auto-prepend status` | 显示开关、间隔、当前轮次、距下次触发还有几轮 |
| `/auto-prepend init` | 创建默认配置文件（已存在则不覆盖） |

## 调试

`/auto-prepend status` 看 `round: N/interval` 与下次触发距离。配置文件在每轮 `before_agent_start` 重新读取，改完立即生效，不需要重启会话。

## 陷阱

配置文件路径用 `process.env.HOME || process.env.USERPROFILE` 拼出，Windows 上依赖 `USERPROFILE`。

注入的消息只进对话上下文，`display: true` 表示会在 TUI 里显示出来。
