# 与 Flutter `view_model` 的差异

[English](../flutter-comparison.md) · [文档索引](./README.md)

这个 TypeScript 包与 [`lwj1994/flutter_view_model`](https://github.com/lwj1994/flutter_view_model) 共享同一架构方向：功能模块都可以成为受管理的 ViewModel，Binding 持有实例，依赖通过 ViewModel getter 按需解析，普通实例自动销毁。

但它不是 API 直译。TypeScript runtime identity、React 调度以及 React Native/Electron 生命周期要求不同的契约。

## 概念映射

| Flutter `view_model`          | TypeScript `view_model`                  | 关键差异                                                                         |
| ----------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| `class X with ViewModel`      | `class X extends ViewModel`              | TypeScript 使用继承，不是 Dart mixin。                                           |
| `StateViewModel<T>`           | `StateViewModel<TState>`                 | 判等默认使用 `Object.is`，没有全局 equality 配置。                               |
| `ViewModelSpec<T>`            | `ViewModelSpec<T>` / `viewModelSpec()`   | TypeScript 泛型在运行时不存在，因此需要显式传入 ViewModel class。                |
| `ViewModelBinding` host mixin | `runtime.createBinding()`                | plain host 显式拥有并 dispose Binding。                                          |
| Widget mixins                 | 平台 `ViewModelScope` + hooks            | Scope 把 React commit/unmount 映射到一个 Binding owner。                         |
| `watch(spec)`                 | `binding.watch` / `useViewModel`         | 两者都建立 owner；watch 还传播普通通知。                                         |
| `read(spec)`                  | `binding.read` / `useReadViewModel`      | read 仍建立 owner；adapter 需要时仍响应 generation 替换。                        |
| Selector widget               | `useViewModelSelector`                   | selector 接收 ViewModel，默认使用 `Object.is` 判等。                             |
| `listen` / state listener     | Binding `listen*` method                 | Binding/handle 会自动 cleanup；每个 method 也返回手动 disposer。                 |
| cached/tag lookup             | Binding cached method                    | target 是显式 class 或 Spec；lookup 不会创建缺失 generation。                    |
| keyed sharing                 | 显式 type + key                          | 同一 Runtime 内，显式 class 与 key 相同的独立 Spec 会共享。                      |
| child getter DI               | `this.viewModelBinding.read/watch(spec)` | builder、constructor、React render、selector 均禁止访问 getter。                 |
| parent source 传播            | generation-owned dependency Binding      | 当前 external root Binding source 会镜像给 child，并按 ownership path 独立计数。 |
| 同步通知                      | update propagation transaction           | 一次完整同步级联内，Binding delivery 按 owner/callback identity 去重。           |
| `recycle(vm)`                 | `runtime.recycle(vmOrSpec)`              | unkeyed Spec target 可能回收多个 Binding-private generation。                    |
| pause/resume provider         | Runtime pause token                      | pause 作用于整个 Runtime，不是 route/ticker 或 Scope 局部能力。                  |

## 优先使用显式 type + key

TypeScript 泛型会被擦除，因此 package 无法从 `ViewModelSpec<T>` 恢复 `T`。应把 ViewModel class 作为显式 runtime identity 传入：

```ts
const first = viewModelSpec(SessionViewModel, () => new SessionViewModel(), {
  key: 'session',
});
const second = viewModelSpec(SessionViewModel, () => new SessionViewModel(), {
  key: 'session',
});

binding.read(first) === binding.read(second);
```

显式 type 不带 key 时，generation 仍由单个 Binding 私有；显式 type 带 key 时，会由同一 Runtime 内的 Binding 共享。`withKey` 会保留显式 type identity：

```ts
const userSpec = viewModelSpec(UserViewModel, () => new UserViewModel());
const adaSpec = userSpec.withKey('ada');
const graceSpec = userSpec.withKey('grace');
```

builder-only overload 仍作为兼容 fallback 保留：

```ts
const legacySpec = viewModelSpec(() => new SessionViewModel());
```

每个独立创建的 builder-only base Spec 都有唯一 token，因此即使 key 相同，不同 builder-only Spec 也不会共享。此类 Spec 应稳定声明在 module scope；需要共享 identity 时，应优先使用显式 type + key。

## 同步传播保持 Flutter transaction 语义

`notifyListeners` 会在整段同步通知级联之外开启 propagation transaction。direct listener、dependency 冒泡以及嵌套同步通知都会进入同一 transaction。

Binding delivery 按 Binding owner identity 与 callback identity 的组合去重。同一 callback 经由同一个 Binding 多次到达时只运行一次；两个不同 Binding 即使复用同一 callback，也会各运行一次。同一 parent generation 在该 transaction 中也最多冒泡一次。后续 microtask 或 Promise continuation 会开启新的 transaction。

每个 parent generation 都拥有一个稳定的 dependency Binding。解析 child 后，parent 当前所有 external root Binding source 会镜像给该 child；root 后续增加或移除时也会同步。direct ownership source 与每条 parent path 都独立计数：某个 Binding id 的首个 source 会触发 `onBind(id)`，最后一个 source 移除后才触发 `onUnbind(id)`。`read` 会建立这条生命周期边，但不冒泡普通通知；`watch` 还会冒泡 child 通知。

## cached lookup 与 listener 保持 ownership

普通依赖注入应保留 Spec，并调用 `read(spec)` 或 `watch(spec)`。cached method 是高级 lookup-only API，只查询已经由其他路径创建的 generation。target 可以是显式 ViewModel class 或 Spec：

- `readCached` / `watchCached` 返回一个 lookup match，未命中时抛错；
- `maybeReadCached` / `maybeWatchCached` 未命中时返回 `undefined`；
- `readCachesByTag` / `watchCachesByTag` 返回所有匹配项，未命中时返回空数组。

`tag` 只是分组 label，不参与 identity。cached method 都不会运行 builder。命中后仍会 bind generation，并建立与 Spec-based resolution 相同的 parent lifetime edge。只有 `watch` 变体会冒泡普通 child 通知。

`binding.listen`、`listenState` 与 `listenStateSelect` 通过 Spec 解析并安装 side-effect listener，但不会增加 broad watch propagation。Binding 或 generation handle dispose/recycle 时会自动移除这些 listener；每个返回的 disposer 也可用于提前移除。底层 `viewModel.subscribe` / `subscribeState` API 仍需手动管理。

## `update` 不会自动通知

Flutter 的便利 update API 可能自动发布变化。TypeScript 方法目的更窄：它只为 mutation 内同步发出的通知附加 action 值。

```ts
this.update('cart.add', () => {
  this.items.push(item);
  this.notifyListeners();
});
```

省略 `notifyListeners()` 只会静默修改字段。`StateViewModel` action 通常使用 `setState` 或 `updateState`；判等得到新快照时，它们会自动通知。

## Scope 是 React render/commit 的适配层

Flutter widget mixin 与本包 React Scope/hooks 都解决 owner 问题，但宿主生命周期不同。React render 可能被重放或放弃，因此 builder 可在 render 中准备纯对象，而 owner、`onCreate`、`onBind` 只能在 commit 后开始。

应用级 DI 不需要 Scope。Electron main、启动逻辑、后台服务与测试直接使用同一个 core Runtime 创建的 plain Binding。

## 刻意没有移植的 API

这个 TypeScript 包目前没有：

- `ViewModelSpec.arg/arg2/arg3/arg4`；
- proxy/override 或代码生成注解；
- `ChangeNotifierViewModel`；
- 全局 `initialize`、`reset`、equality、logging 或 error 配置；
- DevTools 协议；
- Flutter route/ticker lifecycle provider；
- Widget mixin。

不要通过未记录的 import 模拟这些能力。应使用当前导出的 core 与平台 API，或明确提出库级变更。

## 平台边界

TypeScript 包只服务 React Native 与 Electron。Electron main、preload、renderer 是不同 realm，应通过 IPC 传递可序列化 DTO 与事件。内部共用 React 层不是公共 Web 入口，也不代表支持普通 React Web、SSR 或 RSC。
