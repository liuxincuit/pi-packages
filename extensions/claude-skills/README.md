# claude-skills

让 pi 加载 Claude Code 的项目技能目录 `<项目根>/.claude/skills`。

团队里大部分人在 Claude Code 里写技能、pi 的用户直接用同一个仓库时，不需要再把 `SKILL.md` 复制或软链到 `.pi/skills`。

## 安装

随 `@liuxincuit/pi-kit` 一起加载，装完 `/reload` 生效。单独从这个仓库调试时用：

```bash
pi install .
```

## 发现规则

从会话 cwd 向上逐层查找 `.claude/skills`，到 **git 根**为止（含）。所以从子目录启动 pi 也能找到仓库根目录的技能：

```
/repo/.git/
/repo/.claude/skills/        ← 加载
/repo/packages/app/          ← cwd
/repo/packages/app/.claude/skills/  ← 也加载（存在的话）
/repo/packages/.claude/skills/      ← 也加载
```

找不到 git 根时只查 cwd，不会一路扫到 home。

只加载目录里符合 pi 技能规范的 `SKILL.md`：目录自身有 `SKILL.md` 就是一个技能根，否则递归找子目录里的 `SKILL.md`。Claude 的 `<skill-name>/SKILL.md` 结构直接可用。

**不支持** `~/.claude/skills`：本扩展只做项目级兼容，用户级技能仍然放 `~/.pi/agent/skills` 或 `~/.agents/skills`。

## 信任与冲突

- **未受信任的项目不加载**：与 pi 对 `.pi/skills`、`.agents/skills` 的处理一致，`resources_discover` 里先查 `ctx.isProjectTrusted()`。
- **同名冲突时已有技能赢**：pi 把扩展路径追加到已有技能列表之后，先加载的优先。所以 `.pi/skills`、`.agents/skills` 和用户级技能优先于 `.claude/skills`。冲突会出现在 pi 的资源诊断里，但不会阻止加载。
- **只加不改**：不修改 `.claude/skills` 里的任何文件，也不影响 Claude Code 自己的加载。

## 调试

启动会话后运行 `/skills`（需要 `skill-manager` 扩展），列表里来源为 `path` 的就是通过本扩展注入的技能。

路径没有加载时依次检查：

1. 目录是否存在：`ls <项目根>/.claude/skills`
2. 项目是否受信任（未信任时 pi 会先问一次）
3. 每个技能是否有非空的 `description` 字段——缺失会被 pi 丢弃

## 陷阱

**没有热重载。** `resources_discover` 在会话启动与 `/reload` 时触发，新建或修改 `SKILL.md` 后要 `/reload` 或重开会话。

**Claude 的专属字段不生效。** pi 只读 `name`、`description`、`disable-model-invocation`，`allowed-tools`、`hooks`、`model` 等字段会被忽略。技能正文里依赖这些字段的行为需要手动改写。

**技能名必须符合 pi 的规范。** 小写字母、数字、连字符，最长 64 字符；`name` 缺失时用父目录名。不合规只产生警告，仍然加载，但 `/skill:<名字>` 可能用不了。
