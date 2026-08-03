# API 参考

[English](../api.md) · [文档索引](./README.md)

> 本参考描述 v0.1 alpha 对 React Native、Electron renderer 与 Electron main/core 的受支持接口。精确泛型推导仍以当前 package 生成的 TypeScript declarations 为准。

## Package 入口

| Import                    | 环境                                                       | 内容                                                                         |
| ------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `view_model`              | non-React/core                                             | 与 `view_model/core` 相同的公开 core surface。                               |
| `view_model/core`         | React Native plain owner、Electron main、test、共享 module | ViewModel class、Spec、Runtime、Binding、type 与 error。                     |
| `view_model/react-native` | React Native                                               | 全部 core export，加上 React Native Scope、hooks 与 AppState adapter。       |
| `view_model/electron`     | Electron renderer                                          | 全部 core export，加上 Electron renderer Scope、hooks 与 lifecycle adapter。 |

package 有意不导出 `view_model/react`。内部 React implementation 只由两个 platform adapter 共享，不构成通用 React Web contract。

## Core 架构

Runtime 是应用 DI 与生命周期边界。Binding 是 Runtime 内的 owner。platform Scope 只负责创建 React Binding，并将其提供给 platform hooks。

```text
ViewModelRuntime
├── ViewModelBinding (plain owner)
├── ViewModelBinding (React Scope owner)
└── ViewModel generation
    └── ViewModelBinding (generation-owned dependency owner)
```

Keyed identity 与 Runtime pause 都局限在 Runtime 内。不同 Runtime object 或 Electron process 之间不会共享受管理 identity。

## `ViewModel`

所有受管理 module 都继承 abstract `ViewModel` base class：

```ts
import { ViewModel, viewModelSpec } from 'view_model/core';

class CounterViewModel extends ViewModel {
  public count = 0;

  public increment(): void {
    this.update('counter.increment', () => {
      this.count += 1;
      this.notifyListeners();
    });
  }
}

export const counterSpec = viewModelSpec(() => new CounterViewModel());
```

### 公开属性

#### `version: number`

当前 notification version。每次通过存活检查的 `notifyListeners` 调用都会在 delivery 前递增它，即使 listener 随后抛错也一样。

#### `isDisposed: boolean`

当前 generation 是否已经永久结束。dispose 后，大多数 ViewModel 操作会抛出 `ViewModelDisposedError`。

#### `isPaused: boolean`

所属 Runtime 当前是否 paused。Pause 会影响该 Runtime 中所有已 activate generation。

#### `viewModelBinding: ViewModelBinding`

attach 到该 ViewModel generation 的稳定 dependency Binding。实例 attach 并 activate 后，可在 getter-based module dependency 中使用：

```ts
class CheckoutViewModel extends ViewModel {
  private get cart(): CartViewModel {
    return this.viewModelBinding.read(cartSpec);
  }
}
```

Runtime attach 前访问会抛出 `UnmanagedViewModelError`。dispose 后访问会抛出 `ViewModelDisposedError`。不要从 constructor、React render、JSX 或 selector 访问 dependency getter。

### Subscription

#### `subscribe(listener): ViewModelDispose`

为普通 ViewModel 通知安装 direct listener，并返回 unsubscribe function：

```ts
const unsubscribe = viewModel.subscribe(() => {
  refreshExternalConsumer();
});

unsubscribe();
```

Direct subscription 不由 Binding 持有，也不会被 Runtime pause 延迟。应保存并调用返回的 cleanup，或将它注册到另一个受管理 owner 的生命周期中。

### Protected notification methods

#### `notifyListeners(action?: unknown): void`

递增 `version`，通知 direct subscriber，然后进入 Runtime propagation transaction。listener failure 会被收集，并通过 `AggregateError` 重新抛出。

#### `update<TResult>(action: unknown, mutation: () => TResult): TResult`

为 `mutation` 内同步发出的通知附加 diagnostic action。嵌套调用结束时会恢复外层 action，并返回 mutation result。

`update` **不会**自动调用 `notifyListeners`：

```ts
this.update('profile.rename', () => {
  this.name = nextName;
  this.notifyListeners();
});
```

action scope 是同步的。不要期待 await 后的异步 continuation 仍处于该 scope；应向后续 `notifyListeners` 传显式 action，或使用 `StateViewModel.setState`/`updateState`。

#### `addDispose(dispose: ViewModelDispose): ViewModelDispose`

为 generation disposal 注册 cleanup。cleanup function 在 `onDispose` 后按注册顺序的逆序运行。返回的 function 只移除该 cleanup registration，不会执行 cleanup。

```ts
protected override onCreate(): void {
  const unsubscribe = nativeEvents.subscribe(this.handleNativeEvent);
  this.addDispose(unsubscribe);
}
```

#### `assertAlive(): void`

允许 subclass 将标准 disposed-generation guard 应用到自己的 method。

### Lifecycle hooks

subclass 可以 override：

```ts
protected onCreate(): void;
protected onBind(bindingId: string): void;
protected onUnbind(bindingId: string): void;
protected onPause(): void;
protected onResume(): void;
protected onDependencyNotify(child: ViewModel): void;
protected onDispose(): void;
```

- `onCreate` 在第一个已经 commit 的 acquire 时运行一次。
- `onBind` 在新的 Binding id 成为 generation owner 时运行。
- `onUnbind` 在该 id 释放 generation 时运行。
- `onPause` 与 `onResume` 跟随 Runtime-wide pause transition。
- watched child 通知被 parent 重新发送前，会运行 `onDependencyNotify`。
- `onDispose` 在 generation 永久结束时运行一次。

## `StateViewModel<TState>`

`StateViewModel` 在 `ViewModel` 基础上增加 immutable state snapshot 与 state-diff listener。

```ts
interface SessionState {
  readonly userId: string | undefined;
  readonly loading: boolean;
}

class SessionViewModel extends StateViewModel<SessionState> {
  public constructor() {
    super({ userId: undefined, loading: false });
  }

  public setLoading(loading: boolean): void {
    this.updateState((current) => ({ ...current, loading }), 'session.loading');
  }
}
```

### Constructor

```ts
protected constructor(
  initialState: TState,
  equals?: (left: TState, right: TState) => boolean,
)
```

默认 equality 是 `Object.is`。本库没有全局 equality configuration。

### `state: TState`

返回当前 immutable state snapshot。

### `subscribeState(listener): ViewModelDispose`

直接订阅 state transition。listener 会收到：

```ts
interface StateChange<TState> {
  readonly current: TState;
  readonly previous: TState;
}
```

返回的 unsubscribe function 必须显式管理。direct state listener 不会被 Runtime pause 延迟。

### `setState(nextState, action?): boolean`

Protected。当 configured equality 返回 false 时替换 state，通知 `subscribeState` listener，然后通知普通 ViewModel listener。发生 transition 时返回 `true`，因判等一致而抑制时返回 `false`。

### `updateState(updater, action?): boolean`

Protected。根据 current state 计算 next state，并委托给 `setState`。

## `ViewModelSpec<T>`

Spec 是稳定 builder 与 runtime identity token。

### 创建

```ts
const spec = new ViewModelSpec(() => new ExampleViewModel(), {
  key: 'example',
  aliveForever: false,
  debugLabel: 'ExampleViewModel',
});
```

helper 等价，并且通常更推荐：

```ts
const spec = viewModelSpec(() => new ExampleViewModel(), {
  key: 'example',
});
```

### `ViewModelSpecOptions`

```ts
interface ViewModelSpecOptions {
  readonly key?: ViewModelKey;
  readonly aliveForever?: boolean;
  readonly debugLabel?: string;
}
```

- `key` 让 token/key identity 能够由同一 Runtime 的多个 Binding 共享。
- `aliveForever` 跳过普通零 owner dispose，并要求显式 key。
- `debugLabel` 用于诊断与 generation description；它不参与 identity。

### Identity 属性

```ts
readonly token: symbol;
readonly builder: ViewModelBuilder<T>;
readonly key: ViewModelKey | undefined;
readonly aliveForever: boolean;
readonly debugLabel: string;
```

Runtime identity 为：

```text
unkeyed = Spec token inside one Binding
keyed   = Spec token + key inside one Runtime
```

TypeScript 泛型类型在运行时不存在。即使 builder 与 key 看起来完全一致，独立 Spec object 仍有独立 token。应在模块顶层声明 Spec。

### `withKey(key): ViewModelSpec<T>`

返回一个使用指定 key 的新 Spec wrapper，同时保留原 token、builder、retention option 与 debug label。

```ts
const baseSpec = viewModelSpec(() => new EditorViewModel());
const primaryEditorSpec = baseSpec.withKey('primary-editor');
```

builder 仍然不接受参数。`withKey` 只改变 identity，不会把 key 注入 constructor。

## `ViewModelRuntime`

`ViewModelRuntime` 是应用级受管理对象图，也是最大共享边界。

### 状态

```ts
readonly isDisposed: boolean;
readonly isPaused: boolean;
```

### `createBinding(options?): ViewModelBinding`

创建 plain owner Binding：

```ts
const runtime = new ViewModelRuntime();
const binding = runtime.createBinding({
  id: 'application-bootstrap',
  onUpdate: () => refreshOwner(),
});
```

`ViewModelBindingOptions` 包含可选 diagnostic `id` 与可选 broad `onUpdate` callback，后者供 imperative `watch` ownership 使用。

相比直接调用 Binding constructor，应优先使用 `runtime.createBinding`。

### `pause(token?: unknown): void`

添加一个 Runtime-wide pause reason。第一个 token 会将所有已 activate generation 转为 paused，并调用 `onPause`。

不传 token 调用 `pause()` 时，会使用一个共享 default token，因此重复默认调用不会形成计数器。独立 source 应提供各自稳定的 token object。

### `resume(token?: unknown): void`

移除一个 pause reason。只有移除最后一个 token 后，Runtime 才会 resume，随后调用 `onResume` 并 flush coalesced Binding callback。

移除不存在的 token 是 no-op。Runtime dispose 后调用 `resume` 也是 no-op。

### `recycle(target): number`

```ts
runtime.recycle(viewModel);
runtime.recycle(spec);
```

强制 dispose 匹配 generation，并返回成功 recycle 的数量。

- ViewModel target 选择一个具体 generation；
- Spec target 选择所有具有相同 token 与 key 的当前 handle；
- 因此，unkeyed Spec 可能匹配每个 Binding 各自的私有 generation；
- 当前 owner 与 `aliveForever` 都无法阻止 recycle。

owner callback 会感知 generation disposal，并在下一次 hook/snapshot 访问时解析 fresh generation。

### `dispose(): void`

以幂等方式结束 Runtime，并强制 dispose 所有剩余 generation，包括 `aliveForever` 实例。后续 acquire 会抛出 `ViewModelRuntimeDisposedError`。

对于 caller-owned Runtime，应先 dispose owner Binding，最后 dispose Runtime。

## `ViewModelBinding`

Binding 表示 Runtime 内的一个 owner。

### 构造与状态

```ts
const binding = runtime.createBinding({ id: 'owner-id' });

binding.id;
binding.runtime;
binding.isDisposed;
```

React 应用代码通常通过 platform Scope context 获得 Binding。Electron main、bootstrap code、service 与 test 会显式创建 plain Binding。

### `read(spec): T`

解析或创建 generation，并由该 Binding acquire，但不订阅 Binding 的普通 update callback。

```ts
const session = binding.read(sessionSpec);
await session.restore();
```

在 parent ViewModel 内，`read` 会建立 parent-to-child lifetime edge，但不会冒泡普通 child 通知。

### `watch(spec, listener?): T`

解析、acquire，并将 entry 标记为接收普通 update delivery：

```ts
const model = binding.watch(modelSpec);
```

若 Binding 创建时提供了 `onUpdate`，普通通知会调用该 callback。也可以提供可选 direct listener：

```ts
binding.watch(modelSpec, () => {
  refreshOwner();
});
```

可选 listener 会一直注册到当前 generation 或 Binding dispose；`watch` 不返回单 listener unsubscribe。不要从 render-like 或瞬时代码反复调用该 overload。

在 parent ViewModel 内，`watch` 还会通过 `onDependencyNotify(child)` 冒泡 child 通知，然后通知 parent。

### `dispose(): void`

以幂等方式移除 Binding 持有的所有 subscription，并释放每个已 acquire generation。普通零 owner cleanup 会延迟到 microtask，并可由立即 reacquire 取消。

dispose 后使用 `read`、`watch` 或 framework adapter method 会抛出 `ViewModelBindingDisposedError`。

### Framework adapter methods

导出的 class 包含若干标记为 `@internal` 的 platform hook implementation method：

```ts
prepare(spec): T;
subscribe(spec, mode, listener): ViewModelDispose;
getSnapshot(spec, mode): string;
```

- `prepare` 可以构造纯 provisional object，但不 acquire。
- `subscribe` 执行 commit-safe acquire，并安装一条 hook subscription。
- `getSnapshot` 向 `useSyncExternalStore` 暴露 version/generation identity。

普通应用代码不应基于这些 method 构建自定义 React integration。应使用受支持的 React Native 或 Electron platform hooks。

## React hooks

两个 platform entry 导出相同 hook API。

### `useViewModel(spec): T`

在 commit 中 acquire 当前 Scope Binding，并因普通通知与 generation replacement 而 rerender。

### `useReadViewModel(spec): T`

acquire 并保活 generation，但不因普通通知 rerender。generation dispose/recycle 仍会改变 snapshot。

### `useViewModelSelector(spec, selector, equals?): Selection`

订阅 ViewModel 通知，但只返回 selected value。默认 equality 是 `Object.is`。

selector 接收 ViewModel，而不仅仅是 `StateViewModel.state`，因此可以选择任何纯 exposed field。它不能修改、订阅、执行 I/O 或解析 child dependency。

### `useViewModelRuntime(): ViewModelRuntime`

返回当前 platform Scope Runtime。用于 infrastructure 与高级 integration。

### `useViewModelBinding(): ViewModelBinding`

返回当前 Scope Binding。不要在 render 中调用 imperative Binding resolution。

### Hook types

```ts
type ViewModelSelector<T extends ViewModel, Selection> = (viewModel: T) => Selection;

type ViewModelEquality<Selection> = (previous: Selection, next: Selection) => boolean;
```

## React Native API

`view_model/react-native` 重新导出所有 core symbol，并添加以下内容。

### `ViewModelScope`

```ts
interface ViewModelScopeProps extends PropsWithChildren {
  readonly runtime?: ViewModelRuntime;
  readonly appState?: ReactNativeAppState;
  readonly lifecycle?: ViewModelLifecycleSource;
}
```

- 没有 injected/parent Runtime 时，Scope 会创建并持有一个 Runtime；
- nested Scope 默认复用 parent Runtime，并创建新 Binding；
- `appState` 默认为 React Native `AppState`；
- 显式 `lifecycle` 会替代该 Scope 的 AppState lifecycle；
- lifecycle pause 影响选定的整个 Runtime。

### `createReactNativeAppStateLifecycleSource(appState)`

将最小 React Native AppState interface 转换为 `ViewModelLifecycleSource`。只有 `currentState === 'active'` 表示 active；其他所有值都表示 inactive。

### React Native lifecycle types

```ts
interface ReactNativeAppStateSubscription {
  remove(): void;
}

interface ReactNativeAppState {
  readonly currentState: string | null;
  addEventListener(
    type: 'change',
    listener: (state: string) => void,
  ): ReactNativeAppStateSubscription;
}

interface ViewModelLifecycleSource {
  isActive(): boolean;
  subscribe(listener: (active: boolean) => void): () => void;
}
```

## Electron renderer API

`view_model/electron` 重新导出所有 core symbol，并添加以下内容。

### `ViewModelScope`

```ts
interface ViewModelScopeProps extends PropsWithChildren {
  readonly runtime?: ViewModelRuntime;
  readonly lifecycle?: ElectronLifecycleSource;
}
```

默认 lifecycle 根据当前 renderer `window` 与 `document` 创建。注入的 Runtime 仍由调用方持有。

### `createElectronRendererLifecycleSource(target?)`

创建 focus-and-visibility lifecycle source。只有 window focused 且 document 不为 hidden 时，它才报告 active。

```ts
interface ElectronRendererLifecycleTarget {
  readonly window?: ElectronRendererWindow;
  readonly document?: ElectronRendererDocument;
}
```

最小 window surface 支持 `focus`/`blur` listener 安装与移除。最小 document surface 支持 `visibilityState`、可选 `hasFocus()` 与 `visibilitychange` listener。

### `ElectronLifecycleSource`

扩展内部 platform lifecycle contract：

```ts
interface ElectronLifecycleSource {
  isActive(): boolean;
  subscribe(listener: (active: boolean) => void): () => void;
}
```

## Core exported types

```ts
type ViewModelKey = string | number | symbol;
type ViewModelMode = 'watch' | 'read';
type ViewModelListener = () => void;
type ViewModelDispose = () => void;
type ViewModelBuilder<T extends ViewModel> = () => T;
type Equality<T> = (left: T, right: T) => boolean;
```

notification payload types：

```ts
interface ViewModelChange<TAction = unknown> {
  readonly action: TAction | undefined;
  readonly version: number;
}

interface StateChange<TState> {
  readonly current: TState;
  readonly previous: TState;
}

type StateListener<TState> = (change: StateChange<TState>) => void;
```

configuration types：

```ts
interface ViewModelBindingOptions {
  readonly id?: string;
  readonly onUpdate?: ViewModelListener;
}

interface ViewModelSpecOptions {
  readonly key?: ViewModelKey;
  readonly aliveForever?: boolean;
  readonly debugLabel?: string;
}
```

## 导出的 errors

所有 core error 都继承 `ViewModelError`：

| Error                           | 含义                                                                |
| ------------------------------- | ------------------------------------------------------------------- |
| `ViewModelError`                | package error 基类。                                                |
| `ViewModelDisposedError`        | 某个操作使用了 disposed ViewModel generation。                      |
| `ViewModelRuntimeDisposedError` | 某个操作需要已经 disposed 的 Runtime。                              |
| `ViewModelBindingDisposedError` | 某个操作需要已经 disposed 的 Binding。                              |
| `ViewModelSpecError`            | Spec/builder 或 generation preparation invariant 失败。             |
| `ViewModelDependencyCycleError` | 检测到直接或间接 dependency owner cycle；该 error 暴露 cycle path。 |
| `UnmanagedViewModelError`       | Runtime attach 前请求了 `viewModelBinding`。                        |

listener 与 cleanup failure 也可能通过标准 JavaScript `AggregateError` 报告，其中包含所有已收集 error。

## 不支持的 API 与环境

下列 import 有意不可用：

```ts
// Unsupported: no public Web/React entry point exists.
import { ViewModelScope } from 'view_model/react';
```

当前 package 不承诺：

- 普通 React Web 应用；
- SSR 或 hydration；
- React Server Components；
- browser-only lifecycle adapter；
- Flutter API，例如 tag lookup、cached lookup、argument Spec、global initialization/configuration、code generation 或 DevTools。

只应使用已经记录的 platform entry 与当前 TypeScript declaration。
