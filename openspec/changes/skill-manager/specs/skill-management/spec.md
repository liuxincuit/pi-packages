# Spec Delta

## Purpose

让用户在会话、项目、全局三个作用域内查看和管理已加载的 skill，使被禁用的 skill 不再出现在模型的系统提示中，且不需要修改文件或重启进程。

## ADDED Requirements

### Requirement: Skill 清单展示
执行 `/skills` 时，系统 SHALL 以文本表输出每个已加载 skill 的名称、简要描述、模型可见性、来源和当前状态。

#### Scenario: 展示已加载的 skill
- **WHEN** 用户执行 `/skills`
- **THEN** 输出一张文本表，每行对应一个已加载的 skill，含名称、描述、模型可见性、来源和状态

#### Scenario: 没有已加载的 skill
- **WHEN** 用户执行 `/skills` 且当前没有任何已加载的 skill
- **THEN** 系统提示没有可展示的 skill，且不报错

### Requirement: 清单输出不进入模型上下文
`/skills` 及其全部输出 SHALL NOT 写入会话的模型上下文。

#### Scenario: 查看清单后模型上下文不变
- **WHEN** 用户执行 `/skills`
- **THEN** 会话记录中不新增由该命令产生的消息条目，模型上下文内容不变

### Requirement: 会话级开关为默认作用域
`/skills disable <name>` 与 `/skills enable <name>` 在未给出作用域参数时 SHALL 只影响当前会话，该状态 MUST NOT 随会话树的分支切换回滚，也 MUST NOT 落盘。

#### Scenario: 默认禁用只影响当前会话
- **WHEN** 用户在未指定作用域时执行 `/skills disable xlsx`
- **THEN** xlsx 在当前会话对模型不可见，磁盘上不产生任何配置文件

#### Scenario: 分支切换不回滚
- **WHEN** 用户禁用某 skill 后在会话树中切换到另一分支
- **THEN** 该 skill 仍保持禁用

### Requirement: 项目级开关写入项目配置
带 `--project` 的开关 SHALL 把状态写入 `<cwd>/.pi/extensions/pi-skills/config.json`。

#### Scenario: 项目级禁用
- **WHEN** 用户执行 `/skills disable xlsx --project`
- **THEN** 项目配置文件中把 xlsx 记为禁用，且该状态对之后在本项目启动的会话生效

### Requirement: 全局级开关写入全局配置
带 `--global` 的开关 SHALL 把状态写入 `<agentDir>/extensions/pi-skills/config.json`。

#### Scenario: 全局级禁用
- **WHEN** 用户执行 `/skills disable xlsx --global`
- **THEN** 全局配置文件中把 xlsx 记为禁用，且该状态对之后在任何项目启动的会话生效

### Requirement: 三层作用域按优先级合并
系统 SHALL 按 `会话 > 项目 > 全局` 的优先级合并三层设定，每层取「禁用」「启用」「未提及」三态之一，取优先级最高的显式设定。

#### Scenario: 上层显式设定覆盖下层
- **WHEN** 全局把 xlsx 记为禁用，项目把它记为启用
- **THEN** 在该项目中 xlsx 对模型可见

#### Scenario: 未提及不参与覆盖
- **WHEN** 全局把 xlsx 记为禁用，项目对该 skill 未提及
- **THEN** xlsx 对模型不可见

#### Scenario: 会话层优先级最高
- **WHEN** 项目把 xlsx 记为禁用，本会话把它记为启用
- **THEN** 本次会话中 xlsx 对模型可见

### Requirement: 模型不可见的两类原因可区分
清单的模型可见性列 SHALL 区分「skill 作者声明 disable-model-invocation」与「被本工具禁用」两类原因。

#### Scenario: 作者声明隐藏
- **WHEN** 某 skill 的 `SKILL.md` 声明 `disable-model-invocation: true`
- **THEN** 清单显示该 skill 对模型不可见，并标明原因是作者声明

#### Scenario: 用户禁用
- **WHEN** 用户禁用某 skill
- **THEN** 清单显示该 skill 对模型不可见，标明原因是禁用，并指出生效的作用域

### Requirement: 禁用不影响显式调用
被禁用的 skill SHALL 仍可通过 `/skill:<name>` 显式调用。

#### Scenario: 显式调用仍可用
- **WHEN** 某 skill 对模型不可见，用户输入 `/skill:<name>`
- **THEN** 该 skill 的指令被加载并执行

### Requirement: 开关在下一个模型请求生效
通过命令做出的开关变更 SHALL 在下一个模型请求构建前生效，且 MUST NOT 要求用户执行 `/reload`。

#### Scenario: 禁用后下一个请求即生效
- **WHEN** 用户在会话进行中禁用某 skill
- **THEN** 该会话的下一次模型请求的系统提示中不再包含该 skill

### Requirement: 项目配置只在项目受信任时读取
项目级配置 SHALL 仅在当前项目受信任时被读取。

#### Scenario: 未受信任的项目
- **WHEN** 项目未受信任，且其项目配置把 xlsx 记为禁用
- **THEN** 该设定不生效，xlsx 的可见性由全局层决定

### Requirement: 配置缺失或损坏时降级为未提及
配置文件不存在、无法解析或含未知值时，系统 SHALL 把该层视为「未提及」并继续正常工作。

#### Scenario: 配置文件损坏
- **WHEN** 项目配置文件的内容不是合法 JSON
- **THEN** 扩展仍正常启动，该层所有 skill 视为未提及，其他层设定照常生效

### Requirement: 禁用不修改 skill 源文件
禁用或启用 skill SHALL NOT 改动任何 skill 目录、`SKILL.md` 内容或其 frontmatter。

#### Scenario: 禁用后源文件不变
- **WHEN** 用户禁用某 skill
- **THEN** 该 skill 的 `SKILL.md` 内容与其文件系统位置保持不变
