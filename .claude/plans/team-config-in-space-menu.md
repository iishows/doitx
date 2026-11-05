# 把工作区配置导出/导入移到工作区二级菜单

## 目标

1. 工作区（space）二级菜单新增 **「导出工作区配置」**：点击**直接下载** zip，无需中间面板。
2. 导入功能也一并迁到该二级菜单：点 **「导入工作区配置」** 打开**专用对话框**（选文件 → 预览勾选 → 确认）。
3. 从 `SpaceSettingsPanel` 中**整组移除** "Workspace configuration"（即 `<TeamConfigSettings />`），面板其余部分（重命名、删除、其他分组）保持不变。
4. **修正作用域 bug**：导出/导入都作用于**菜单对应的那个工作区**，而非当前选中的工作区。

## 背景（已核实）

- 二级菜单位于 `apps/web/src/pages/shell/shell-dialogs.tsx:159-211`（`DropdownMenu` + `DropdownMenuItem`，含 "Settings" 与 "Delete space"）。`spaceMenuTarget` 在 `:156` 由 `spaces.find(...)` 得出。
- `ShellDialogs` 已接收 `spaces` / `spaceMenu` / `setSpaceMenu` / `openSpaceSettings` / `setDeleteSpaceTarget`（`:107-124`），`Shell.tsx:1054` 渲染它。
- `TeamConfigSettings.tsx` 目前用**全局 `rpc`**（`:10` import、`:37/:60/:78` 调用），**不是** `useSpaceRpc()` —— 所以从别的工作区的设置面板导出会错误导出当前选中工作区。需改为 `rpcForSpace(menuSpace.id)`（`lib/rpc.ts:173`，按 spaceId 缓存）。
- 导出 token 在服务端绑定 `context.actor.spaceId`（`apps/api/src/routes/content.ts:259`），scoped client 会用 header 覆盖，故**前端改动即可，无需改 API**。
- `useIdentityConfirmation()` 返回 `{ withIdentityConfirmation, identityDialog }`（`ConfirmIdentityDialog.tsx:200-225`）—— 需要把 `identityDialog` 渲染出来，确认框才会出现。`isIdentityConfirmationRequired` 来自 `@rakazo/contracts`。
- toast 从 `@rakazo/ui-web` 导入（`import { toast } from "@rakazo/ui-web"`）。

## 文件改动

### 1. 新增 `apps/web/src/components/useTeamConfigTransfer.ts`

抽出共享逻辑，避免菜单项与对话框重复：

- `downloadTeamConfig(spaceId)`：`withIdentityConfirmation(() => rpcForSpace(spaceId).export.teamConfigToken())` → 建 `<a href="/api/team-config/export?token=…" download="">` 并 click。返回 `{ ok }` 或抛错。
- 预留给导入对话框复用的 `previewTeamConfig(spaceId, files)` / `createTeamConfig(spaceId, files, selection)` 包装，均走 `rpcForSpace`。

> 注：确认框需要一个挂载点。菜单项本身不做身份确认（见下），改由**导出时**在 Shell 层触发；若实现复杂，退而求其次：导出菜单项直接下载、把身份确认保留在服务端 401 流程。**实现时优先核对**是否可让 `Shell.tsx` 持有一个 `useIdentityConfirmation` 并把 `download` 回调经 `ShellDialogs` 传入。

### 2. 新增 `apps/web/src/pages/shell/ImportWorkspaceDialog.tsx`

仿照既有对话框范式（如 `DeleteBotDialog`）：

- 隐藏 `<input type="file">`（**必须挂在对话框内、非 dropdown 内**，避免下拉关闭导致卸载）。
- 选中文件 → `openAgentImportArchive`（`@rakazo/core`）→ `rpcForSpace(spaceId).export.teamConfigPreview({ files })`。
- 渲染 bot 清单，**默认全选**，可取消勾选（沿用 `TeamConfigSettings` 现有清单交互）。
- 确认 → `teamConfigCreate({ files, selection: { keys } })` → 成功 toast。
- props：`{ spaceId, open, onClose, onDone }`。

### 3. `apps/web/src/pages/shell/shell-dialogs.tsx`

在 `DropdownMenuContent` 内、"Settings" 之后、"Delete space" 之前插入两项：

- **「导出工作区配置」** —— `<Download />` 图标；`onClick` 关闭菜单后调用 `onExportSpace(spaceMenuTarget.id)`（由 `Shell.tsx` 注入的回调）。
- **「导入工作区配置」** —— `<Upload />` 图标；`onClick` 关闭菜单并 `setImportSpaceTarget(spaceMenuTarget)`。

新增 props：`onExportSpace: (spaceId: string) => void`、`setImportSpaceTarget`。并渲染 `ImportWorkspaceDialog`（target 非空时）。

### 4. `apps/web/src/pages/Shell.tsx`

- 加 `importTarget` 状态与 `openImportDialog`。
- 持有 `useIdentityConfirmation()`，把 `identityDialog` 渲染到合适位置，并提供 `onExportSpace = (spaceId) => withIdentityConfirmation(() => downloadTeamConfig(spaceId))`。
- 把新回调传给 `ShellDialogs`。

### 5. `apps/web/src/pages/SpaceSettingsPanel.tsx`

- 删除 `import { TeamConfigSettings }`（`:5`）与整个 `<SettingsGroup title={<Trans>Workspace configuration</Trans>}>…</SettingsGroup>`（`:105-106`）。
- 移除后若 `SettingsGroup` 不再被该文件使用，一并去掉其 import。

### 6. 删除 `apps/web/src/components/TeamConfigSettings.tsx`

逻辑已迁走。同步删除其测试。

## 测试

- **删除** `apps/web/src/components/TeamConfigSettings.test.tsx`；把其中有价值的用例（"downloads through a token, never a fetch"、导入勾选）**迁移**到新对话框的测试（新建 `ImportWorkspaceDialog.test.tsx`）与 `shell-dialogs` 的测试。
- **更新** `apps/web/src/pages/SpaceSettingsPanel.test.tsx`：移除 `vi.mock("../components/TeamConfigSettings", …)`（`:49-50`）及任何断言该分组的用例。
- **新增** `shell-dialogs` 用例：二级菜单出现两个新项；点导出触发注入的回调并传入正确的 `spaceId`。
- 测试沿用仓库习惯：`createRoot` + `act`（非 testing-library），`beforeEach` 设置 lingui i18n。

## i18n

新字符串用 lingui 宏（`t\`...\`` / `<Trans>`）。改动后需**重新生成 catalogs**（`apps/web/src/locales/*/messages.po`）—— 确认 `pnpm --filter @rakazo/web` 下的 lingui extract 脚本名后执行。

## 验证

1. `npx vitest run apps/web/src/pages/shell apps/web/src/pages/SpaceSettingsPanel.test.tsx`。
2. `pnpm --filter @rakazo/web check`（tsc）通过。
3. 手动：从**非当前**工作区的二级菜单导出，确认下载的文件对应它本身而非当前工作区（scoped rpc 生效）。
