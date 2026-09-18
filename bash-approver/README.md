# bash-approver

自动批准 pi-permission-system 对 bash 命令的询问，免掉弹窗。

## 做什么

pi-permission-system 对包装器命令（`sudo`、`env`、`xargs`、`bash -c`、`eval` 等）有 fail-closed 设计：即使配了 `"bash": { "*": "allow" }`，这些命令的 allow 也会被强制提升为 ask 并弹窗，且没有配置项能关掉。

本扩展利用 pi-permission-system 的 authorizer chain 扩展点，注册一个 chain link，对所有 `bash` 表面的 ask 直接返回 `allow`。

**安全边界**：只批准 `surface === "bash"` 的 ask。`external_directory` / `path` 表面的 ask 一律 `defer`，仍由用户裁决，目录限制不受影响。chain owner 还会把该 link 在这两个表面上的 allow 降级为 defer（双保险）。

代价是 `sudo` 之类的包装命令不再有人工确认，只建议在信任 agent 的环境里启用。

## 配置

需要在 pi-permission-system 的 `config.json` 里把 `bash-approver` 加进 `authorizerChain` 显式启用，否则注册了也不生效。

## 调试

link 注册成功后会通过 authorizer log 记录 `bash_approver.decision`，含 `requestId`、`command`、`verdict`。用 `sudo true` 之类的包装命令验证是否还弹窗。

## 陷阱

**服务定位走 `Symbol.for`，不走 import。** pi-permission-system 把服务发布在 sessionId 键控的进程级 Map 上（键为 `Symbol.for("@gotgenes/pi-permission-system:session-services")`）。本仓库无 `node_modules`，`import("@gotgenes/pi-permission-system")` 会解析失败，所以直读那个 Symbol。

- 27.0.0 起零参 `getPermissionsService()` 弃用
- 29.0.0 起 process-root 槽 `Symbol.for("...:service")` 不再写入——读旧槽只会拿到 `undefined`，注册静默失效

**按 sessionId 逐节点注册、逐节点释放。** 一个进程可有多个节点（父会话 + 每个 in-process 子代理），各自持有独立的 registry 和 authorizer chain，且只读本节点注册的 link，所以不做跨节点去重。

**必须去重，否则抛异常。** `permissions:ready` 在每个节点至少触发两次（`session_start` 后一次、首个 `before_agent_start` 一次），重复注册会撞上 `registerAuthorizer` 的重名检查。

用 `permissions:ready` 而不是 `session_start` 作为注册点：它在首个 `before_agent_start` 还会再触发一次，晚于所有扩展的 `session_start`，因此不依赖扩展加载顺序。
