# HarmonyOS Counter

[English](./README.md) · [HarmonyOS 集成](../../docs/zh/harmony.md)

这个示例通过一个具名的门面类，将 TypeScript ViewModel 接入原生 ArkUI 页面。把两个源文件复制到 **DevEco Studio 创建的 Stage 模型 ArkTS 应用，目标 API 为 12 或以上**。页面使用 `@ComponentV2` 和 `@Local`。

仓库会在 Node 中验证 TypeScript 门面与生成的包。这些检查不会编译 `.ets` 页面，也不能代替 HarmonyOS 设备验证。将某个 SDK/设备组合作为支持目标前，应完成下方的 DevEco 检查。

## 文件

| 文件                                                          | 职责                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [CounterFacade.ts](./src/main/ets/viewmodel/CounterFacade.ts) | 业务 ViewModel、稳定 Spec、Scope 所有权、操作命令，以及具体的 `CounterSnapshot`。 |
| [Index.ets](./src/main/ets/pages/Index.ets)                   | 组件生命周期，以及通过 `@Local count` 渲染 ArkUI。                                |

示例使用本地 **OHPM 包的根入口** `@lwjlol/view_model`。npm 发行包通过 `@lwjlol/view_model/harmony` 暴露相同适配器；仅在 TS/JS 工具链中使用 npm 发行包时修改导入路径。

Harmony 支持是**源码中尚未发布的新增能力**。此前发布的 npm `0.3.1` 包不包含 `/harmony`，请从当前 checkout 构建 OHPM 包。上面的 npm 导入路径指本地重新构建的包，或未来包含适配器的发行版。

## 1. 构建本地 OHPM 包

在本仓库根目录执行：

```sh
npm ci
npm run build:harmony
```

构建产物位于 `dist/ohpm`。DevEco 工程通过本地依赖引用它时，需要保留此目录。这些步骤不假设包已经发布到 OHPM 仓库。

## 2. 创建 DevEco 应用并安装依赖

在 DevEco Studio 中创建 Stage 模型的 **Empty Ability** 应用。为这个使用 V2 状态管理的示例选择兼容的 SDK，并将最低支持 API 设为 12 或以上。

在 DevEco 终端中进入应用的 `entry` 模块目录，安装生成的包。将路径替换为你电脑上的绝对路径：

```sh
ohpm install /absolute/path/to/js_view_model/dist/ohpm
```

OHPM 会将本地依赖写入 `entry/oh-package.json5`。如果移动了仓库位置，需要更新或重新安装该依赖。安装后执行 **Sync and Refresh Project**。

## 3. 复制源文件

将本示例 `src/main/ets` 目录中的内容复制到 DevEco 应用的 `entry/src/main/ets`：

- `viewmodel/CounterFacade.ts` 保留 **`.ts`** 后缀。
- `pages/Index.ets` 替换生成的页面。

保留 DevEco Studio 生成的 `EntryAbility` 与工程配置。初始窗口应像标准 Empty Ability 工程一样加载 `pages/Index`。页面配置 `entry/src/main/resources/base/profile/main_pages.json` 必须包含该路径：

```json
{
  "src": ["pages/Index"]
}
```

如果工程已有其他页面，将 `pages/Index` 加入或保留在原列表中，不要覆盖其他页面配置。这个计数器不需要增加权限或 UIAbility 代码。

## 4. 在 DevEco 中构建并验证

将应用构建并运行到选定的模拟器或设备，验证以下行为：

1. 页面初始显示 `0`。
2. 每次点击 **Increment**，显示的数字更新一次。
3. 点击 **Recreate counter** 会强制回收当前 generation，页面显示 `0`；再次 Increment 显示 `1`。
4. 隐藏但仍被保留的页面不释放 Scope。只要进程与组件仍然存活，返回后计数保持不变。
5. 移除或销毁页面时执行 `aboutToDisappear`，释放 Scope。重新创建页面时从 `0` 开始。

要完整验证后两项，需要使用导航宿主操作页面保留与销毁。这个单页示例在进程保持存活时，切换前后台可以检查状态是否保留，但不能替代销毁检查。在新工程中加入导航验证时，可以临时在 `aboutToDisappear` 设置断点。

## 状态如何到达页面

`aboutToAppear` 创建 `CounterFacade`，并读取初始快照。门面持有一个 Scope、一个 Binding 和一个独立 Runtime。`getSnapshot()` 调用 `scope.watch(counterSpec)` 获取当前 ViewModel，并返回包含数字的具体快照。

后续由 Scope 的稳定 `onUpdate` 回调获取新快照，再把 `snapshot.count` 写入 ArkUI 的 `@Local count`。页面只渲染这个字段。回调中重新解析 Spec 也能处理强制回收；门面不会永久缓存旧 ViewModel 引用。

按钮操作使用 `scope.read(counterSpec)`，因为执行命令本身不需要建立渲染订阅。它仍会得到这个 Scope 已经 watch 的同一 generation。Spec 没有 key，因此第二个门面会获得独立计数器。

`aboutToDisappear` 释放 Scope，不再修改 `@Local` 字段。Scope 释放自己的 Binding，以及它创建的 Runtime。`build()` 中不执行获取实例或安装订阅的操作。

## 生命周期扩展

最小示例没有安装应用前后台适配器。页面隐藏本身不会释放 Binding 或暂停 Runtime。若要连接 UIAbility 生命周期回调，请使用[集成指南](../../docs/zh/harmony.md#runtime-暂停与应用生命周期)中的显式生命周期桥接。

## 验证边界

仓库的 Node/TypeScript 检查覆盖门面、包入口与适配器行为。只有完成 DevEco 构建与上述检查，才能确认 `.ets` 页面、OHPM 解析、JS/ArkTS 互操作和 UI 刷新在所选 HarmonyOS SDK 上可用。业务文件应保留 TypeScript 后缀；重命名为 `.ets` 会引入不同的语言限制，属于另一项迁移工作。
