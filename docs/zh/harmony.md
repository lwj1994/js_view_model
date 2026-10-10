# HarmonyOS 集成

[English](../harmony.md) · [文档索引](./README.md)

HarmonyOS 适配器把现有 TS/JS core 接入 ArkUI 宿主，提供显式 Scope 所有权和 Runtime 生命周期桥接。业务 ViewModel、Spec 和依赖注入保留在 TypeScript 中；`.ets` 页面或组件通过小型门面获取具体值，并写入 ArkUI 可观察状态。

## 支持与验证边界

这是 **TS/JS 互操作适配器**，不是将 core 全部重写为 `.ets`。它不依赖 React 或 Vue，也不会自动安装 HarmonyOS 平台监听器。

附带的原生示例面向使用 **ArkUI V2、API 12 或以上**的 Stage 模型 ArkTS 应用。仓库检查在 Node 中验证适配器与生成包，并检查 TypeScript 门面的类型。这些检查不编译 ArkTS、不执行 DevEco 的 OHPM 解析，也不验证原生设备。将某个 SDK/设备组合作为已验证目标前，需要使用选定的 HarmonyOS SDK 构建并运行示例。

业务代码保留 `.ts` 是有意的设计。ArkTS 支持导入 TS/JS，但将这些代码复制到 `.ets` 后，类型和动态 JavaScript 行为会受到不同限制。适配器不承诺 `.ets` 可以直接继承所有 JS ViewModel，也不承诺 ArkTS 可以直接使用 core 暴露的所有泛型构造器或 Spec 类型。

## 包入口

| 发行形式           | 导入路径                     | 用途                          |
| ------------------ | ---------------------------- | ----------------------------- |
| 生成的本地 OHPM 包 | `@lwjlol/view_model`         | DevEco 应用中的 TS 业务代码。 |
| npm 包             | `@lwjlol/view_model/harmony` | TS/JS 工具链中的同一适配器。  |

两个 Harmony 入口都会重新导出 core API。**npm 根入口**仍然只导出 core，与生成的 OHPM 根入口不同。

这些 Harmony 入口是**当前源码中尚未发布的新增能力**。此前发布的 npm `0.3.1` 包不包含 `/harmony`。请使用当前 checkout 生成的 OHPM 产物；上表中的 npm 入口指本地重新构建的包，或未来包含该变更的发行版。

在仓库根目录构建本地 OHPM 包：

```sh
npm ci
npm run build:harmony
```

然后进入 DevEco 应用的 `entry` 模块目录，安装生成的目录：

```sh
ohpm install /absolute/path/to/js_view_model/dist/ohpm
```

将绝对路径替换为仓库位置，并执行 **Sync and Refresh Project**。本地安装不依赖 OHPM 仓库发布。生成包应以 JS 配合类型声明的形式使用，不应重命名为 `.ets`。

完整的文件位置、页面配置与原生验证步骤见 [Counter 示例](../../examples/harmony-counter/README_ZH.md)。下方代码片段均使用 OHPM 根入口。

## 公开适配器 API

```ts
import {
  createViewModelHarmonyLifecycle,
  createViewModelHarmonyScope,
  StateViewModel,
  ViewModelRuntime,
  viewModelSpec,
} from '@lwjlol/view_model';
```

| API                                                    | 行为                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `createViewModelHarmonyScope({ runtime?, onUpdate? })` | 创建一个稳定 Binding。未注入 Runtime 时，Scope 创建并持有独立 Runtime。            |
| `scope.watch(spec)`                                    | 获取当前 generation，普通变化通过 Scope 的稳定 `onUpdate` 回调送达。               |
| `scope.read(spec)`                                     | 获取当前 generation，不增加普通变化的观察；仍参与 generation 失效通知。            |
| `scope.runtime`、`scope.binding`                       | 暴露现有 core Runtime 和 Binding，供组合与高级操作使用。                           |
| `scope.ownsRuntime`                                    | 表示释放 Scope 时是否同时释放 Runtime。                                            |
| `scope.isDisposed`                                     | Scope、自身 Binding 或 Runtime 任一已释放时为 true。                               |
| `scope.dispose()`                                      | 停止 Scope 更新回调，释放 Binding，再释放由 Scope 持有的 Runtime。可安全重复调用。 |
| `createViewModelHarmonyLifecycle(runtime)`             | 创建初始为 active 的生命周期来源，持有独立 Runtime 暂停 token。                    |
| `lifecycle.setActive(active)`                          | 暂停或恢复该来源；多个来源由 Runtime 聚合。                                        |
| `lifecycle.dispose()`                                  | 仅移除该来源的暂停 token，不释放 Runtime。                                         |

`watch` 和 `read` 会立即执行获取操作。重复 `watch` 复用同一个 Binding 回调，不会在每次调用时增加监听器。之后调用 `read` 也不会移除这个 Scope 已经建立的 watch。

## 保持较小的语言边界

[CounterFacade.ts](../../examples/harmony-counter/src/main/ets/viewmodel/CounterFacade.ts) 示例将以下内容保留在 TypeScript：

- `StateViewModel` 子类与 state 类型；
- 稳定的模块级 `viewModelSpec(CounterViewModel, builder, options)`；
- Scope、Runtime 与 Binding；
- 解析当前 ViewModel 的命令；
- 读取新快照的稳定 `onUpdate` 回调。

只有具名的 `CounterFacade` 和具体的 `CounterSnapshot` 进入 `.ets`。门面暴露 `getSnapshot()`、`increment()`、`recycle()` 和 `dispose()`。快照包含 `number`，页面因此不需要把类对象作为 DI token 传递，也不依赖复杂的 TypeScript 泛型推导。

TS 门面中关键的回调方式是：

```ts
this.scope = createViewModelHarmonyScope({
  onUpdate: () => {
    const current = this.scope.watch(counterSpec);
    onUpdate(new CounterSnapshot(current.state.count));
  },
});
```

像完整示例一样，在 Scope 赋值完成后再进行首次获取。资源初始化应放在 ViewModel 的 `onCreate`，或获取实例后执行的显式 action 中；构造函数和 Spec builder 应保持纯净。

## 将更新连接到 ArkUI 状态

ArkUI 不会自动订阅普通 JS ViewModel 的私有状态。把同一个 ViewModel 引用再次赋给可观察字段，不是可靠的更新信号。

示例 [Index.ets](../../examples/harmony-counter/src/main/ets/pages/Index.ets) 渲染 `@Local count`，并通过门面初始化和更新：

```ts
aboutToAppear(): void {
  const counter = new CounterFacade((snapshot: CounterSnapshot): void => {
    this.count = snapshot.count;
  });
  this.counter = counter;
  this.count = counter.getSnapshot().count;
}
```

`build()` 只读取这个本地字段，按钮回调调用门面命令。应用也可以使用自己的 `@ObservedV2`/`@Trace` 展示模型，但适配器需要显式更新其中的可观察属性。

发布更新时，应重新解析被 watch 的 Spec。`runtime.recycle(spec)` 会强制释放旧 generation，下一次 `scope.watch(spec)` 获取替代实例。永久缓存的 ViewModel 引用，或直接安装的 `subscribeState` 监听器仍绑定旧对象，不能代替这种 Scope 级绑定。

Scope 使用 core Binding 的事务通知规则：同一同步通知事务中的普通 watch 更新按 Binding 去重，Runtime 暂停期间的更新合并到恢复时送达。UI 渲染调度仍由 ArkUI 负责。

## 组件所有权与可见性

| 宿主事件                   | 适配器操作                                                 |
| -------------------------- | ---------------------------------------------------------- |
| 组件 `aboutToAppear`       | 创建门面或 Scope，执行首次 `watch`，将快照写入可观察状态。 |
| 组件 `build`               | 仅读取展示状态，不获取 ViewModel 或安装订阅。              |
| 组件 `aboutToDisappear`    | 释放门面或 Scope；组件销毁期间不再更新 ArkUI 状态。        |
| 保留中的页面隐藏或失去焦点 | 保留 Binding；可见性变化本身不等于释放。                   |
| 组件被保留的页面重新显示   | 继续使用现有 Scope 和 generation。                         |

适配器不会自动查找组件生命周期方法或导航事件，需要宿主显式连接。可复用组件的回收、复用回调需要单独定义释放与重新获取所有权的策略；最小 Counter 示例使用普通组件。

## Runtime 边界、共享与回收

未传入 `runtime` 的 Scope 持有完整对象图。释放时，它先释放 Binding，再释放 Runtime。注入的 Runtime 仍由调用方持有；创建者需要先释放其他 owner Scope/Binding，再释放 Runtime。

多个组件共享 Runtime 时，unkeyed Spec 仍对每个 Binding 私有。需要有意共享 generation 时，应使用显式 ViewModel type 与 `key`。`aliveForever` 仍必须有 key，而且仍会在强制回收或 Runtime 释放时结束。

`scope.runtime.recycle(spec)` 是共享失效操作，不是普通页面清理。它会结束该 Runtime 中所有匹配的 generation，包括其他 owner 正在持有的实例。unkeyed Counter 示例拥有独立 Runtime，因此 **Recreate counter** 按钮只影响当前示例实例。

## Runtime 暂停与应用生命周期

需要根据应用或窗口是否活跃来暂停 Runtime 时，使用 `createViewModelHarmonyLifecycle`。桥接保留在 TypeScript 中，对 `.ets` 暴露 `setActive(active: boolean)` 这样的具体门面方法。

```ts
const lifecycle = createViewModelHarmonyLifecycle(applicationRuntime);

// Forward the actual host lifecycle, including its current state when attaching.
lifecycle.setActive(false);
lifecycle.setActive(true);

// Detach this lifecycle source when its host ends.
lifecycle.dispose();
```

对于由应用持有的 Runtime，UIAbility 的 `onForeground` 与 `onBackground` 可以通过门面分别传递 `true` 和 `false`。示例不会自动安装这些回调。保留 DevEco 生成的 UIAbility 代码，在持有 Runtime 的同一组合边界连接生命周期桥接。

暂停影响**该 Runtime 中所有已激活的 ViewModel**。它调用 `onPause`/`onResume`，并延迟 Binding 投递的 UI 回调；它不会停止 action、状态修改、直接的 `subscribe`/`subscribeState` 回调或任意任务。需要在后台停止的工作，必须实现自身的生命周期处理。

页面级生命周期只能用于暂停独立的页面 Runtime。某个页面隐藏时暂停共享应用 Runtime，也会影响其他页面。如果既要共享应用对象图，又只想改变单个页面的工作，应将可见性作为普通业务输入传递。

每个生命周期桥接都有自己的 token。移除一个 inactive 来源，不会恢复仍被其他来源暂停的 Runtime。最终退出时，先释放 owner Scope/Binding，再释放 Runtime，最后移除生命周期来源；先释放 Runtime 可避免最后的清理触发待处理 UI 更新。

## 发布前需要验证的内容

先完成 [Counter 验证步骤](../../examples/harmony-counter/README_ZH.md#4-在-deveco-中构建并验证)，再覆盖应用实际使用的边界：

- 所选 DevEco/SDK 版本下的 OHPM 依赖与类型声明解析；
- JS/TS 到 ArkTS 的门面调用与原生 UI 刷新；
- watch 状态、仅 read 的命令，以及 recycle 后替代 generation 的获取；
- 页面保留、销毁，以及使用可复用组件时的策略；
- 共享 Runtime 的实例身份与独立生命周期暂停来源。

Node 测试或 TS 构建成功不能证明这些原生行为。JS 语法兼容性与运行时 API 可用性也需要验证；语法转译不会补齐缺失的运行时 API。完整 `.ets` 迁移、由本库提供原生 UI 组件，以及自动 ArkUI 依赖跟踪，都不属于这个适配器的范围。

## 官方参考

- [ArkTS 简介](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-overview)：ArkTS 与 TS/JS 互操作。
- [TypeScript 到 ArkTS 的适配规则](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/typescript-to-arkts-migration-guide)：语言限制与 `.ets`/`.ts`/`.js` 导入方向。
- [OHPM install](https://developer.huawei.com/consumer/cn/doc/doccenter-deveco-studio/ide-hmos-ohpm-install)：本地目录依赖。
- [使用 ArkUI V2 实现 MVVM](https://developer.huawei.com/consumer/en/doc/harmonyos-guides-V14/arkts-mvvm-v2-V14)：显式可观察的展示状态。
- [自定义组件生命周期](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-custom-component-lifecycle)：原生组件的初始化与释放回调。
