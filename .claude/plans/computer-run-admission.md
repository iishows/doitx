# 每台 Computer 的执行准入层（P1 + P3–P6）

## 背景（已查实的现场）

`cmvz34v7900b107mmhyg0k8zv`（bot「首席调度」）在界面上显示「处理中」68 分钟无进展。实测结论：**不是死锁，是共享 Team Computer 被 4 个 run 同时抢占。**

硬证据（全部实测，非推断）：

| 事实 | 数值 | 来源 |
|---|---|---|
| 同一 computer 上的执行租约 | **4 条**（4 个不同 bot） | `computer_execution_leases`，`computerId=cmvxlp0u402qa06mmj9lqxrxb` |
| 租约唯一键 | `(computerId, botId)` | `schema.prisma` `@@unique([computerId, botId])` |
| 容器配额 | 2 CPU / 5 GiB，**MemorySwap == Memory（零 swap）** | `docker inspect`：`NanoCpus=2e9`、`Memory=MemorySwap=5368709120` |
| 容器实际负载 | 12 个 chromium 进程，anon 3.5 GB | `memory.current` 4.39 GB / 5.37 GB |
| 内存触顶 | **11201 次** | `memory.events` → `max 11201` |
| CPU 节流 | **12864 / 46514 周期 = 27.6%**，累计 7455 s | `cpu.stat` → `nr_throttled` |
| 单步耗时 | 平均 **36.4 s**，最长 324 s | `events` 中 `agent.tool.called` 相邻间隔 |
| 工具本身耗时 | 65–123 ms（**工具不慢**） | `agent.tool.completed` 的 `durationMs` |
| 泄漏的陈旧租约 | 1 条，其 run 已 `completed` | 4 条租约中 `cmvz33ef…` 状态为 completed |

**根因分两层：**

1. **租约粒度是 per-bot，不是 per-computer。** `docs/run-execution.md` 明文写着「A bot uses its computer for one run at a time」——这是**按 bot** 的保证。团队共享一台 computer（`scope=team`，4 个 bot 共享同一 `homeKey`），于是 4 个 bot 各自并发，谁都不排队。设计文档还写明「Runs that found its computer held wait **without a retry timer**」——**排队机制存在（`startNextWaitingRun`）且生效，但只在同一 bot 内生效**。
2. **容器资源配置本身是坏的。** `MemorySwap = Memory` 意味着 swap 区为 0，`computer-spec.ts` 的注释明确警告这是「Chromium goes to disk with nowhere to page」的配置。

另：运行镜像是 `ghcr.io/iishows/doitx/computer:v0.3.10`，而 swap 修复 `e407e0603` 在该发布**之后**，故容器未含修复。

**结论：这是设计问题**——准入粒度选错了（per-bot 而非 per-computer），且缺少过载保护与停滞看门狗。

---

## 目标

在**不改动现有 per-bot 排队语义**的前提下，补一层 **per-computer 准入**，并把可配置项做成**每台 computer 可单独覆盖**：

- 我读过 `Computer` model：**目前没有任何 JSON/settings 列**，所以「每台可覆盖」形态上必须新增一列（不是 env）。
- 解析优先级：`computer.maxRunsPerComputer`（单台覆盖）→ `RAKAZO_MAX_RUNS_PER_COMPUTER`（实例默认）→ `1`（内置默认）。

---

## P1（核心）— per-computer 准入闸门 + 每台可覆盖

### 1.1 DB：新增可空列

`packages/db/prisma/schema.prisma` 的 `model Computer` 末尾加：

```prisma
  /// Per-computer concurrency ceiling for executing runs. Null = inherit the
  /// instance default (RAKAZO_MAX_RUNS_PER_COMPUTER, else 1).
  maxRunsPerComputer Int?
```

- 迁移目录 `packages/db/prisma/migrations/`，命名沿用现有 `<YYYYMMDDHHMMSS>_<snake>` 风格，最近一个是 `20261106120000_bot_browser_proxy`。新目录例：`20261107120000_computer_max_runs`，内容为 `ALTER TABLE "computers" ADD COLUMN "maxRunsPerComputer" INTEGER;`（可空、无默认，无需回填）。
- 迁移后需跑 prisma generate / 构建（`packages/db` 的 package.json 脚本）。

### 1.2 设置解析（新函数，落在 `packages/db/src/computers.ts`）

```ts
export function resolveMaxRunsPerComputer(
  computer: { maxRunsPerComputer: number | null },
  envDefault: number | undefined,
): number
```

规则：`computer.maxRunsPerComputer ?? envDefault ?? 1`，并 clamp 到 `>= 1`（0/负数视为 1，避免把 computer 永久锁死）。

- 新增读取函数 `getComputerConcurrency(prisma, computerId)`，与既有 `ensureComputerRecord` 同风格（注意这些函数收 **tenant-scoped client**，需按现有约定传客户端）。
- 新增写入函数 `setComputerMaxRuns(prisma, computerId, value: number | null)`，`null` 表示「清空覆盖、回退到实例默认」。

### 1.3 闸门：改 `acquireComputerExecutionLease`

`packages/adapters/src/computer-lifecycle.ts:815`。现逻辑是 upsert `(computerId, botId)` 的租约。**只在「本 bot 尚无租约、需要新建」这条路径上加闸**：

1. 事务内先取 computer 上的 `maxRunsPerComputer`。
2. `count` 该 computer 上**未过期**的租约行数（`expiresAt > now()`）——已有 `@@index([computerId, expiresAt])`，直接可用。
3. 若 `count >= limit` **且** `(computerId, botId)` 无现有租约 → 返回「busy」信号（不要抛异常、不要写行）。
4. 已持有租约的 bot 走原路径续期，**不受闸门影响**（否则会把运行中的 run 自己挤掉）。

返回类型需扩展成可判别联合，例如 `{ ok: true; lease } | { ok: false; reason: "computer-busy" }`。**这是破坏性签名变更**，三个调用点都要改：
- `packages/adapters/src/executor.ts:314`
- `apps/api/src/routes/computer.ts:843`、`:989`
- `apps/api/src/taught-skills.ts:119`

每处按各自上下文决定 busy 时行为（executor 走停车；API 路由返回可读错误）。

### 1.4 排队：复用现有停车原语

executor 拿到 `computer-busy` 时，调用**已有**的：

```ts
await requeueComputerRun(deps, runId, workerId, fence, resumeCheckpoint, false, /* untilReleased */ true);
```

`run-lifecycle.ts:291`。`untilReleased=true` 会写 `wakeAt: null` 且**不入队**（无重试定时器）——正是 `docs/run-execution.md` 描述的「wait without a retry timer」语义。

### 1.5 唤醒：**必须新增 computer 维度的唤醒（关键设计缺口）**

现状（`run-lifecycle.ts:160`）：`startNextWaitingRun(deps, botId, releasedBy)` **只按 `botId` 找下一个 queued run**，唯一调用点在 `executor.ts:1773`（释放租约之后）。

**问题：** 跨 bot 准入下，bot A 释放 computer 后，等待中的是 **bot B/C/D** 的 run——按 `botId` 唤醒永远唤不到它们，**队列会饿死**。

修复：新增

```ts
export async function startNextWaitingRunForComputer(
  deps: ExecutorDeps,
  computerId: string,
  releasedBy: string,
): Promise<void>
```

实现要点：按 `computerId` 反查该 computer 上所有 bot，跨 bot 挑**最早**的 `status:"queued"` 且 `(wakeAt 为 null 或已到)` 的 run，`enqueue(runContinueJob(id))`。在 `executor.ts:1773` 释放点，**两个都调**（先 bot 维度，再 computer 维度），因为 per-bot 顺序保证仍要保留。

> 这里要顺带修一个既有小缺陷：`startNextWaitingRun` 用 `orderBy: [{ createdAt: "asc" }, { id: "asc" }]`，跨 bot 时同样要按 `createdAt` 保证 FIFO 公平，避免某个 bot 长期抢占。

### 1.6 覆盖项的读写入口（UI 现状已查实）

**UI 现状（已查实）：** 界面在 **`apps/mobile`（Expo / React Native）**，不是 apps/desktop（那个是 Electron 主进程，无 UI）。已存在：
- `apps/mobile/app/computer.tsx`（856 行，**Team Computer 屏**，已有 botId 上下文）
- `apps/mobile/components/computer-maintenance-actions.tsx`（已有 `rpc("computer/stop", { botId })` 之类 mutation，是现成的最佳模板）
- `apps/mobile/components/settings-group.tsx` + `apps/mobile/app/(settings)/*` 是设置面的行组件与屏

**寻址约束（关键）：** 契约里所有 `computer.*` 条目**都以 `botId` 寻址**（`packages/contracts/src/rpc.ts:633` 起，computer 由 bot 反查），**没有** `computerId` 参数，也**没有**「computer 列表」型 RPC。RPC 路径是斜杠形式（`"computer/status"`）。

这带来一个设计后果：既然 UI 是「从某个 bot 进入、看到它所在的 computer」，那么按 `botId` 寻址是自然且一致的——**沿用它，不要新造 computerId 寻址**。一台 team computer 被多个 bot 共享，但任一 bot 都能解析到同一台 computer，故写同一个值，不会歧义。

- **契约**：`packages/contracts/src/rpc.ts` 的 `computer` 块（`:633`）加一条，如 `"computer/max-runs"`，input `{ botId, maxRunsPerComputer: number | null }`（`null` = 清空覆盖，回退实例默认），output 回传生效值 + 是否有覆盖。照抄同块现有条目的 Zod 风格。
- **路由**：`apps/api/src/routes/computer.ts` 加 handler，照现有 mutation handler（`:843` / `:989`）的鉴权 + 租户作用域写法；由 `botId` 解析 computer 后写 `maxRunsPerComputer`。
- **UI**：在 `apps/mobile/app/computer.tsx` 的维护区（`ComputerMaintenanceActions` 所在区域）加一个数字输入行，复用 `settings-group.tsx` 的行样式，mutation 后 refetch `computer/status`。`ComputerStatusSchema` 需新增 `maxRunsPerComputer`（生效值）与 `maxRunsPerComputerOverride`（是否有单台覆盖）两个字段，UI 才能显示「当前生效 N / 覆盖中」。

---

## P3 / P4 — 停滞看门狗（双阈值）

**为什么需要：** 本次 run 每步都「成功」（工具 65–123 ms、无异常），但**61 次不同命令、零产出**，累积 68 分钟。现有 loop guard 只抓「连续 6 次**相同**工具调用」，对这种「反复试错不收敛」完全无感。

**双阈值（按你的选择）：**

1. **单步 > 5 min** → 抓「某一步永久 hang」。
2. **30 min 无新产出** → 抓「慢性停滞」。

**信号来源：** `agent.tool.completed` 事件的 `createdAt`（权威、已落库）。「产出」定义为：出现 `thread.message.created`、或工具产出发生实质变化（新文件/新 payload），而非任何事件。

**动作（按你的选择）：** 落回 `queued` 并写 `error`，交给 `startNextWaitingRun*` 接手——**不直接判 fail**（保留可恢复性）。落在 `job-reconciler.ts` 的既有 tick 循环里（该文件已有 `reconcileComputerRuns` 等一组 reconciliation，`apps/worker/src/index.ts` 注册）。

新增：`packages/db/src/` 加 `findStalledRuns(prisma, {stepMs, idleMs})`；`packages/adapters/src/job-reconciler.ts` 加一个 reconcile 项。

---

## P5 — 完整资源感知准入（按你的选择）

**现状（已查实）：** 仓库里**没有任何**读取 computer 容器 cgroup/CPU/内存的代码。`SandboxProvider`（`packages/adapter-kit/src/interfaces.ts:97`）只暴露 `billsWhileRunning?(computer): boolean` 之类，无 metrics。

**可行链路（已核实网络与挂载）：**
- worker `172.24.0.3` 与 supervisor `172.24.0.4` **同在 `rakazo-desktop_app` 网络** → worker 可直接 HTTP 到 supervisor。
- supervisor 是 **Hono** 服务（`infra/sandboxes/supervisor/src/index.ts`，现仅 `GET /health` 回 `{ok, image}`），且**挂着 `/var/run/docker.sock`** → 可用 dockerode 直读目标 computer 容器 stats。

**实现三步：**

1. **supervisor 新增指标端点**：`GET /computers/:id/pressure`，用 dockerode 读该容器的 cgroup：`memory.current` / `memory.max` / `cpu.stat` 的 `nr_throttled`÷`nr_periods`。返回 `{ memRatio, throttledRatio, oomEvents }`。
2. **`SandboxProvider` 扩一个可选方法** `observePressure?(computer): Promise<Pressure | null>`，由 `boat-sandbox.ts` 实现（打 supervisor 端点），`host-aware-sandbox.ts` 做路由转发（它已是转发层，`billsWhileRunning` 就是范例）。可选方法 + `?.()` 调用，保证其他 sandbox 实现（daytona/createos/railway/remote-desktop）**不受影响**。
3. **准入闸门接入**：在 P1 的闸门处叠加压力判定——`throttledRatio > 0.2` 或 `memRatio > 0.9` 时**收紧上限**（有效上限降到 `max(1, count-1)` 或直接拒绝新 run，取决于是「已过载」还是「接近过载」）。压力读取失败一律**回退到 P1 的静态上限**（fail-open，不能因指标不可达而卡死所有 run）。

---

## P6 — 泄漏租约回收（按你的选择：周期 + 启动一次性清理）

**现状：** 表内已有 1 条泄漏行（run 已 `completed` 但租约还在）。现有 `expireComputerExecutionLeases`（`packages/db/src/computers.ts:188`）是把 `expiresAt` 置为 `new Date(0)` 的**墓碑式**过期，不是删行。

1. **周期 sweep**：在 `packages/adapters/src/job-reconciler.ts` 加一项，清理两类行：(a) 所属 run 已处终态（completed/failed/cancelled）的租约；(b) `expiresAt` 已长期过期的行。删除用 `deleteMany`，并**同时清空** `computers` 上对应的 `executionRunId/executionBotId/executionFence/executionLeaseExpiresAt`（这些列在本案中已现 `executionRunId` 空值 + `executionFence=0` 的不一致状态，说明写入路径不完整——sweep 要负责收敛）。
2. **启动一次性清理**：worker 启动时跑一次同一清理函数，处理现存积压。

---

## 验收（必须实跑，不能只跑单测）

1. **单测**：租约闸门（第 N+1 个 bot 被拒、已持有租约者可续期）、`resolveMaxRunsPerComputer` 优先级与 clamp、`startNextWaitingRunForComputer` 跨 bot FIFO、停滞双阈值、sweep 清理两类行。沿用现有 `computer-lifecycle.test.ts` / `computer-runs.postgres.test.ts` / `boat-sandbox.test-support.ts` 的测试风格。
2. **端到端**：起本栈，让 4 个 bot 同时触发 → 断言 `computer_execution_leases` 上该 computer **未过期行数 ≤ limit**，其余 run 处于 `queued` + `wakeAt=null`；释放后**其他 bot** 的 run 能被唤醒（验证 1.5 不饿死）。
3. **回归**：`docs/run-execution.md` 承诺的 per-bot 排队语义不变；三个 `acquireComputerExecutionLease` 调用点行为各自正确。
4. **P5 专项**：人工把某容器压到节流 > 20%，断言新 run 被拒且**指标不可达时 fail-open**。
5. 迁移在**已存在 4 条租约的现存库**上可重入执行（不给现存行写脏值）。

---

## 已解决：UI 落点

**UI 已查实**（见 §1.6）：界面在 `apps/mobile`（Expo），既有 Team Computer 屏 `apps/mobile/app/computer.tsx`，可直接在其维护区加一个数字输入行，无需新建面板。

**唯一遗留的小事项**：UI 用 i18n（`apps/mobile/lib/locales/{zh,zh-TW,de,ja,nl,ru}.ts`），新增标签需在这 6 个语言文件里补 key，否则会显示 key 原文。这是纯文案工作，不阻塞主体实现。

---

## 实现顺序建议

1. **P6**（最小、最独立）→ 2. **P1**（核心，含 1.5 的跨 bot 唤醒缺口）→ 3. **P4** → 4. **P5**（最大，跨 3 个包）→ 5. **P1.6 UI**。
   理由：P6/P1 直接消除过载根因，P5 收益建立在 P1 已把并发压到 1 的基础上，UI 最后补。

---

## 不在本次范围

- 把 `MemorySwap` 修好（即 `e407e0603` 的修复）需要**重建 computer 镜像并 rollout**，属于发布动作，不是代码改动。本方案把并发压到 1 后过载已结构性缓解；镜像更新单独走发布流程。
- 本次**不改** per-bot 排队语义、不改 `@@unique([computerId, botId])` 约束（跨 bot 准入在上层闸门实现，不动 DB 唯一键，避免破坏现有续期路径）。
