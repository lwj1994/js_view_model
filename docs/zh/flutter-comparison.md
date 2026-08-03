# 与 Flutter `view_model` 的差异

[English](../flutter-comparison.md) · [文档索引](./README.md)

这个 TypeScript 包与 [`lwj1994/flutter_view_model`](https://github.com/lwj1994/flutter_view_model) 共享同一架构方向：功能模块都可以成为受管理的 ViewModel，Binding 持有实例，依赖通过 ViewModel getter 按需解析，普通实例自动销毁。

但它不是 API 直译。TypeScript runtime identity、React 调度以及 React Native/Electron 生命周期要求不同的契约。

## 概念映射

| Flutter `view_model`          | TypeScript `view_model`                  | 关键差异                                                         |
| ----------------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| `class X with ViewModel`      | `class X extends ViewModel`              | TypeScript 使用继承，不是 Dart mixin。                           |
| `StateViewModel<T>`           | `StateViewModel<TState>`                 | 判等默认使用 `Object.is`，没有全局 equality 配置。               |
| `ViewModelSpec<T>`            | `ViewModelSpec<T>` / `viewModelSpec()`   | TypeScript 泛型在运行时不存在，因此身份是稳定 Spec token + key。 |
| `ViewModelBinding` host mixin | `runtime.createBinding()`                | plain host 显式拥有并 dispose Binding。                          |
| Widget mixins                 | 平台 `ViewModelScope` + hooks            | Scope 把 React commit/unmount 映射到一个 Binding owner。         |
| `watch(spec)`                 | `binding.watch` / `useViewModel`         | 两者都建立 owner；watch 还传播普通通知。                         |
| `read(spec)`                  | `binding.read` / `useReadViewModel`      | read 仍建立 owner；adapter 需要时仍响应 generation 替换。        |
| Selector widget               | `useViewModelSelector`                   | selector 接收 ViewModel，默认使用 `Object.is` 判等。             |
| `listenState`                 | `subscribeState`                         | 直接订阅返回 cleanup，不会由 Binding 自动托管。                  |
| keyed sharing                 | 显式 key                                 | 只有同一 Runtime 内相同 Spec token + key 才共享。                |
| child getter DI               | `this.viewModelBinding.read/watch(spec)` | builder、constructor、React render、selector 均禁止访问 getter。 |
| `recycle(vm)`                 | `runtime.recycle(vmOrSpec)`              | unkeyed Spec target 可能回收多个 Binding-private generation。    |
| pause/resume provider         | Runtime pause token                      | pause 作用于整个 Runtime，不是 route/ticker 或 Scope 局部能力。  |

## 身份是 Spec token + key

Flutter 可把解析泛型类型作为 runtime identity 的一部分。JavaScript 不行，因为 TypeScript 泛型会被擦除。本包会为每个 base Spec 分配 runtime token：

```ts
const first = viewModelSpec(() => new SessionViewModel(), { key: 'session' });
const second = viewModelSpec(() => new SessionViewModel(), { key: 'session' });

binding.read(first) !== binding.read(second);
```

参数化变体需要保留 base token 时，使用 `withKey`：

```ts
const userSpec = viewModelSpec(() => new UserViewModel());
const adaSpec = userSpec.withKey('ada');
const graceSpec = userSpec.withKey('grace');
```

不要把 Flutter 的 `T + key` 解释直接复制到 TypeScript 文档或代码审查中。

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

- `tag` 或 cached lookup API；
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
