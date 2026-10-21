# Tasks

## 1. 共享配置模块

- [ ] 1.1 新建 `extensions/_shared/kit-config.ts`，定义路径解析（`<agentDir>/extensions/pi-kit/config.json`、`<cwd>/.pi/extensions/pi-kit/config.json`）与分区白名单表；`node --test "extensions/_shared/*.test.mts"` 通过路径用例
- [ ] 1.2 实现两级读取与深合并（分区内逐键递归、项目覆盖全局、数组整体替换）；单测覆盖「覆盖单键」「项目未提及的键保留全局值」「数组替换不并集」三种情形并全部通过
- [ ] 1.3 实现项目级覆盖白名单过滤与信任门禁（`trusted` 由调用方传入）；单测覆盖「未声明键被项目层忽略」「`trusted: false` 时项目层完全不生效」「项目层写 `deepseek-web.baseURL` 不生效」三条
- [ ] 1.4 实现按段隔离降级；单测覆盖「整文件非 JSON 对象时全部回落」「单分区非对象只影响该分区」「分区内未声明键原样交给扩展」三条
- [ ] 1.5 实现原子写回（读-改-写、只动目标分区、临时文件 `rename` 覆盖）；单测覆盖「写入后其他分区不变」「目标分区不存在时被创建」两条
- [ ] 1.6 在 `AGENTS.md` 写明 `_shared/` 的加载约束（目录内不得有 `index.ts` 或带 `pi` 字段的 `package.json`；`extensions/` 下的裸 `.ts` 文件会被当扩展加载），并用 pi loader 加载本包确认扩展数量仍为 17、`_shared` 未被当作扩展

## 2. deepseek-web 接入

- [ ] 2.1 `extensions/deepseek-web/config.ts` 改为从共享模块取 `deepseek-web` 分区，保留 `baseURL` 形状校验与默认值；`node --test "extensions/deepseek-web/*.test.mts"` 通过
- [ ] 2.2 删除 `extensions/deepseek-web/index.ts` 顶部注释里写死的旧路径，改为指向 `kit-config.ts`；全文 `rg "extensions/deepseek-web/config.json" extensions/` 无命中
- [ ] 2.3 更新 `extensions/deepseek-web/README.md` 的配置路径与「`apiKey` 只从全局层读、项目层写也不生效」说明，并核对文中路径与代码常量一致

## 3. subdir-context 接入

- [ ] 3.1 删除 `extensions/subdir-context/index.ts` 自有的 `configPaths` 与读文件逻辑，改读共享模块的 `subdir-context` 分区，并在读取时传入 `ctx.isProjectTrusted()`；手动在会话中 `read` 一个位于 `extraRoots` 声明目录下的文件，确认 AGENTS.md 被注入
- [ ] 3.2 更新 `extensions/subdir-context/README.md`：配置路径改为 `pi-kit`，并写明 `extraRoots` 由「全局与项目并集」改为「项目替换全局」属于破坏性变更

## 4. codegraph 接入

- [ ] 4.1 删除 `extensions/codegraph/index.ts` 的 `CONFIG_REL_PATH` 与 `loadCgConfig`，改读共享模块的 `codegraph` 分区；`rg "pi-codegraph/config.json" extensions/codegraph/index.ts` 无命中
- [ ] 4.2 更新 `extensions/codegraph/smoke.mjs` 里 5 处写配置的路径（全局与项目两处）为 `pi-kit/config.json`，并让脚本按分区写入；`node extensions/codegraph/smoke.mjs` 全部用例通过
- [ ] 4.3 更新 `extensions/codegraph/README.md`、`docs/adr/0003-fine-grained-tools-opt-in.md`、`../../skills/codegraph/SKILL.md` 三处配置路径；`rg "pi-codegraph/config\.json" extensions skills` 无命中

## 5. skill-manager 接入

- [ ] 5.1 `extensions/skill-manager/scope.ts` 把配置路径改成指向 `pi-kit/config.json` 的 `skill-manager` 分区，同时把 `usage.jsonl` 用的目录常量与配置目录常量拆开（前者保持 `pi-skills`）；`node --test "extensions/skill-manager/*.test.mts"` 通过，且 `usageLogPath` 仍指向 `extensions/pi-skills/usage.jsonl`
- [ ] 5.2 `writeSetting` 改为调用共享模块的原子写回，只改 `skill-manager` 分区；单测断言写入后同文件内 `deepseek-web` 分区内容不变
- [ ] 5.3 更新 `extensions/skill-manager/README.md` 的路径说明，并写明配置 key 是 `skill-manager`、数据目录仍是 `pi-skills` 的映射关系

## 6. auto-prepend 接入

- [ ] 6.1 删除 `extensions/auto-prepend/index.ts` 里的 `CONFIG_FILE` 与其自有解析，改读共享模块的 `auto-prepend` 分区；在全新状态下启动会话确认取到默认值且不报错
- [ ] 6.2 `/auto-prepend init` 改为 upsert 自己的分区；执行后检查 `pi-kit/config.json` 出现 `auto-prepend` 分区且其他分区内容不变
- [ ] 6.3 更新 `extensions/auto-prepend/README.md` 的配置路径与命令说明，核对文中路径与代码常量一致

## 7. 本机配置迁移

- [ ] 7.1 把 `~/.pi/agent/extensions/deepseek-web/config.json`、`~/.pi/agent/extensions/pi-skills/config.json`、`~/.pi/agent/auto-prepend.json` 备份到 `.tmp/unified-extension-config-backup/`；确认三份备份存在且字节数与源文件一致
- [ ] 7.2 合成 `~/.pi/agent/extensions/pi-kit/config.json`，含 `deepseek-web`、`subdir-context`、`codegraph`、`skill-manager`、`auto-prepend` 五个分区；`node -e "JSON.parse(require('fs').readFileSync(路径))"` 通过，且 `deepseek-web.apiKey` 与备份值逐字符相等
- [ ] 7.3 删除三份旧配置文件与空的 `~/.pi/agent/extensions/deepseek-web/` 目录；`ls ~/.pi/agent/extensions/pi-skills/` 仍能看到 `usage.jsonl`，`ls ~/.pi/agent/auto-prepend.json` 报不存在
- [ ] 7.4 重启会话，逐项手测五个扩展：`web_search` 可用、`extraRoots` 注入生效、`codegraph_explore` 可用、`/skills` 显示的开关与配置一致、`/auto-prepend` 状态为禁用；把结果逐条记录在验证说明里

## 8. 集成验收与仓库文档

- [ ] 8.1 在仓库根执行 `npm test`，全部测试通过
- [ ] 8.2 用 pi 自己的 loader 批量加载 `extensions/*/index.ts`，`result.errors` 为空且 `result.extensions.length` 为 17
- [ ] 8.3 执行 `npm pack --dry-run`，确认 `extensions/_shared/kit-config.ts` 在包内、`extensions/**/*.test.mts` 不在包内
- [ ] 8.4 更新 `AGENTS.md`「数据目录」段与根 `README.md` 的扩展表行，写明统一配置路径、`skill-manager` ↔ `pi-skills` 的映射、以及 `_shared/` 不得有 `index.ts` 的约束
- [ ] 8.5 执行 `openspec validate unified-extension-config --strict`，校验通过

## Workflow follow-up

- 实现完成并通过评审后归档本 change。
- 归档后确认 `openspec/specs/skill-management/spec.md` 里的路径已被 delta 替换为 `pi-kit`，`extension-config` 主 spec 已生成。
