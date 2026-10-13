# Tasks

## 1. 日志模块 usage.ts（纯逻辑，不 import pi 运行时）

- [x] 1.1 建立 `usage.ts`，定义日志记录类型与单行序列化/反序列化；运行 `node --test pi/extensions/skill-manager/usage.test.mts` 通过，覆盖五个字段齐全、非法 JSON 返回 undefined
- [x] 1.2 实现路径归一化（`\` → `/`、相对转绝对、不碰大小写）；单元测试断言相对路径、反斜杠绝对路径、已归一化路径三种输入产出同一结果
- [x] 1.3 实现日志读取与容错：文件不存在、空文件、含无法解析的行、末行被截断；单元测试断言坏行被跳过且其余记录完整统计
- [x] 1.4 实现滚动窗口聚合（72 / 168 / 720 / 2160 / 4320 小时，累积）；单元测试断言较长窗口次数不小于较短窗口，且同一份数据在时间戳带不同时区偏移时结果一致
- [x] 1.5 实现统计起点推导（日志中最早一条记录的时间）；单元测试断言空日志返回空值
- [x] 1.6 在 README 的「代码结构」段补上 `usage.ts` 一行，并确认写明的 `node --test` 命令能跑通

## 2. read 通道采集

- [x] 2.1 在 `usage.ts` 实现按 toolCallId 的 pending 表与提交判定（`durationMs !== undefined && isError === false`）；单元测试覆盖成功提交、`isError` 为真不提交、`durationMs` 缺失不提交、end 无对应 start 时不提交四种情形
- [x] 2.2 在 `index.ts` 注册 `tool_execution_start` 与 `tool_execution_end` 两个钩子，把 read + 以 `/SKILL.md` 结尾的调用写入日志；验证：让模型读取任一 SKILL.md 后 `cat <agentDir>/extensions/pi-skills/usage.jsonl`，出现一条 `"via":"read"` 且 path 为绝对路径、分隔符为 `/`
- [x] 2.3 在 `agent_end` 清空 pending 表；用 2.1 的接口断言连续多次调用后表中不残留未配对条目

## 3. 显式调用通道

- [x] 3.1 把「某条消息是否触发了 skill 显式调用」提取为不依赖 pi 运行时的纯函数（输入消息角色与文本块，输出 SKILL.md 路径或空）；单元测试断言非 user 消息、无 skill 块的消息、解析失败的消息都不产出记录
- [x] 3.2 在 `index.ts` 注册 `message_start`，对 user 消息调用 3.1 的判定并写入日志；验证：执行 `/skill:<某个已加载的 skill>` 后日志出现一条 `"via":"explicit"` 记录，且其 path 与对应 skill 的 SKILL.md 一致

## 4. 统计表渲染（扩展 render.ts）

- [x] 4.1 在 `render.ts` 实现统计表渲染：三段分组、五个累积窗口、最后使用列；单元测试断言列对齐正确（复用 `displayWidth`）、三段标题与顺序符合规格
- [x] 4.2 单元测试覆盖边界：空日志、当前已加载但全部无记录、幽灵数量超过一屏、skill 名超长被截断
- [x] 4.3 实现统计起点标注与「起点距今天数不足 180 天」的不完整提示；单元测试断言两种情形的文案各自出现

## 5. 命令接线与补全

- [x] 5.1 在 `index.ts` 的 `/skills` handler 增加 `stats` 分支，输出只走 `ctx.ui.notify`；验证：执行 `/skills stats` 后会话记录不新增消息条目，模型上下文内容不变
- [x] 5.2 在 `complete.ts` 的 ACTIONS 加入 `stats` 并补上描述，同步更新 `complete.test.mts` 的断言；`node --test` 通过，且 `/skills st` 的补全候选包含 `stats`
- [x] 5.3 更新 README：命令表加入 `/skills stats`，行为边界段写明统计起点与不回填历史；确认 README 里出现的每条命令与实际行为一致
- [x] 5.4 用 pi 自己的 loader（`dist/core/extensions/loader.js` 的 `loadExtensions`）加载扩展入口，确认 `result.errors` 为空

## 6. 集成验证

- [x] 6.1 端到端：新会话里对同一个 skill 各触发一次模型路由加载与一次 `/skill:` 显式调用，`/skills stats` 中该 skill 的五个窗口计数均为 2（两条通道各记一条，按 name 聚合），最后使用为「今天」
- [x] 6.2 验证 `/tree` 切换分支或恢复旧会话不重放 `message_start`（切换后比对日志条数不变）；若重放，回到 design.md 的 D1 重新评估膨胀问题
- [x] 6.3 验证子代理会话写入的 session 与 cwd 是子会话自己的值（跑一个子代理后检查日志），确认子代理的调用没有被记到父会话名下
- [x] 6.4 验证容错：把 `usage.jsonl` 写成损坏内容后，`/skills stats` 按「全部无记录」输出且不报错，`/skills` 与 `/skills disable` 的正常行为不受影响

## Workflow follow-up

- 满足项目评审要求后归档变更。
- 归档后核对主 spec 的 Purpose 与 requirements 是否完整。
