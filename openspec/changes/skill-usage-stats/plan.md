# skill-usage-stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/skills stats` 按五个滚动窗口展示本机上每个 skill 的实际调用次数与最后使用时间，采集靠两个通知型事件钩子实时写入本机日志。

**Architecture:** 新增纯逻辑模块 `usage.ts` 承担全部可测逻辑（事件序列化、路径归一化、容错读取、窗口聚合、pending 表、显式调用判定、分段），`index.ts` 只负责注册钩子和命令分支。日志是 append-only 的 JSONL，与既有 `config.json` 同目录。read 通道用 `tool_execution_start` + `tool_execution_end` 配对，只有 `durationMs !== undefined && isError === false` 才提交。

**Tech Stack:** TypeScript（Node 24 原生跑 `.ts`/`.mts`）、`node:test` + `node:assert/strict`、pi 扩展 API（`@earendil-works/pi-coding-agent`）。

**Spec:**
- `openspec/changes/skill-usage-stats/specs/skill-usage-tracking/spec.md`（新能力，10 条 requirement）
- `openspec/changes/skill-usage-stats/specs/skill-management/spec.md`（delta，命令参数补全）
- `openspec/changes/skill-usage-stats/design.md`（决策 D1–D8 与风险）

**Requirements:** 命令参数补全、Skill 调用记录、路径归一化、统计从安装起算不回填历史、统计起点在输出中可辨识、按滚动窗口聚合、统计表以日志为主轴分三段、最后使用时间、统计输出不进入模型上下文、日志缺失或损坏时降级为空记录、采集不改变会话行为

## Global Constraints

- 窗口固定为 72 / 168 / 720 / 2160 / 4320 小时，标签依次为 `3天`、`7天`、`1月`、`3月`、`半年`；各窗口为**累积**统计。
- 日志路径：`path.join(agentDir, "extensions", "pi-skills", "usage.jsonl")`，append-only。
- 日志行字段固定为 `ts` / `via` / `path` / `session` / `cwd`；`via` 取值只有 `"read"` 与 `"explicit"`。
- 记录前必须归一化路径：`\` → `/`，相对转绝对（用当时的 cwd），**不碰大小写**。
- 只处理以 `/SKILL.md` 结尾的 read 调用。
- read 通道提交判据：`durationMs !== undefined && isError === false`。
- 钩子 handler 四条纪律：**不 await I/O、不外抛（整个 body 包 try/catch）、不修改 event、先判类型再取字段**。
- `usage.ts` 与 `render.ts` 只依赖 node 标准库，**不 import pi 运行时**，保证 `node --test` 可跑；需要 pi 能力的部分（`parseSkillBlock`、`getAgentDir`）通过参数注入或留在 `index.ts`。
- 所有输出只走 `ctx.ui.notify`，绝不调 `pi.sendMessage()`。
- 注释与文档用中文；代码标识符与测试名可用中文描述词。

## Review Focus

1. 日志写入失败（文件被占用、磁盘满、权限不足）时，工具调用与用户输入必须照常完成 —— 采集绝不能成为失败源。
2. 模型给出相对路径（如 `skills/foo/SKILL.md`）时，必须与同一文件的绝对写法归一为同一条目，否则该 skill 会在表里裂成两行。
3. 读取失败的 SKILL.md（`ENOENT`，本机实测占 1.5%）不得计入 —— 那是「模型想用但没读到」，不是一次使用。
4. 日志末行被截断或含坏行时，跳过坏行后其余记录仍要完整统计，且不报错。
5. 日志存在但不足 180 天时，输出必须明示覆盖不完整，不能让用户把窗口里的 0 读成「从未使用」。

---

### Task 1: 日志事件类型与序列化

**OpenSpec task:** 1.1

**Files:**
- Create: `pi/extensions/skill-manager/usage.ts`
- Create: `pi/extensions/skill-manager/usage.test.mts`

**Interfaces:**
- Consumes: 无
- Produces: `UsageVia`、`UsageEvent`、`serializeEvent(event: UsageEvent): string`、`parseEvent(line: string): UsageEvent | undefined`、`usageLogPath(agentDir: string): string`

- [ ] **Step 1: 写失败测试**

```ts
// usage.test.mts
import assert from "node:assert/strict";
import test from "node:test";
import { parseEvent, serializeEvent, usageLogPath } from "./usage.ts";

test("serializeEvent 产出单行 JSON 且以换行结尾", () => {
	const event = { ts: "2026-10-13T03:17:29.722Z", via: "read" as const, path: "/a/b/SKILL.md", session: "s1", cwd: "/a" };
	const line = serializeEvent(event);
	assert.equal(line.endsWith("\n"), true);
	assert.equal(line.trimEnd().includes("\n"), false);
	assert.deepEqual(parseEvent(line.trimEnd()), event);
});

test("parseEvent 对坏输入返回 undefined", () => {
	assert.equal(parseEvent("not json"), undefined);
	assert.equal(parseEvent('{"ts":"x"}'), undefined);
	assert.equal(parseEvent('{"ts":"x","via":"bogus","path":"p","session":"s","cwd":"c"}'), undefined);
});

test("usageLogPath 指向 extensions/pi-skills/usage.jsonl", () => {
	assert.equal(usageLogPath("/agent"), path.join("/agent", "extensions", "pi-skills", "usage.jsonl"));
});
```

（顶部补 `import path from "node:path";`）

- [ ] **Step 2: 运行确认失败**

Run: `node --test pi/extensions/skill-manager/usage.test.mts`
Expected: FAIL —— 找不到模块 `./usage.ts`

- [ ] **Step 3: 实现**

在 `usage.ts` 定义：`UsageVia = "read" | "explicit"`；`UsageEvent { ts: string; via: UsageVia; path: string; session: string; cwd: string }`；`serializeEvent` 返回 `JSON.stringify(event) + "\n"`；`parseEvent` 用 try/catch 解析并逐字段校验（`via` 必须在两个字面量内、其余四个字段必须是非空字符串），任一不合法返回 `undefined`；`usageLogPath` 用 `path.join(agentDir, "extensions", "pi-skills", "usage.jsonl")`。

文件头写模块注释，说明本模块不 import pi 运行时。

- [ ] **Step 4: 运行确认通过**

Run: `node --test pi/extensions/skill-manager/usage.test.mts`
Expected: PASS（3 个测试）

- [ ] **Step 5: 提交并回写 checkbox**

编辑 `openspec/changes/skill-usage-stats/tasks.md`，把 `- [ ] 1.1` 改成 `- [x] 1.1`。

```bash
git add pi/extensions/skill-manager/usage.ts pi/extensions/skill-manager/usage.test.mts openspec/changes/skill-usage-stats/tasks.md
git commit -m "feat(skill-manager): 新增用量日志事件类型与序列化"
```

---

### Task 2: 路径归一化

**OpenSpec task:** 1.2

**Files:**
- Modify: `pi/extensions/skill-manager/usage.ts`
- Modify: `pi/extensions/skill-manager/usage.test.mts`

**Interfaces:**
- Consumes: Task 1 的 `usage.ts`
- Produces: `isSkillFile(rawPath: string): boolean`、`normalizeSkillPath(rawPath: string, cwd: string): string`、`skillNameOf(normalizedPath: string): string`

**覆盖 Review Focus #2。**

- [ ] **Step 1: 写失败测试**

```ts
test("isSkillFile 只认以 /SKILL.md 结尾的路径", () => {
	assert.equal(isSkillFile("D:\\a\\b\\SKILL.md"), true);
	assert.equal(isSkillFile("skills/foo/SKILL.md"), true);
	assert.equal(isSkillFile("skills/foo/skill.md"), false);
	assert.equal(isSkillFile("skills/foo/README.md"), false);
	assert.equal(isSkillFile("SKILL.md"), false);
});

test("normalizeSkillPath 把相对与反斜杠写法归一到同一结果", () => {
	const abs = "D:/code/skills/skills/foo/SKILL.md";
	assert.equal(normalizeSkillPath("D:\\code\\skills\\skills\\foo\\SKILL.md", "D:/code"), abs);
	assert.equal(normalizeSkillPath("skills/foo/SKILL.md", "D:/code/skills"), abs);
	assert.equal(normalizeSkillPath("./skills/foo/SKILL.md", "D:/code/skills"), abs);
	assert.equal(normalizeSkillPath(abs, "D:/elsewhere"), abs);
});

test("normalizeSkillPath 不碰大小写", () => {
	assert.equal(normalizeSkillPath("D:/Code/Foo/SKILL.md", "D:/x"), "D:/Code/Foo/SKILL.md");
});

test("skillNameOf 取父目录名", () => {
	assert.equal(skillNameOf("D:/code/skills/skills/foo/SKILL.md"), "foo");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test pi/extensions/skill-manager/usage.test.mts`
Expected: FAIL —— `isSkillFile is not a function`

- [ ] **Step 3: 实现**

`isSkillFile`：先把 `\` 换成 `/`，再判 `endsWith("/SKILL.md")`。
`normalizeSkillPath`：`\` → `/`；判定是否绝对（以 `/` 开头，或第二个字符是 `:`）；相对则用 `posix.join(cwd, p)` 再 `posix.normalize`；绝对路径也走一次 `posix.normalize`。**cwd 自身也要先做 `\` → `/`**，否则 Windows 的 `D:\code` 会拼出混用分隔符的路径。**不做大小写转换。**
`skillNameOf`：按 `/` 切分后取倒数第二段。

`import path from "node:path"` 已在 Task 1 引入；这里用 `path.posix`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test pi/extensions/skill-manager/usage.test.mts`
Expected: PASS（7 个测试）

- [ ] **Step 5: 提交并回写 checkbox**

把 `- [ ] 1.2` 改成 `- [x] 1.2`。

```bash
git add pi/extensions/skill-manager/usage.ts pi/extensions/skill-manager/usage.test.mts openspec/changes/skill-usage-stats/tasks.md
git commit -m "feat(skill-manager): 日志路径归一化"
```

---

### Task 3: 日志读取与容错

**OpenSpec task:** 1.3

**Files:**
- Modify: `pi/extensions/skill-manager/usage.ts`
- Modify: `pi/extensions/skill-manager/usage.test.mts`

**Interfaces:**
- Consumes: Task 1 `UsageEvent` / `parseEvent`；Task 2 无
- Produces: `readEvents(filePath: string): UsageEvent[]`、`appendEvent(filePath: string, event: UsageEvent): void`

**覆盖 Review Focus #1、#4。**

- [ ] **Step 1: 写失败测试**

```ts
const E1 = { ts: "2026-10-13T01:00:00.000Z", via: "read" as const, path: "/a/one/SKILL.md", session: "s", cwd: "/a" } satisfies UsageEvent;
const E2 = { ts: "2026-10-13T02:00:00.000Z", via: "read" as const, path: "/a/two/SKILL.md", session: "s", cwd: "/a" } satisfies UsageEvent;
const tmpFile = (name = "log.jsonl") => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "usage-")), name);

test("readEvents 对缺失文件、空文件返回空数组", () => {
	assert.deepEqual(readEvents(tmpFile("nope.jsonl")), []);
	const empty = tmpFile("empty.jsonl");
	fs.writeFileSync(empty, "");
	assert.deepEqual(readEvents(empty), []);
});

test("readEvents 跳过坏行与末行截断，其余完整返回", () => {
	const file = tmpFile();
	fs.writeFileSync(file, [
		serializeEvent(E1).trimEnd(),
		"not json",
		serializeEvent(E2).trimEnd(),
		'{"ts":"2026-10-13T05:00:00.000Z","via":"read"',   // 末行截断，且无结尾换行
	].join("\n"));
	assert.deepEqual(readEvents(file), [E1, E2]);
});

test("appendEvent 在目录不存在时自动创建", () => {
	const file = tmpFile("nested/log.jsonl");
	assert.doesNotThrow(() => appendEvent(file, E1));
	assert.deepEqual(readEvents(file), [E1]);
});

test("appendEvent 在写入失败时不抛异常", () => {
	const file = tmpFile("as-dir.jsonl");
	fs.mkdirSync(file);
	assert.doesNotThrow(() => appendEvent(file, E1));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test pi/extensions/skill-manager/usage.test.mts`
Expected: FAIL —— `readEvents is not a function`

- [ ] **Step 3: 实现**

`readEvents`：`fs.readFileSync` 包 try/catch，失败返回 `[]`；按 `\n` 切分，逐行 `parseEvent`，`undefined` 的丢弃。
`appendEvent`：整个 body 包 try/catch（catch 里空实现，绝不外抛）；先 `fs.mkdirSync(path.dirname(filePath), { recursive: true })`，再 `fs.appendFileSync(filePath, serializeEvent(event), "utf8")`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test pi/extensions/skill-manager/usage.test.mts`
Expected: PASS（11 个测试）

- [ ] **Step 5: 提交并回写 checkbox**

把 `- [ ] 1.3` 改成 `- [x] 1.3`。

```bash
git add pi/extensions/skill-manager/usage.ts pi/extensions/skill-manager/usage.test.mts openspec/changes/skill-usage-stats/tasks.md
git commit -m "feat(skill-manager): 用量日志读取与容错"
```

---

### Task 4: 滚动窗口聚合

**OpenSpec task:** 1.4

**Files:**
- Modify: `pi/extensions/skill-manager/usage.ts`
- Modify: `pi/extensions/skill-manager/usage.test.mts`

**Interfaces:**
- Consumes: Task 1 `UsageEvent`；Task 2 `skillNameOf`
- Produces: `USAGE_WINDOWS: readonly { label: string; hours: number }[]`、`UsageStats { counts: number[]; total: number; lastUsed?: string }`、`aggregate(events: UsageEvent[], now: Date): Map<string, UsageStats>`（键为 skill 名）

- [ ] **Step 1: 写失败测试**

```ts
const NOW = new Date("2026-10-13T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();
const ev = (hoursAgo: number, name: string): UsageEvent =>
	({ ts: at(hoursAgo), via: "read", path: `D:/s/${name}/SKILL.md`, session: "s", cwd: "D:/s" });

test("USAGE_WINDOWS 是五个递增的累积窗口", () => {
	assert.deepEqual(USAGE_WINDOWS.map((w) => w.label), ["3天", "7天", "1月", "3月", "半年"]);
	assert.deepEqual(USAGE_WINDOWS.map((w) => w.hours), [72, 168, 720, 2160, 4320]);
});

test("aggregate 的窗口是累积的", () => {
	const m = aggregate([ev(10, "foo"), ev(10, "foo"), ev(10, "foo"), ev(120, "foo"), ev(120, "foo")], NOW);
	assert.deepEqual(m.get("foo")!.counts, [3, 5, 5, 5, 5]);
	assert.equal(m.get("foo")!.total, 5);
});

test("aggregate 的结果不随时间戳的时区写法变化", () => {
	const utc = ev(10, "foo");
	const shifted = { ...utc, ts: new Date(utc.ts).toISOString().replace("Z", "+08:00") };
	const a = aggregate([utc], NOW).get("foo")!.counts;
	const b = aggregate([{ ...shifted, ts: new Date(utc.ts).toISOString() }], NOW).get("foo")!.counts;
	assert.deepEqual(a, b);
});

test("aggregate 记录最后使用时间", () => {
	const m = aggregate([ev(100, "foo"), ev(5, "foo")], NOW);
	assert.equal(m.get("foo")!.lastUsed, at(5));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test pi/extensions/skill-manager/usage.test.mts`
Expected: FAIL —— `USAGE_WINDOWS is not defined`

- [ ] **Step 3: 实现**

按 `skillNameOf(event.path)` 分组；对每条事件算 `ageHours = (now - Date.parse(ts)) / 3600_000`，落在窗口内则 `counts[i]++`；`total` 累加全部事件；`lastUsed` 取最大 `ts`（按解析后的时间比较）。窗口标签与小时数用常量表，`counts` 与该表同序。

- [ ] **Step 4: 运行确认通过**

Run: `node --test pi/extensions/skill-manager/usage.test.mts`
Expected: PASS（15 个测试）

- [ ] **Step 5: 提交并回写 checkbox**

把 `- [ ] 1.4` 改成 `- [x] 1.4`。

```bash
git add pi/extensions/skill-manager/usage.ts pi/extensions/skill-manager/usage.test.mts openspec/changes/skill-usage-stats/tasks.md
git commit -m "feat(skill-manager): 滚动窗口聚合"
```

---

### Task 5: 统计起点

**OpenSpec task:** 1.5

**Files:**
- Modify: `pi/extensions/skill-manager/usage.ts`
- Modify: `pi/extensions/skill-manager/usage.test.mts`

**Interfaces:**
- Consumes: Task 1 `UsageEvent`
- Produces: `statsStart(events: UsageEvent[]): string | undefined`

- [ ] **Step 1: 写失败测试**

```ts
test("statsStart 取最早一条记录的时间", () => {
	assert.equal(statsStart([ev(100, "a"), ev(5, "b")]), at(100));
});

test("statsStart 对空日志返回 undefined", () => {
	assert.equal(statsStart([]), undefined);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test pi/extensions/skill-manager/usage.test.mts`
Expected: FAIL —— `statsStart is not a function`

- [ ] **Step 3: 实现**

遍历取 `Date.parse(ts)` 最小值对应的原始 `ts` 字符串（不重新格式化，避免丢掉原始写法）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test pi/extensions/skill-manager/usage.test.mts`
Expected: PASS（17 个测试）

- [ ] **Step 5: 提交并回写 checkbox**

把 `- [ ] 1.5` 改成 `- [x] 1.5`。

```bash
git add pi/extensions/skill-manager/usage.ts pi/extensions/skill-manager/usage.test.mts openspec/changes/skill-usage-stats/tasks.md
git commit -m "feat(skill-manager): 统计起点推导"
```

---

### Task 6: README 代码结构

**OpenSpec task:** 1.6

**Files:**
- Modify: `README.md`（「开发」一节的代码结构块）

**Interfaces:**
- Consumes: Task 1–5 建好的 `usage.ts`
- Produces: 无

- [ ] **Step 1: 更新代码结构块**

在 `render.ts` 一行之下补一行 `usage.ts   用量日志：事件序列化、路径归一化、窗口聚合`，并保持既有对齐风格。

- [ ] **Step 2: 验证命令可跑**

Run: `node --test pi/extensions/skill-manager/*.test.mts`
Expected: PASS，且 README 中写明的这条命令与实际一致（逐字比对 README 里的命令与本次执行结果）

- [ ] **Step 3: 提交并回写 checkbox**

把 `- [ ] 1.6` 改成 `- [x] 1.6`。

```bash
git add README.md openspec/changes/skill-usage-stats/tasks.md
git commit -m "docs: README 代码结构补充 usage.ts"
```

---

### Task 7: pending 表与提交判定

**OpenSpec task:** 2.1

**Files:**
- Modify: `pi/extensions/skill-manager/usage.ts`
- Modify: `pi/extensions/skill-manager/usage.test.mts`

**Interfaces:**
- Consumes: 无
- Produces: `ReadEnd { durationMs?: number; isError: boolean }`、`shouldCommitRead(end: ReadEnd): boolean`、`class PendingReads { record(toolCallId, skillPath): void; take(toolCallId): string | undefined; clear(): void; get size(): number }`

**覆盖 Review Focus #3。**

- [ ] **Step 1: 写失败测试**

```ts
test("shouldCommitRead 只在真的执行且没出错时为真", () => {
	assert.equal(shouldCommitRead({ durationMs: 3, isError: false }), true);
	assert.equal(shouldCommitRead({ durationMs: 3, isError: true }), false);
	assert.equal(shouldCommitRead({ isError: false }), false);          // 被 block / 未执行
	assert.equal(shouldCommitRead({ isError: true }), false);
});

test("PendingReads 取出即删除，重复取返回 undefined", () => {
	const p = new PendingReads();
	p.record("c1", "D:/s/foo/SKILL.md");
	assert.equal(p.size, 1);
	assert.equal(p.take("c1"), "D:/s/foo/SKILL.md");
	assert.equal(p.take("c1"), undefined);
	assert.equal(p.size, 0);
});

test("PendingReads clear 清空全部", () => {
	const p = new PendingReads();
	p.record("c1", "a"); p.record("c2", "b");
	p.clear();
	assert.equal(p.size, 0);
	assert.equal(p.take("c1"), undefined);
});

test("take 未记录过的 id 返回 undefined", () => {
	assert.equal(new PendingReads().take("nope"), undefined);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test pi/extensions/skill-manager/usage.test.mts`
Expected: FAIL —— `PendingReads is not a constructor`

- [ ] **Step 3: 实现**

`shouldCommitRead`：`end.durationMs !== undefined && end.isError === false`。
`PendingReads`：内部 `Map<string, string>`，`size` 用 getter 返回 `map.size`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test pi/extensions/skill-manager/usage.test.mts`
Expected: PASS（21 个测试）

- [ ] **Step 5: 提交并回写 checkbox**

把 `- [ ] 2.1` 改成 `- [x] 2.1`。

```bash
git add pi/extensions/skill-manager/usage.ts pi/extensions/skill-manager/usage.test.mts openspec/changes/skill-usage-stats/tasks.md
git commit -m "feat(skill-manager): read 通道 pending 表与提交判定"
```

---

### Task 8: read 通道的两个钩子

**OpenSpec task:** 2.2

**Files:**
- Modify: `pi/extensions/skill-manager/index.ts`

**Interfaces:**
- Consumes: Task 1–5 的 `usage.ts` 导出（`isSkillFile` / `normalizeSkillPath` / `appendEvent` / `usageLogPath` / `UsageEvent`）；Task 7 的 `PendingReads` / `shouldCommitRead`；pi 的 `getAgentDir`
- Produces: 无（副作用：日志出现 `via: "read"` 记录）

- [ ] **Step 1: 注册钩子**

在 `index.ts` 顶部从 `usage.ts` 引入，模块级建一个 `const pendingReads = new PendingReads()`。

`tool_execution_start`：先判 `event.toolName !== "read"` 直接 return；取 `(event.args as { path?: unknown } | undefined)?.path`，非字符串 return；`isSkillFile` 不通过 return；`pendingReads.record(event.toolCallId, normalizeSkillPath(raw, ctx.cwd))`。

`tool_execution_end`：`const skillPath = pendingReads.take(event.toolCallId); if (!skillPath) return;` `if (!shouldCommitRead({ durationMs: event.durationMs, isError: event.isError })) return;` 然后 `appendEvent(usageLogPath(getAgentDir()), { ts: new Date().toISOString(), via: "read", path: skillPath, session: ctx.sessionManager.getSessionId(), cwd: ctx.cwd })`。

两个 handler 的整个 body 包 try/catch，catch 内空实现。**不 await 任何 I/O。**

- [ ] **Step 2: 验证写入一条 read 记录**

Run: 在 pi 里让模型读取任一 SKILL.md（例如「读一下 D:/code/skills/skills/retrospective/SKILL.md」），然后

```bash
tail -3 "$(node -e 'console.log(require("os").homedir())')/.pi/agent/extensions/pi-skills/usage.jsonl"
```

Expected: 出现一条 `"via":"read"` 记录，`path` 为绝对路径且分隔符为 `/`，`ts` 为 ISO UTC

- [ ] **Step 3: 验证不误记非 skill 读取**

让模型读取一个非 SKILL.md 文件（如前一步同一目录下的 `README.md`），再 `tail -1` 同一文件。

Expected: 日志条数不变

- [ ] **Step 4: 提交并回写 checkbox**

把 `- [ ] 2.2` 改成 `- [x] 2.2`。

```bash
git add pi/extensions/skill-manager/index.ts openspec/changes/skill-usage-stats/tasks.md
git commit -m "feat(skill-manager): read 通道采集钩子"
```

---

### Task 9: agent_end 清理 pending 表

**OpenSpec task:** 2.3

**Files:**
- Modify: `pi/extensions/skill-manager/index.ts`

**Interfaces:**
- Consumes: Task 7 `PendingReads.clear`；Task 8 的 `pendingReads` 实例
- Produces: 无

- [ ] **Step 1: 注册清理钩子**

`pi.on("agent_end", () => pendingReads.clear())`，body 包 try/catch。

- [ ] **Step 2: 验证不残留**

用 Task 7 的 `size` 断言覆盖（已存在）。运行时验证：连续发三轮让模型读不同 SKILL.md，每轮结束后 `pendingReads.size` 归零 —— 通过在 `index.ts` 的 `agent_end` handler 里临时 `console.error(pendingReads.size)` 观察后移除。

Expected: 每轮输出 `0`

- [ ] **Step 3: 提交并回写 checkbox**

把 `- [ ] 2.3` 改成 `- [x] 2.3`。

```bash
git add pi/extensions/skill-manager/index.ts openspec/changes/skill-usage-stats/tasks.md
git commit -m "feat(skill-manager): agent_end 清空 pending 表"
```

---

### Task 10: 显式调用判定的纯函数

**OpenSpec task:** 3.1

**Files:**
- Modify: `pi/extensions/skill-manager/usage.ts`
- Modify: `pi/extensions/skill-manager/usage.test.mts`

**Interfaces:**
- Consumes: Task 2 `normalizeSkillPath`
- Produces: `explicitSkillPath(message: { role?: unknown; content?: unknown }, parse: (text: string) => { location?: unknown } | null, cwd: string): string | undefined`

**注入 `parse` 而不是 import pi**，这样 `usage.ts` 保持纯净可测。

- [ ] **Step 1: 写失败测试**

```ts
const fakeParse = (text: string) =>
	text.startsWith("<skill ") ? { location: "D:/s/foo/SKILL.md" } : null;

test("explicitSkillPath 从 user 消息里取 location 并归一化", () => {
	const msg = { role: "user", content: [{ type: "text", text: "<skill name=\"foo\" location=\"D:/s/foo/SKILL.md\">…</skill>" }] };
	assert.equal(explicitSkillPath(msg, fakeParse, "D:/elsewhere"), "D:/s/foo/SKILL.md");
});

test("explicitSkillPath 对非 user 消息返回 undefined", () => {
	assert.equal(explicitSkillPath({ role: "assistant", content: [{ type: "text", text: "<skill …" }] }, fakeParse, "D:/s"), undefined);
});

test("explicitSkillPath 的消息里没有 skill 块时返回 undefined", () => {
	assert.equal(explicitSkillPath({ role: "user", content: [{ type: "text", text: "普通消息" }] }, fakeParse, "D:/s"), undefined);
});

test("explicitSkillPath 对解析失败、content 非数组、location 缺失都返回 undefined", () => {
	assert.equal(explicitSkillPath({ role: "user", content: "字符串" }, fakeParse, "D:/s"), undefined);
	assert.equal(explicitSkillPath({ role: "user", content: [{ type: "text", text: "<skill " }] }, () => null, "D:/s"), undefined);
	assert.equal(explicitSkillPath({ role: "user", content: [{ type: "text", text: "<skill " }] }, () => ({}), "D:/s"), undefined);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test pi/extensions/skill-manager/usage.test.mts`
Expected: FAIL —— `explicitSkillPath is not a function`

- [ ] **Step 3: 实现**

先判 `message.role === "user"` 且 `Array.isArray(message.content)`；遍历元素，取 `typeof block?.text === "string"` 的文本交给 `parse`；`parse` 返回 null 或 `location` 非字符串则跳过；命中第一个就 `normalizeSkillPath(location, cwd)` 返回。

- [ ] **Step 4: 运行确认通过**

Run: `node --test pi/extensions/skill-manager/usage.test.mts`
Expected: PASS（25 个测试）

- [ ] **Step 5: 提交并回写 checkbox**

把 `- [ ] 3.1` 改成 `- [x] 3.1`。

```bash
git add pi/extensions/skill-manager/usage.ts pi/extensions/skill-manager/usage.test.mts openspec/changes/skill-usage-stats/tasks.md
git commit -m "feat(skill-manager): 显式调用判定纯函数"
```

---

### Task 11: message_start 钩子

**OpenSpec task:** 3.2

**Files:**
- Modify: `pi/extensions/skill-manager/index.ts`

**Interfaces:**
- Consumes: Task 10 `explicitSkillPath`；Task 1 `appendEvent` / `usageLogPath`；pi 的 `parseSkillBlock`、`getAgentDir`
- Produces: 无（副作用：日志出现 `via: "explicit"` 记录）

**这是 design「三个未验证假设」里最大的一个**：`message_start` 是否真的带展开后的文本。本任务第 2 步就是验它。

- [ ] **Step 1: 注册钩子**

从 pi 引入 `parseSkillBlock`，在 `index.ts` 注册 `message_start`：`const path = explicitSkillPath(event.message, parseSkillBlock, ctx.cwd); if (!path) return;` 然后与 Task 8 同样的 `appendEvent(...)`，`via` 用 `"explicit"`。body 包 try/catch，不 await。

- [ ] **Step 2: 验证显式通道生效**

Run: 在会话里执行 `/skill:retrospective`，然后

```bash
tail -1 ~/.pi/agent/extensions/pi-skills/usage.jsonl
```

Expected: 出现一条 `"via":"explicit"` 且 `path` 指向 retrospective 的 SKILL.md。
**若没有新记录**：假设为假，停止本任务并报告 —— 按 design D3 的降级路径改挂 `input` 事件（需要额外校验 skill 名存在性），不要自行决定。

- [ ] **Step 3: 验证普通消息不产生记录**

发一条普通消息（如「你好」），再 `tail -1`。

Expected: 日志不变

- [ ] **Step 4: 提交并回写 checkbox**

把 `- [ ] 3.2` 改成 `- [x] 3.2`。

```bash
git add pi/extensions/skill-manager/index.ts openspec/changes/skill-usage-stats/tasks.md
git commit -m "feat(skill-manager): 显式调用采集钩子"
```

---

### Task 12: 统计表渲染主体

**OpenSpec task:** 4.1

**Files:**
- Modify: `pi/extensions/skill-manager/render.ts`
- Modify: `pi/extensions/skill-manager/render.test.mts`
- Modify: `pi/extensions/skill-manager/usage.ts`
- Modify: `pi/extensions/skill-manager/usage.test.mts`

**Interfaces:**
- Consumes: Task 4 `USAGE_WINDOWS` / `UsageStats`；Task 2 `normalizeSkillPath` / `skillNameOf`
- Produces:
  - `usage.ts`：`StatsInput { loaded: StatsEntry[]; unloaded: StatsEntry[]; unrecorded: string[] }`、`StatsEntry { name: string; counts: number[]; lastUsed?: string }`、`buildStats(events: UsageEvent[], loadedSkills: Array<{ name: string; filePath: string }>, now: Date): StatsInput`
  - `render.ts`：`renderStats(input: StatsInput, options: { start?: string; now: Date; nameWidth?: number }): string`

- [ ] **Step 1: 写失败测试（usage.ts 侧）**

```ts
test("buildStats 按 path 归一后把记录分到三段", () => {
	const loaded = [{ name: "foo", filePath: "D:/s/foo/SKILL.md" }, { name: "bar", filePath: "D:/s/bar/SKILL.md" }];
	const events = [ev(5, "foo"), ev(5, "ghost")];
	const input = buildStats(events, loaded, NOW);
	assert.deepEqual(input.loaded.map((e) => e.name), ["foo"]);
	assert.deepEqual(input.unloaded.map((e) => e.name), ["ghost"]);
	assert.deepEqual(input.unrecorded, ["bar"]);
});

test("buildStats 按 name 聚合不同来源的同名 skill", () => {
	const events = [ev(5, "foo"), { ...ev(5, "foo"), path: "D:/other/foo/SKILL.md" }];
	const input = buildStats(events, [], NOW);
	assert.equal(input.unloaded.length, 1);
	assert.equal(input.unloaded[0]!.counts[4], 2);
});

test("buildStats 按半年次数降序、同名按名排", () => {
	const events = [ev(5, "b"), ev(5, "a"), ev(5, "a")];
	assert.deepEqual(buildStats(events, [], NOW).unloaded.map((e) => e.name), ["a", "b"]);
});

test("buildStats 在空日志时把全部已加载放进 unrecorded 并保持原名序", () => {
	const loaded = [{ name: "z", filePath: "D:/s/z/SKILL.md" }, { name: "a", filePath: "D:/s/a/SKILL.md" }];
	const input = buildStats([], loaded, NOW);
	assert.deepEqual(input.unrecorded, ["a", "z"]);
	assert.deepEqual(input.loaded, []);
	assert.deepEqual(input.unloaded, []);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test pi/extensions/skill-manager/usage.test.mts`
Expected: FAIL —— `buildStats is not a function`

- [ ] **Step 3: 实现 buildStats**

先用 `aggregate` 得到 `Map<dirname, UsageStats>`（键已经是目录名）。**匹配键统一用 SKILL.md 的父目录名**：事件侧由 `aggregate` 保证，已加载侧用 `skillNameOf(normalizeSkillPath(skill.filePath, ""))`——两侧同源，不依赖 pi 的 `name` 字段与目录名一致。某个有记录的键出现在已加载目录名集合里就归 `loaded`，否则归 `unloaded`；`unrecorded` = 已加载里没出现在聚合表中的 skill，按显示名升序。**显示名**：`loaded` 段用已加载 skill 的 `name`，`unloaded` 段没有 pi 的名字，用目录名。有记录的两段都按 `counts[4]` 降序、同值按显示名升序。

- [ ] **Step 4: 写失败测试（render.ts 侧）**

```ts
const STATS_FIXTURE: StatsInput = {
	loaded: [{ name: "foo", counts: [1, 1, 1, 1, 1], lastUsed: at(2) }],
	unloaded: [{ name: "ghost", counts: [0, 0, 0, 0, 1], lastUsed: at(24 * 100) }],
	unrecorded: ["bar"],
};

/** 表头里「3天」的起始显示列。 */
const firstCol = (header: string) => displayWidth(header.slice(0, header.indexOf("3天")));

test("renderStats 输出三段标题与表头列", () => {
	const out = renderStats(STATS_FIXTURE, { now: NOW, start: at(24 * 200) });
	assert.match(out, /当前加载/);
	assert.match(out, /当前未加载/);
	assert.match(out, /当前加载但无记录/);
	assert.match(out, /3天\s+7天\s+1月\s+3月\s+半年/);
	assert.match(out, /最后使用/);
});

test("renderStats 的数字列与表头同列对齐", () => {
	const lines = renderStats(STATS_FIXTURE, { now: NOW, start: at(24 * 200) }).split("\n");
	const header = lines.find((l) => l.includes("3天"))!;
	assert.equal(cellAt(lines.find((l) => l.includes("foo"))!, firstCol(header), 3).trim(), "1");
	assert.equal(cellAt(lines.find((l) => l.includes("ghost"))!, firstCol(header), 3).trim(), "0");
});
```

（`render.test.mts` 已有 `cellAt`；本任务还需从 `render.ts` 导入 `displayWidth`、`renderStats`，从 `usage.ts` 导入 `StatsInput` 类型，并沿用 Task 4 测试里的 `NOW` / `at()` 写法。）

- [ ] **Step 5: 运行确认失败**

Run: `node --test pi/extensions/skill-manager/render.test.mts`
Expected: FAIL —— `renderStats is not a function`

- [ ] **Step 6: 实现 renderStats**

复用 `render.ts` 现有的 `pad` / `truncate` / `displayWidth`。列：名称（按最长名称对齐，`nameWidth` 可覆盖，超出用 `truncate`）+ 五个右对齐数字列 + 最后使用列。数字列宽度取该列最大显示宽度与表头宽度的较大者。三段各有标题行，段内无行时整段跳过。`unrecorded` 段按名称列表输出为一行（用 `、` 连接）。

最后使用格式：0 天为 `今天`，1 天为 `昨天`，< 30 天为 `<n>天前`，否则为 `<n>个月前`（不足一月按一月）。

- [ ] **Step 7: 运行确认通过**

Run: `node --test pi/extensions/skill-manager/*.test.mts`
Expected: PASS（usage 29 个 + render 新增若干，加总无 fail）

- [ ] **Step 8: 提交并回写 checkbox**

把 `- [ ] 4.1` 改成 `- [x] 4.1`。

```bash
git add pi/extensions/skill-manager/usage.ts pi/extensions/skill-manager/usage.test.mts pi/extensions/skill-manager/render.ts pi/extensions/skill-manager/render.test.mts openspec/changes/skill-usage-stats/tasks.md
git commit -m "feat(skill-manager): 统计表数据组装与渲染"
```

---

### Task 13: 统计表边界情形

**OpenSpec task:** 4.2

**Files:**
- Modify: `pi/extensions/skill-manager/render.test.mts`
- Modify: `pi/extensions/skill-manager/render.ts`（若测试暴露缺陷）

**Interfaces:**
- Consumes: Task 12 `renderStats` / `StatsInput`
- Produces: 无（补齐边界覆盖）

- [ ] **Step 1: 写边界测试**

```ts
test("renderStats 空日志时三段只剩无记录段且不报错", () => {
	const out = renderStats(buildStats([], [{ name: "a", filePath: "D:/s/a/SKILL.md" }], NOW), { now: NOW });
	assert.doesNotMatch(out, /当前加载\b/);
	assert.match(out, /当前加载但无记录/);
	assert.match(out, /a/);
});

test("renderStats 幽灵超过一屏时不截断、不报错", () => {
	const unloaded = Array.from({ length: 60 }, (_, i) => ({
		name: `g${String(i).padStart(2, "0")}`,
		counts: [0, 0, 0, 0, 1],
		lastUsed: at(24 * 10),
	}));
	const out = renderStats({ loaded: [], unloaded, unrecorded: [] }, { now: NOW });
	for (const e of unloaded) assert.equal(out.includes(e.name), true);
	assert.equal(out.split("\n").length >= 62, true);   // 段标题 + 表头 + 60 行
});

test("renderStats 对超长 skill 名截断且保持列对齐", () => {
	const long = { name: "x".repeat(60), counts: [0, 0, 0, 0, 3], lastUsed: at(24 * 10) };
	const lines = renderStats({ loaded: [], unloaded: [long], unrecorded: [] }, { now: NOW, nameWidth: 20 }).split("\n");
	const header = lines.find((l) => l.includes("3天"))!;
	const row = lines.find((l) => l.includes("x"))!;
	const col = (label: string) => displayWidth(header.slice(0, header.indexOf(label)));
	assert.equal(cellAt(row, col("3天"), 3).trim(), "0");
	assert.equal(cellAt(row, col("半年"), 3).trim(), "3");
});

test("renderStats 在全部段为空时返回一行提示而非崩溃", () => {
	assert.equal(typeof renderStats({ loaded: [], unloaded: [], unrecorded: [] }, { now: NOW }), "string");
});
```

- [ ] **Step 2: 运行**

Run: `node --test pi/extensions/skill-manager/render.test.mts`
Expected: 若失败，按 Step 3 修 `render.ts`；通过则跳到 Step 4

- [ ] **Step 3: 修复暴露的缺陷**

只改 `render.ts` 里与边界相关的分支（空段、超宽名称截断、纯空输入）。不要顺手重构无关逻辑。

- [ ] **Step 4: 运行确认全部通过**

Run: `node --test pi/extensions/skill-manager/*.test.mts`
Expected: PASS 且 `fail 0`

- [ ] **Step 5: 提交并回写 checkbox**

把 `- [ ] 4.2` 改成 `- [x] 4.2`。

```bash
git add pi/extensions/skill-manager/render.ts pi/extensions/skill-manager/render.test.mts openspec/changes/skill-usage-stats/tasks.md
git commit -m "test(skill-manager): 统计表边界覆盖"
```

---

### Task 14: 统计起点标注与不完整提示

**OpenSpec task:** 4.3

**Files:**
- Modify: `pi/extensions/skill-manager/render.ts`
- Modify: `pi/extensions/skill-manager/render.test.mts`

**Interfaces:**
- Consumes: Task 12 `renderStats`；Task 5 `statsStart`
- Produces: `renderStats` 的尾部标注（`start` 缺省时不输出该行）

**覆盖 Review Focus #5。**

- [ ] **Step 1: 写失败测试**

```ts
test("renderStats 有统计起点时标注，且不足半年时提示不完整", () => {
	const out = renderStats(input, { now: NOW, start: at(24 * 30) });   // 30 天前
	assert.match(out, /统计自/);
	assert.match(out, /不足 180 天|覆盖不完整/);
});

test("renderStats 起点超过半年时不提示不完整", () => {
	const out = renderStats(input, { now: NOW, start: at(24 * 200) });
	assert.match(out, /统计自/);
	assert.doesNotMatch(out, /不完整/);
});

test("renderStats 无统计起点时不输出标注行", () => {
	assert.doesNotMatch(renderStats(input, { now: NOW }), /统计自/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test pi/extensions/skill-manager/render.test.mts`
Expected: FAIL —— 未出现「统计自」

- [ ] **Step 3: 实现**

表尾追加一行：`统计自 <本地可读时间> 起`；当 `now - start < 4320 小时` 时在同一条里补 `（不足半年，半年窗口覆盖不完整）`。时间用 `toISOString().slice(0, 16).replace("T", " ")` 形式，避免引入时区依赖。

- [ ] **Step 4: 运行确认通过**

Run: `node --test pi/extensions/skill-manager/*.test.mts`
Expected: PASS 且 `fail 0`

- [ ] **Step 5: 提交并回写 checkbox**

把 `- [ ] 4.3` 改成 `- [x] 4.3`。

```bash
git add pi/extensions/skill-manager/render.ts pi/extensions/skill-manager/render.test.mts openspec/changes/skill-usage-stats/tasks.md
git commit -m "feat(skill-manager): 统计起点标注与覆盖提示"
```

---

### Task 15: /skills stats 分支

**OpenSpec task:** 5.1

**Files:**
- Modify: `pi/extensions/skill-manager/index.ts`

**Interfaces:**
- Consumes: Task 12 `buildStats` / `renderStats`；Task 1 `readEvents` / `usageLogPath`；Task 5 `statsStart`；现有 `readSkills` / `refreshSkillNames`
- Produces: `/skills stats` 可执行

- [ ] **Step 1: 接分支**

在 `handler` 里、`disable`/`enable` 分支之后加：`if (action === "stats") { ... }`。内部：读日志 `readEvents(usageLogPath(getAgentDir()))`；取 `skillsOf(ctx)`，调 `refreshSkillNames(known)`；`buildStats(events, known.map((s) => ({ name: s.name, filePath: s.filePath })), new Date())`；`ctx.ui.notify(renderStats(input, { now: new Date(), start: statsStart(events) }), "info")`。

整段包 try/catch，失败时 `ctx.ui.notify("统计读取失败。", "warning")`。**只走 notify，不调 `pi.sendMessage()`。**

- [ ] **Step 2: 验证输出与上下文**

Run: 执行 `/skills stats`

Expected: 终端出现三段统计表；随后检查会话记录（`~/.pi/agent/sessions/--D--code-pi-skills--/<最新>.jsonl`）不新增消息条目

- [ ] **Step 3: 验证无日志文件的降级**

Run: 把 `usage.jsonl` 临时改名后执行 `/skills stats`，再改回

Expected: 输出「当前加载但无记录」一段，不报错

- [ ] **Step 4: 提交并回写 checkbox**

把 `- [ ] 5.1` 改成 `- [x] 5.1`。

```bash
git add pi/extensions/skill-manager/index.ts openspec/changes/skill-usage-stats/tasks.md
git commit -m "feat(skill-manager): /skills stats 子命令"
```

---

### Task 16: 补全加入 stats

**OpenSpec task:** 5.2

**Files:**
- Modify: `pi/extensions/skill-manager/complete.ts`
- Modify: `pi/extensions/skill-manager/complete.test.mts`

**Interfaces:**
- Consumes: 现有 `ACTIONS` / `ACTION_DESCRIPTIONS` / `completionsFor`
- Produces: `completionsFor("st", [])` 返回 `stats`

- [ ] **Step 1: 改测试**

把 `complete.test.mts` 里断言 `["list", "disable", "enable"]` 的那条改为 `["list", "disable", "enable", "stats"]`，并新增：

```ts
test("补全 stats 子命令", () => {
	assert.deepEqual(completionsFor("st", SKILLS).map((i) => i.value), ["stats"]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test pi/extensions/skill-manager/complete.test.mts`
Expected: FAIL —— 实际候选里没有 `stats`

- [ ] **Step 3: 实现**

`ACTIONS` 加上 `"stats"`（放在数组末尾），`ACTION_DESCRIPTIONS` 加 `stats: "查看 skill 用量统计"`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test pi/extensions/skill-manager/*.test.mts`
Expected: PASS 且 `fail 0`

- [ ] **Step 5: 提交并回写 checkbox**

把 `- [ ] 5.2` 改成 `- [x] 5.2`。

```bash
git add pi/extensions/skill-manager/complete.ts pi/extensions/skill-manager/complete.test.mts openspec/changes/skill-usage-stats/tasks.md
git commit -m "feat(skill-manager): 补全支持 stats 子命令"
```

---

### Task 17: README 命令表与行为边界

**OpenSpec task:** 5.3

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 15 的 `/skills stats`；design 的统计起点约定
- Produces: 无

- [ ] **Step 1: 更新 README**

命令代码块加一行 `/skills stats` 及说明；「行为边界」一节补两条：统计从本机日志起算、不回填安装前的历史；日志位置 `<agentDir>/extensions/pi-skills/usage.jsonl`。

- [ ] **Step 2: 逐条核对**

Run: 打开 README，对照 `pi/extensions/skill-manager/index.ts` 的 handler 分支

Expected: README 里出现的每条命令都能在代码里找到对应分支；命令参数写法与代码一致

- [ ] **Step 3: 提交并回写 checkbox**

把 `- [ ] 5.3` 改成 `- [x] 5.3`。

```bash
git add README.md openspec/changes/skill-usage-stats/tasks.md
git commit -m "docs: README 补充 /skills stats 与统计起点说明"
```

---

### Task 18: loader 加载验证

**OpenSpec task:** 5.4

**Files:**
- 无（只验证）

**Interfaces:**
- Consumes: Task 8 / 11 / 15 / 16 改完的扩展入口
- Produces: 无

- [ ] **Step 1: 用 pi 自己的 loader 批量加载**

```bash
node --input-type=module -e "
const { loadExtensions } = await import('file://C:/Users/liuxi/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js');
const r = await loadExtensions(['file:///D:/code/pi-skills/pi/extensions/skill-manager/index.ts']);
console.log(JSON.stringify(r.errors, null, 2));
"
```

Expected: `[]`（空数组）

- [ ] **Step 2: 提交并回写 checkbox**

把 `- [ ] 5.4` 改成 `- [x] 5.4`。

```bash
git add openspec/changes/skill-usage-stats/tasks.md
git commit -m "chore: 验证扩展在 pi loader 下零加载错误"
```

---

### Task 19: 端到端计数

**OpenSpec task:** 6.1

**Files:**
- 无（只验证）

**Interfaces:**
- Consumes: 全部前述实现
- Produces: 无

- [ ] **Step 1: 清空后跑两条通道**

把 `usage.jsonl` 改名为 `usage.jsonl.bak`，重启会话；让模型读一次某个 SKILL.md；再执行一次 `/skill:<同一个 skill>`。

- [ ] **Step 2: 核对计数**

Run: `/skills stats`

Expected: 该 skill 的五个窗口计数均为 `2`（两条通道各一条，按 name 聚合后为 2）；最后使用为「今天」。

**若显示为 1**：说明只有一条通道生效（read 或 explicit 其中一个），停止并报告是哪一个——不要自行改采集代码。

- [ ] **Step 3: 提交并回写 checkbox**

把 `- [ ] 6.1` 改成 `- [x] 6.1`。

```bash
git add openspec/changes/skill-usage-stats/tasks.md
git commit -m "chore: 端到端验证两条通道计数"
```

---

### Task 20: /tree 分支不重放

**OpenSpec task:** 6.2

**Files:**
- 无（只验证）

**Interfaces:**
- Consumes: Task 11 的 `message_start` 钩子
- Produces: 无

- [ ] **Step 1: 记基线**

`wc -l < ~/.pi/agent/extensions/pi-skills/usage.jsonl`

- [ ] **Step 2: 切换一次分支**

用 `/tree` 切到另一个分支（或恢复一个含历史条目的会话）。

- [ ] **Step 3: 比对**

Run: `wc -l < ~/.pi/agent/extensions/pi-skills/usage.jsonl`

Expected: 条数不变。**若增加**：说明走的是 design Risks 表里第二行的失效路径，停止并报告，按 D1 重新评估去重策略，不要自行加去重代码。

- [ ] **Step 4: 提交并回写 checkbox**

把 `- [ ] 6.2` 改成 `- [x] 6.2`。

```bash
git add openspec/changes/skill-usage-stats/tasks.md
git commit -m "chore: 验证分支切换不重放 message_start"
```

---

### Task 21: 子会话 cwd 与 session

**OpenSpec task:** 6.3

**Files:**
- 无（只验证）

**Interfaces:**
- Consumes: Task 8 / 11 的钩子
- Produces: 无

- [ ] **Step 1: 跑一个子代理**

让子代理读一次某个 SKILL.md（例如通过 `subagent` 工具派一个「读 X 并总结」的任务）。

- [ ] **Step 2: 检查写入的 session 与 cwd**

Run: `tail -3 ~/.pi/agent/extensions/pi-skills/usage.jsonl`

Expected: 子代理产生的记录里 `session` 与父会话不同，且 `cwd` 是该子代理的工作目录。**若相同**：走 design Risks 表第三行的失效路径，停止并报告。

- [ ] **Step 3: 提交并回写 checkbox**

把 `- [ ] 6.3` 改成 `- [x] 6.3`。

```bash
git add openspec/changes/skill-usage-stats/tasks.md
git commit -m "chore: 验证子会话写入自己的 session 与 cwd"
```

---

### Task 22: 损坏日志的容错

**OpenSpec task:** 6.4

**Files:**
- 无（只验证）

**Interfaces:**
- Consumes: Task 3 `readEvents`、Task 15 的 stats 分支
- Produces: 无

- [ ] **Step 1: 制造损坏**

备份 `usage.jsonl` 后，把内容替换为 `{"broken"`。

- [ ] **Step 2: 验证降级**

Run: `/skills stats` 与 `/skills`

Expected: `stats` 按「全部无记录」输出，不报错；`/skills` 的清单与开关行为完全正常

- [ ] **Step 3: 恢复备份**

把备份改回 `usage.jsonl`，确认 `/skills stats` 恢复正常数据。

- [ ] **Step 4: 提交并回写 checkbox**

把 `- [ ] 6.4` 改成 `- [x] 6.4`。

```bash
git add openspec/changes/skill-usage-stats/tasks.md
git commit -m "chore: 验证损坏日志的降级行为"
```

---

## Workflow follow-up

- 全部任务完成后，重跑 `openspec instructions apply --change "skill-usage-stats"` 比对进度与 checkbox，已完成却未勾选的补上。
- 交接到 `superpowers:finishing-a-development-branch` 做合并。
- 交接到 `/opsx-archive` 归档，并把增量规格合并进主规格。
