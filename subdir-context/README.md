# subdir-context

读取文件时自动加载该文件所在子目录的 `AGENTS.md`。

## 做什么

`read` 工具返回结果后，沿目标文件的父目录链向上查找 `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md`，找到即作为 `<system-reminder>` 追加到结果里，让子目录的局部约定在访问到该目录时才生效。

搜索范围：

- 当前会话 cwd 及其子目录（默认）
- 配置文件里 `extraRoots` 声明的额外根目录及其子目录

范围内每找到一层就注入一层，多个命中文件按从上到下的顺序排列。会话内每个文件只注入一次。cwd 自身的那份由 pi 的常规上下文加载负责，本扩展会跳过它。

## 配置

可选，文件不存在则跳过。项目级与全局的 `extraRoots` **合并取并集**：

| 位置 | 说明 |
|---|---|
| `<cwd>/.pi/extensions/subdir-context/config.json` | 项目级 |
| `~/.pi/agent/extensions/subdir-context/config.json` | 全局 |

```json
{
  "extraRoots": ["~/projects/foo", "D:/docs/team", "sub/dir"]
}
```

`extraRoots` 是字符串数组，支持绝对路径、`~` 展开、相对路径（相对会话 cwd）。配置在每次 `read` 时重新读取，改动即时生效，无需重启会话。

测试时可用环境变量 `PI_SUBDIR_CONTEXT_CONFIG` 覆盖全局配置路径。

## 调试

命中时在 TUI 会话里会弹 `加载子目录上下文: <路径>` 通知。读取失败会弹 warning。

## 陷阱

**只对 `read` 工具触发**，且忽略出错的读取结果。

**读 `AGENTS.md` 文件本身时不注入**——只把该文件记为已加载，避免自己注入自己。

**生态目录不再自动加载。** 只有会话 cwd 与 `extraRoots` 范围内的文件会触发注入；`~/.pi`、技能目录、插件目录、`~/.claude` 等目录里的 `AGENTS.md` / `CLAUDE.md` 不会被自动加载。需要它们生效就显式加进 `extraRoots`。

路径比较前会做 realpath 归一化，符号链接指向同一文件时不会重复注入。
