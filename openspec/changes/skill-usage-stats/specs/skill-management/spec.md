# Spec Delta

## MODIFIED Requirements

### Requirement: 命令参数补全
`/skills` SHALL 按已输入内容分三级给出补全候选：子命令、skill 名、作用域 flag。

#### Scenario: 补全子命令
- **WHEN** 用户输入 `/skills ` 或 `/skills d`
- **THEN** 候选列出 list、disable、enable、stats 中匹配已输入前缀的项

#### Scenario: 补全 skill 名
- **WHEN** 用户补全 `/skills disable <前缀>`
- **THEN** 候选列出名称匹配的已加载 skill，选中后该段参数变为 `disable <name>`

#### Scenario: 补全作用域 flag
- **WHEN** 用户补全 `/skills disable <name> <前缀>`
- **THEN** 候选列出 `--project` 与 `--global`，选中后该段参数变为 `disable <name> <flag>`

#### Scenario: 补全 stats 子命令
- **WHEN** 用户输入 `/skills st`
- **THEN** 候选中包含 `stats`，选中后该段参数变为 `stats`

#### Scenario: 没有匹配项
- **WHEN** 已输入内容与任何候选都不匹配
- **THEN** 不显示候选，也不报错
