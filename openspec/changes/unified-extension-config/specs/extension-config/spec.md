# Spec Delta

## Purpose

让本包所有扩展的配置集中在一个文件里，并给出一套统一的读取、合并与写入规则：扩展不必各自决定路径和合并语义，用户也不必记住扩展名到目录名到合并规则的映射。

## ADDED Requirements

### Requirement: 全局配置集中存放

所有扩展的用户级配置 SHALL 位于同一文件 `<agentDir>/extensions/pi-kit/config.json`，分区的键 SHALL 等于该扩展在 `extensions/` 下的目录名。扩展 MUST NOT 再各自维护独立的全局配置文件。

#### Scenario: 按扩展目录名读取分区

- **WHEN** 扩展 `codegraph` 读取自己的配置
- **THEN** 它取得 `codegraph` 分区的内容

#### Scenario: 文件内出现未知分区

- **WHEN** 配置文件含一个不对应任何已加载扩展的分区
- **THEN** 该分区被忽略，其他分区的读取不受影响

### Requirement: 项目级配置与全局配置同构

系统 SHALL 从 `<cwd>/.pi/extensions/pi-kit/config.json` 读取项目级配置，其分区结构与全局文件相同。文件不存在时 MUST 视为项目层没有任何设定。

#### Scenario: 项目文件存在

- **WHEN** 当前工作目录下存在项目级配置文件且含 `codegraph` 分区
- **THEN** 该分区参与合并

#### Scenario: 项目文件不存在

- **WHEN** 当前工作目录下没有项目级配置文件
- **THEN** 生效配置完全由全局层决定，且不产生错误提示

### Requirement: 两级合并语义

合并 SHALL 在分区内逐键深合并，项目层覆盖全局层；数组 SHALL 整体替换而不是逐项合并；项目层未提及的键 MUST 保留全局层的值。

#### Scenario: 项目层覆盖单个键

- **WHEN** 全局 `codegraph.inject` 为 `"auto"`，项目层写 `"inject": "always"`
- **THEN** 生效值为 `"always"`

#### Scenario: 项目层未提及的键保留全局值

- **WHEN** 全局 `codegraph` 有 `extraTools` 与 `inject`，项目层只写 `inject`
- **THEN** 生效的 `extraTools` 仍是全局层的值

#### Scenario: 数组整体替换

- **WHEN** 全局 `codegraph.extraTools` 为 `["node"]`，项目层写 `["impact"]`
- **THEN** 生效值为 `["impact"]`，不包含 `node`

### Requirement: 分区显式声明项目级可覆盖的键

每个分区 SHALL 显式声明允许项目层覆盖的键；未声明的键 MUST 只取全局层的值，即使项目文件里写了也不生效。

#### Scenario: 已声明的键可被项目层覆盖

- **WHEN** `codegraph` 分区声明 `extraTools` 可被项目层覆盖，项目文件写了新的 `extraTools`
- **THEN** 生效值来自项目层

#### Scenario: 未声明的键被项目层忽略

- **WHEN** 某个键未被该分区声明为可覆盖，项目文件写了该键
- **THEN** 生效值仍来自全局层，项目层的值不生效

### Requirement: 连接身份类配置只来自全局层

`deepseek-web` 分区的 `apiKey` 与 `baseURL` MUST NOT 接受项目层覆盖，取值只来自全局配置文件。

#### Scenario: 恶意项目配置无法改道端点

- **WHEN** 一个已受信任项目的配置文件写了 `deepseek-web.baseURL` 指向第三方地址
- **THEN** 生效的 `baseURL` 仍是全局层的值，`apiKey` 不会被发往第三方地址

### Requirement: 项目级配置仅在项目受信任时读取

项目级配置文件 SHALL 仅在当前项目受信任时被读取；项目未受信任时 MUST 完全忽略该文件，生效配置只由全局层决定。

#### Scenario: 未受信任的项目

- **WHEN** 项目未受信任，且其项目配置文件改动了允许覆盖的键
- **THEN** 该改动不生效，生效配置等同只有全局层

### Requirement: 配置缺失或损坏时按段降级

配置文件不存在时 MUST 视为没有任何设定并继续正常工作。整个文件无法解析为 JSON 对象时 SHALL 让所有分区回落到默认值且不阻止扩展加载；单个分区类型不符时 SHALL 只让该分区回落，其他分区照常生效。

#### Scenario: 整个文件不是合法 JSON

- **WHEN** 配置文件内容不是合法 JSON
- **THEN** 所有扩展以各自默认值启动，运行中不抛错

#### Scenario: 单个分区类型错误

- **WHEN** 文件整体合法，但 `codegraph` 分区的值不是对象
- **THEN** `codegraph` 使用默认值，`deepseek-web` 等分区仍读到自己的设定

### Requirement: 共享层不对分区内容做字段校验

共享层 SHALL 把分区内容原样交给对应扩展，MUST NOT 校验或删除分区内的字段名与取值类型。字段级校验由各扩展自行负责。

#### Scenario: 分区内含共享层不认识的键

- **WHEN** 某分区出现一个共享层未声明的键
- **THEN** 该键原样出现在交给扩展的对象里

### Requirement: 写入只影响目标分区且保持原子性

写回 SHALL 先读取文件当前内容，只改动目标分区的目标键，保留其他分区与其他键。写入 SHALL 通过临时文件替换完成，MUST NOT 让读取方看到写了一半的文件。

#### Scenario: 只改自己的分区

- **WHEN** `skill-manager` 写入一个 skill 开关
- **THEN** 文件中 `deepseek-web` 分区的 `apiKey` 与其他内容保持不变

#### Scenario: 目标分区尚不存在

- **WHEN** 写回时目标分区在文件里不存在
- **THEN** 该分区被创建，文件内其他内容保持不变

### Requirement: 配置变更无需重启会话

扩展读取配置时 SHALL 反映磁盘上的当前内容，配置改动 MUST NOT 要求用户重启会话或执行 `/reload` 才生效。

#### Scenario: 运行中改动配置

- **WHEN** 用户在会话进行中修改全局配置文件
- **THEN** 该扩展下一次读取配置时拿到新值
