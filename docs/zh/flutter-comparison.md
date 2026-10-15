# Flutter 对齐与迁移

[English](../flutter-comparison.md) · [文档索引](./README.md)

共享核心语义以 `flutter_view_model` **1.2.1** 为基准，固定到
[`c5e57d8`](https://github.com/lwj1994/flutter_view_model/tree/c5e57d8cb28922497901cf2b9ffb082221771ad3)。
范围包括 PR #82 及后续所有权、状态重入修复，不只是 API 名称。
以下改动**尚未发布**，npm `0.3.1` 不包含这些能力。

## 共享核心覆盖

| Flutter 约定                                | JavaScript 实现                                                                    | 回归证据                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 类型 + 有效 key；unkeyed 属于 Binding       | 显式类 token、对象/基础类型 key、O(1) 已持有 handle 复用                           | `identity.test.ts`、`diagnostics.test.ts`                                        |
| `ViewModelSpec.arg/arg2/arg3/arg4`          | 类型化可调用 family；参数控制构造，不自动参与身份                                  | `spec-overrides.test.ts`                                                         |
| Override/proxy 解析                         | 可恢复的 `overrideWith`、兼容 `setProxy/clearProxy`、拒绝环、有效 key/tag/保活策略 | `spec-overrides.test.ts`                                                         |
| 异步作用域覆盖                              | 回调显式接收隔离 Runtime；区别见下文                                               | `spec-overrides.test.ts`                                                         |
| Getter DI、`read`/`watch`、订阅升级         | generation 持有稳定 Binding；不按 build 清理依赖                                   | `dependencies.test.ts`、`flutter-parity.test.ts`                                 |
| 保留所有依赖通知、合并根刷新                | parent 通知和业务监听不去重；同一 transaction 每个根刷新一次                       | `notifications.test.ts`、`flutter-parity.test.ts`                                |
| 状态事件顺序、移除监听                      | 同步重入时按 FIFO 投递，普通 notify 不重放旧 diff                                  | `flutter-parity.test.ts`、`flutter-api.test.ts`                                  |
| `listenState(previous, current)` 与选择监听 | 位置参数、不虚构 null、随 Binding 清理                                             | `flutter-api.test.ts`                                                            |
| `update`、监听、状态历史、判等              | 同步/异步成功后自动通知；局部/全局/`Object.is` 判等                                | `flutter-api.test.ts`、`electron/equality.test.tsx`、`vue.test.ts`               |
| direct 与各 parent 路径独立计数             | 使用精确登记身份；回调前提交账本；取消过期 release                                 | `ownership-commit.test.ts`                                                       |
| 最新创建缓存、tag 批量查询                  | 优先 key、key 缺失再查 tag、最新优先、预检与回滚                                   | `cached-dependencies.test.ts`、`diagnostics.test.ts`、`ownership-commit.test.ts` |
| 强制 recycle、unbind、reset、保活           | 重入前清缓存、仅删除旧登记、完整清理独占依赖图                                     | `ownership-commit.test.ts`、`flutter-api.test.ts`                                |
| 配置、生命周期观察者、错误报告              | `ViewModel.initialize/config/reset`、观察者、`ErrorType`、安全错误接收器           | `flutter-api.test.ts`                                                            |
| 调试图与计数                                | `runtime.getDiagnostics/countInstances`、factory/tag 歧义提示                      | `diagnostics.test.ts`、`flutter-api.test.ts`                                     |
| 暂停与恢复                                  | Runtime 应用/窗口 token，加独立 Binding 界面暂停 token                             | `flutter-api.test.ts`、各平台生命周期测试                                        |

未注明目录的测试位于 `tests/core/`，所有测试串行执行。
`scripts/test-package-exports.mjs` 还针对构建产物验证 ESM/CJS 的配置、覆盖、reset 和类型身份。

## 从 0.3.1 迁移的破坏性改动

`update` 在操作成功后自动通知；Promise 要等成功完成。
删除 `update` 内结尾处重复的 `notifyListeners()`，除非确实需要额外事件。
不可变状态直接使用 `setState/updateState`，不必再包一层 `update`。

```ts
this.update('cart.add', () => {
  this.items.push(item);
});
await this.update('cart.reload', async () => {
  this.items = await loadItems();
});
```

已移除 `onDependencyNotify`。watch 的 child 自动通知 parent。
业务反应应在 `onCreate` 中使用 `this.viewModelBinding.listen(childSpec, callback)`，
不要用手动转发循环替代旧 hook。

```ts
binding.listenState(counterSpec, (previous, current) => {
  recordChange(previous, current);
});
binding.listenStateSelect(
  counterSpec,
  (state) => state.count,
  (previous, current) => {
    recordCount(previous, current);
  },
);
```

`listenState`/`listenStateSelect` 从对象参数改为位置参数。
底层 `subscribeState(({ previous, current }) => ...)` 则保留对象参数。
菱形依赖可能产生两次 parent 事件，只有根界面刷新合并。
监听、生命周期和清理错误交给 `config.onError`，不再同步抛 `AggregateError`。
`onCreate/onBind` 抛错会报告，但不会因此自动销毁仍有效的 owner。
构造、依赖环、类型错误和无效 owner 仍会拒绝操作。
销毁后的 `notifyListeners` 和状态写入忽略执行，`updateState` 也不运行 updater；
依赖解析、新订阅和 `update` 仍拒绝已结束的 generation。

## 参数化 Spec 与有效身份

```ts
const userSpec = ViewModelSpec.arg(UserViewModel, (id: string) => new UserViewModel(id), {
  key: (id) => id,
  tag: () => 'users',
});
const user = binding.watch(userSpec('ada'));
```

没有 key 时，同一 Binding 内同一显式类的不同参数仍复用首个实例。
同一 Runtime 内，显式类 + key 相同就共享，包括不同 Spec；后来的 builder 不替换已存在 generation。
key 使用 JavaScript Map 身份：对象按引用比较，不模拟 Dart 的重载相等。
`undefined` 表示 unkeyed，`null` 被拒绝。tag 只分组，不决定身份。
`aliveForever` 必须提供显式 key。

## Override 作用域：显式 Runtime，不是隐式 Dart Zone

```ts
await userSpec.runWithOverride(fakeUserSpec, async (runtime) => {
  const binding = runtime.createBinding();
  await prepareFixture();
  const user = binding.read(userSpec('ada'));
  // Nested getters use the same Runtime and override context.
  await verifyUser(user);
});
```

多项覆盖使用 `ViewModelRuntime.runWithOverrides([[source, replacement]], callback)`。
实例方法 `runtime.runWithOverrides` 继承该 Runtime 的 factory 选择。
每个 helper 都提供**新建、缓存隔离的 Runtime**，快照覆盖上下文，并在回调成功或失败后销毁。
整个异步任务都须使用传入 Runtime；原有无关 Binding 不会自动进入该作用域。
这不是透明的 Dart Zone 移植，并发任务不会互相替换 factory 选择。

`spec.overrideWith(replacement)` 是手动、当前 JS realm 全局覆盖，返回幂等恢复函数。
务必在 `finally` 恢复，不要让独立异步任务重叠使用它。
覆盖只改变后续解析，不替换已存在 generation。
`withKey` 产生独立的具体声明；需要覆盖时对该声明安装 override，或使用参数化 family。

## 宿主差异边界

核心依赖生命周期跟随 Binding 所有权，**不收集或清理 build/render 依赖**。
React render 只准备纯对象，owner、`onCreate` 和 `onBind` 在 commit 后建立。
依赖 getter 用于 commit 后的 action/生命周期，不用于 render 或 selector。
自然零 owner 销毁延迟到 microtask，以容纳 React 立即重新挂载；强制 recycle/reset/Runtime dispose 同步完成。

`binding.pause/resume` 只暂停该 Binding 的界面刷新，不影响其他 owner、状态和业务监听。
`runtime.pause/resume` 还触发 VM `onPause/onResume`，聚合应用/窗口 token。
它们都不是 Flutter route/ticker provider。

本库不导出 Flutter Widget mixin、`ChangeNotifier`、Dart Stream、注解/代码生成或 Flutter
DevTools UI/协议。调试信息是普通快照，不是 DevTools 扩展。
JavaScript 宿主对应现有 React Native/Electron Scope hooks、Vue 响应式桥接与 Taro 页面生命周期。
没有新增 React Web、SSR 或 RSC 支持。Electron main/preload/renderer 仍是不同 realm，应通过 IPC
传递可序列化 DTO，不共享 VM 对象。
