# fix-nul-redirect

把 bash 命令里的 `> nul` 重定向改写成 `> /dev/null`。

## 做什么

拦截 `tool_call` 事件里的 bash 命令，把 Windows 风格的空设备重定向改写掉。

根因：pi 默认用 Git Bash (MSYS2) 执行命令，MSYS2 把 `nul` 视为普通文件名，会在当前目录创建真实文件 `nul`，且 Windows 设备名限制使其无法被正常删除。

匹配 `(?:[12]?>\s*)nul\b`（大小写不敏感），覆盖 `> nul`、`>nul`、`> NUL`、`1>nul`、`2> nul` 等写法，只替换 `nul` 部分，保留重定向符号与前缀。命令无变化时不写回。

## 配置

无。

## 调试

让模型跑 `echo hi > nul`，检查两点：命令是否被改写为 `> /dev/null`，以及当前目录有没有多出 `nul` 文件。

## 陷阱

只处理 `nul`。`con` / `aux` / `prn` 等其他 Windows 设备名不在范围内。
