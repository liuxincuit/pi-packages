# Tasks

## 1. 脚手架与依赖行为回归

- [x] 1.1 建立扩展目录 `pi/extensions/skill-manager/index.ts`，并在本仓库 `package.json` 声明 `pi.extensions: ["./pi/extensions"]`；验证：`pi -p -ne -e <入口绝对路径> "回复 ok"` 能加载该扩展，且标准错误中没有扩展加载错误
- [x] 1.2 回归确认 `ExtensionCommandContext.getSystemPromptOptions()` 在当前 pi 版本上仍可用（design D2 的前提）；验证：命令处理器中打印其类型与 skill 数量，数量与本次会话实际加载的 skill 一致。若已不可用，按 design D2 的降级链实现并在此记录

## 2. 数据层

- [x] 2.1 实现 skill 清单读取：优先 `getSystemPromptOptions()`，缺失时降级解析 `ctx.getSystemPrompt()` 的 `<available_skills>`，再用 `loadSkills()` 补 `disableModelInvocation`；验证：`node --test pi/extensions/skill-manager/*.test.mts`，用假 ctx 注入三种数据源，断言归一化后字段完整
- [x] 2.2 实现配置读写：两个文件路径、三态取值、非法内容容错、项目配置的 `isProjectTrusted()` 检查；验证：`node --test` 覆盖文件缺失、非合法 JSON、未知取值、未受信任四种情况，均降级为「未提及」
- [x] 2.3 实现三层合并：按 `会话 > 项目 > 全局` 取优先级最高的显式设定；验证：`node --test` 覆盖 spec 中「上层显式设定覆盖下层」「未提及不参与覆盖」「会话层优先级最高」三个场景
- [x] 2.4 会话层状态按 sessionId 隔离，模块级不留共享可变状态；验证：`node --test` 写入两个不同 sessionId 后互不可见

## 3. 提示层过滤

- [x] 3.1 在 `before_agent_start` 中按合并结果重写 `event.systemPromptOptions.skills`；验证：真实 `pi -p` 会话禁用某 skill 后读取 session JSONL，第一条 system 消息的 `sections.skills` 不含该 skill，且其余 skill 数量与预期一致

## 4. 命令与展示

- [x] 4.1 实现 `/skills` 文本表：名称、描述、模型可见性、来源、状态，按可见宽度对齐，区分「作者声明隐藏」与「被禁用（含作用域）」；验证：`node --test` 断言渲染出的每行文本与列宽，含中文长描述不串列
- [x] 4.2 实现 `/skills disable|enable <name>` 与 `--project` / `--global` 参数解析，默认会话层；验证：执行后会话状态立即变化；带 flag 时目标 `config.json` 内容符合约定格式；未知 skill 名给出提示且不写入
- [x] 4.3 确认所有输出只经 `ctx.ui.notify`，不调用 `sendMessage` / `appendEntry`；验证：真实会话执行 `/skills` 后 session JSONL 的 message 条目数不变
- [x] 4.4 在仓库 README 记录命令用法、三层作用域与两个配置文件位置；验证：按 README 逐条执行，行为与文档一致

## 5. 集成验证

- [x] 5.1 端到端验证三层优先级：对同一 skill 分别设置全局禁用、项目启用、会话禁用，逐层确认模型可见性随之变化；验证：每步读取 session JSONL 的 `sections.skills`
- [x] 5.2 验证未受信任项目不读取项目配置；验证：`pi -p -na`（不信任项目）时项目级设定不生效，加 `-a` 后生效
- [x] 5.3 将 `D:/code/pi-skills` 加入 `~/.pi/agent/settings.json` 的 `packages`，使扩展常驻可用（修改用户全局配置，执行前需用户确认）；验证：重启 pi 后 `/skills` 无需 `-e` 即可用

## Workflow follow-up

- 归档本 change（`/opsx-archive`），归档后确认 `openspec/specs/skill-management/spec.md` 已生成且 Purpose 段落完整。
