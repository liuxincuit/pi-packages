# inject-model-name

把当前模型名注入系统提示。

## 安装

```bash
pi install npm:@liuxincuit/pi-inject-model-name
```

`@earendil-works/pi-coding-agent` 由 pi 宿主提供，不需要额外安装。
装完 `/reload` 后生效。

从源码调试时用本地路径安装（在仓库根执行）：

```bash
pi install ./packages/inject-model-name
```

## 做什么

在 `before_agent_start` 时把 `\n\n当前模型: <model.id>` 追加到 `systemPrompt`，让模型知道自己正跑在哪个模型上。

## 配置

无。

## 调试

直接问模型"你当前是什么模型"，回答应带 `ctx.model.id` 里的标识符（而不是模型自称的名字）。

## 陷阱

`ctx.model` 缺失时直接返回，不修改提示词。读的是 `model.id`，不是显示名。
