# Spec Delta

## Purpose

让用户看到本机上每个 skill 实际被调用过多少次、最后一次是什么时候，从而判断哪些 skill 值得保留、哪些可以移除。统计自日志中最早一条记录起算，不回溯该记录之前的调用。

## ADDED Requirements

### Requirement: Skill 调用记录

每次 skill 被加载时，系统 SHALL 向本机日志追加一条记录，包含发生时间、触发通道、该 skill 的 SKILL.md 绝对路径、会话标识与工作目录。触发通道 SHALL 至少区分「模型路由」与「用户显式调用」两种。

#### Scenario: 模型经 read 工具加载 skill
- **WHEN** 模型调用 read 工具读取某个 SKILL.md，且该次读取实际执行
- **THEN** 日志追加一条通道为「模型路由」的记录

#### Scenario: 用户显式调用 skill
- **WHEN** 用户输入 `/skill:<name>` 且该 skill 存在
- **THEN** 日志追加一条通道为「用户显式调用」的记录

#### Scenario: 读取的不是 skill 文件
- **WHEN** 模型调用 read 工具读取一个不以 SKILL.md 结尾的文件
- **THEN** 不产生任何记录

#### Scenario: 读取未实际发生
- **WHEN** 某次对 SKILL.md 的读取被其他扩展阻止，或读取本身失败
- **THEN** 不产生记录

#### Scenario: 显式调用后模型又读取同一文件
- **WHEN** 用户在上一步显式调用某 skill 后，模型又读取了同一个 SKILL.md
- **THEN** 两个通道各自记一条，合计计为两次调用

### Requirement: 路径归一化

写入日志前，系统 SHALL 把 SKILL.md 路径解析为绝对路径并统一目录分隔符，使同一文件的相对写法与绝对写法归为同一条目。

#### Scenario: 模型给出相对路径
- **WHEN** 模型调用 read 读取 `skills/foo/SKILL.md` 这类相对路径
- **THEN** 日志中记为该文件相对于当前工作目录解析后的绝对路径

#### Scenario: 同一文件的不同写法
- **WHEN** 同一 SKILL.md 先后以反斜杠绝对路径与正斜杠相对路径被加载
- **THEN** 两次记录归一为同一条目，不再拆分计数

### Requirement: 统计从安装起算，不回填历史

系统 MUST NOT 扫描既有会话记录来补算安装之前的调用。统计起点 SHALL 是该日志中最早一条记录的时间。

#### Scenario: 首次使用
- **WHEN** 用户刚装好该能力后首次执行 `/skills stats`
- **THEN** 所有 skill 的各窗口次数均为零，且不因历史会话中存在大量调用而出现非零值

#### Scenario: 日志被清空
- **WHEN** 日志文件被删除或清空后再次执行 `/skills stats`
- **THEN** 所有窗口次数归零，统计起点随之向后推移

### Requirement: 统计起点在输出中可辨识

统计输出 SHALL 标注统计起始时间。当起点距今短于表中最长的窗口时，输出 SHALL 说明该窗口的数据不完整。

#### Scenario: 统计不足半年
- **WHEN** 统计起点距今不足 180 天，用户执行 `/skills stats`
- **THEN** 输出标注统计起点，并说明半年窗口的覆盖不完整

### Requirement: 按滚动窗口聚合

`/skills stats` SHALL 输出最近 3 天、7 天、1 个月、3 个月、半年五个窗口内的调用次数。各窗口 SHALL 按距当前时刻的滚动时长计算（分别对应 72、168、720、2160、4320 小时），SHALL NOT 按自然日或日历时区边界切分。各窗口为累积统计，较长窗口的次数 SHALL NOT 小于较短窗口的次数。

#### Scenario: 窗口为累积而非分桶
- **WHEN** 某个 skill 在最近 3 天内被调用 3 次、在 4 至 7 天前被调用 2 次
- **THEN** 该 skill 的 3 天窗口显示 3、7 天窗口显示 5

#### Scenario: 结果不随时区变化
- **WHEN** 同一份日志在不同时区的机器上被聚合
- **THEN** 各窗口次数一致

### Requirement: 统计表以日志为主轴分三段

统计表 SHALL 以「日志中出现过记录的 skill」为主轴，而非仅以当前会话已加载的 skill 为主轴，并 SHALL 分为三段：当前已加载且有记录、有记录但当前未加载、当前已加载但无记录。

#### Scenario: 有记录但当前未加载
- **WHEN** 某 skill 在本机日志中有调用记录，但不在当前会话已加载的清单里
- **THEN** 该 skill 出现在第二段，而不是被省略

#### Scenario: 已加载但从未记录
- **WHEN** 某 skill 在当前会话已加载，但本机日志中没有任何关于它的记录
- **THEN** 该 skill 出现在第三段，且不显示窗口次数

#### Scenario: 日志为空
- **WHEN** 本机日志中没有任何记录
- **THEN** 输出中第一、二段为空，第三段列出当前已加载的全部 skill，且系统不报错

### Requirement: 最后使用时间

对有记录的行，统计表 SHALL 显示该 skill 最后一次被调用的距今时间。

#### Scenario: 显示距今时间
- **WHEN** 某 skill 的最后一次记录发生在 25 天前
- **THEN** 该行显示其距今时长

#### Scenario: 与窗口次数提供不同信息
- **WHEN** 某 skill 在半年窗口内有一定次数，但最后一次调用发生在 4 个月前
- **THEN** 该行同时呈现累计次数与该最后使用时间

### Requirement: 统计输出不进入模型上下文

`/skills stats` 及其全部输出 SHALL NOT 写入会话的模型上下文。

#### Scenario: 查看统计后模型上下文不变
- **WHEN** 用户执行 `/skills stats`
- **THEN** 会话记录中不新增由该命令产生的消息条目，模型上下文内容不变

### Requirement: 日志缺失或损坏时降级为空记录

日志文件不存在、无法解析、或含有无法解析的行时，系统 SHALL 把无法解析的部分视为无记录并继续正常工作，SHALL NOT 报错或中断其他命令。

#### Scenario: 日志文件不存在
- **WHEN** 本机日志文件不存在，用户执行 `/skills stats`
- **THEN** 输出按「全部无记录」呈现，扩展与其余命令正常

#### Scenario: 日志末行被截断
- **WHEN** 日志最后一行为不完整的 JSON
- **THEN** 该行被跳过，其余记录照常统计

### Requirement: 采集不改变会话行为

统计采集 SHALL NOT 改变任何工具调用的结果、MUST NOT 阻断或改动用户输入、MUST NOT 修改事件对象。日志写入失败时 SHALL 静默丢弃该条记录。

#### Scenario: 日志写入失败
- **WHEN** 日志文件不可写（磁盘满、被占用或权限不足）
- **THEN** 相关的工具调用与用户输入照常完成，不出现由本扩展引发的失败

#### Scenario: 采集只观察不干预
- **WHEN** 扩展正在采集某次调用
- **THEN** 该次工具调用的参数与结果、以及用户输入的文本都不被改动
