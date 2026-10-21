# Spec Delta

## MODIFIED Requirements

### Requirement: 项目级开关写入项目配置
带 `--project` 的开关 SHALL 把状态写入 `<cwd>/.pi/extensions/pi-kit/config.json` 的 `skill-manager` 分区，且 MUST NOT 改动该文件内其他分区的内容。

#### Scenario: 项目级禁用
- **WHEN** 用户执行 `/skills disable xlsx --project`
- **THEN** 项目配置文件的 `skill-manager` 分区中把 xlsx 记为禁用，且该状态对之后在本项目启动的会话生效

#### Scenario: 写入不影响其他扩展的分区
- **WHEN** 项目配置文件里同时存在 `codegraph` 分区，用户执行 `/skills disable xlsx --project`
- **THEN** `codegraph` 分区的内容保持不变

### Requirement: 全局级开关写入全局配置
带 `--global` 的开关 SHALL 把状态写入 `<agentDir>/extensions/pi-kit/config.json` 的 `skill-manager` 分区，且 MUST NOT 改动该文件内其他分区的内容。

#### Scenario: 全局级禁用
- **WHEN** 用户执行 `/skills disable xlsx --global`
- **THEN** 全局配置文件的 `skill-manager` 分区中把 xlsx 记为禁用，且该状态对之后在任何项目启动的会话生效

#### Scenario: 写入不影响其他扩展的分区
- **WHEN** 全局配置文件里同时存在 `deepseek-web` 分区，用户执行 `/skills disable xlsx --global`
- **THEN** `deepseek-web` 分区的内容保持不变
