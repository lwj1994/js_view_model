# 生命周期、React commit 与 StrictMode

[English](../lifecycle.md) · [文档索引](./README.md)

> 本指南描述 React Native 与 Electron 应用中正式支持的生命周期行为。

生命周期在两个相互关联的层级管理：

- `ViewModelRuntime` 持有 generation、依赖边与 Runtime-wide pause 状态；
- 每个 `ViewModelBinding` 提供一条 owner relationship，并在 Binding dispose 时释放它。

React `ViewModelScope` 通过创建一个 Binding，将一棵子树适配到该模型。除非 Scope 同时获得一个独立 Runtime，否则它并不是独立 DI 容器。

## 生命周期总览

一个普通 React-managed generation 会经历以下流程：

```text
stable ViewModelSpec
  -> render calls prepare
  -> pure builder and constructor may create a provisional generation
  -> Runtime attaches the generation to its dependency Binding
  -> hook subscribe runs during commit
  -> Scope Binding acquires the generation
  -> onCreate()
  -> onPause() if the Runtime is already paused
  -> onBind(bindingId)
  -> notifications, state changes, and dependency propagation
  -> hook cleanup removes only that hook subscription
  -> Scope cleanup disposes its Binding
  -> onUnbind(bindingId)
  -> final owner leaves
  -> deferred zero-owner disposal
  -> onDispose()
  -> registered cleanup functions in reverse order
```

只有 generation 被强制 recycle，或其 Runtime 被 dispose 时，流程才会改变。这些操作即使在普通生命周期规则会让 generation 继续存活时，也会移除所有 owner 并结束 generation。

## 构造是 provisional 的

`binding.prepare(spec)` 是 platform hooks 使用的 render-safe planning 操作。它可能执行 Spec builder 与 ViewModel constructor，但不会：

- acquire Binding owner；
- 调用 `onCreate`；
- 调用 `onBind`；
- 建立已经 commit 的 parent-to-child owner edge。

因此，builder 与 constructor 必须只负责纯对象构造。它们可以初始化内存字段，但不能启动：

- network request 或 socket；
- timer 或 background loop；
- Electron IPC subscription；
- React Native native-module subscription；
- file handle、port 或 database transaction；
- child ViewModel 解析。

应在 `onCreate` 或 commit 后调用的 action 中启动正式资源，并通过 `addDispose` 注册确定性的清理。

```ts
class ConnectionViewModel extends ViewModel {
  protected override onCreate(): void {
    const subscription = connectionEvents.subscribe(() => {
      this.notifyListeners('connection-event');
    });

    this.addDispose(() => subscription.unsubscribe());
  }
}
```

如果 render 创建了 provisional generation，但从未 commit，Runtime 会在下一个 microtask 安排该零 owner generation 的清理。该规则也适用于 `aliveForever`：被放弃的 render 不是合法的永久 owner。

如果 provisional generation 已被清理后 React 才尝试 commit，generation snapshot 会发生变化。hook 会重新 prepare，并同步订阅当前 generation，而不会保留被放弃的对象。

## Render 与 commit 是不同阶段

React 可能重放、中断或放弃 render。只有 commit 阶段安装的 `useSyncExternalStore` subscription 才会 acquire Scope Binding 的 owner relationship。

platform hooks 按下表分离两个阶段：

| 阶段                   | 允许的行为                                                                   |
| ---------------------- | ---------------------------------------------------------------------------- |
| render / snapshot read | 纯 Spec preparation，以及从 parent ViewModel 已暴露数据中进行纯 selection。  |
| commit subscription    | acquire owner、activate generation、运行 `onCreate`、运行 `onBind`。         |
| effect/Scope cleanup   | 移除 hook listener；owner boundary 真正 unmount 时再 dispose Scope Binding。 |

parent ViewModel 的 dependency getter 不是 render-safe 的。它会调用 `viewModelBinding.read/watch`，而这会执行真实 acquire。不要从 JSX、component render 或 `useViewModelSelector` selector 中读取该 getter。应让 parent 暴露 UI 需要的 derived state。

## Scope Binding 生命周期与 hook subscription 生命周期

每个 Scope 都有一个稳定 Binding。该 Scope 下的所有 hooks 都通过同一个 owner acquire：

```text
ViewModelScope
└── one ViewModelBinding
    ├── useViewModel(spec) subscription
    ├── useReadViewModel(spec) lifecycle subscription
    └── useViewModelSelector(spec, selector) subscription
```

移除单个 hook 只会移除其 subscription record，不会释放 Binding 已 acquire 的 ViewModel entry。owner relationship 会一直保留到：

- Scope Binding 被 dispose；
- Runtime 强制 recycle generation；
- Runtime 本身被 dispose。

这使 Scope 成为稳定的 React owner adapter，避免普通 component 变化反复销毁应用模块。如果某个功能需要独立 owner 生命周期，应建立有意的 Binding 边界。nested Scope 会创建新 Binding，但除非注入不同 Runtime，否则仍共享 parent Runtime。

## StrictMode 行为

React StrictMode 在开发环境中可能执行额外 render，以及 effect `setup -> cleanup -> setup` 序列。`view_model` 不会把这种 probe cleanup 当成真正的应用 shutdown：

1. render preparation 不会 activate 或 bind provisional generation；
2. 第一个已经 commit 的 hook subscription 执行 acquire；
3. Scope cleanup 延迟一个 microtask；
4. 对应的 StrictMode setup 取消 pending Binding disposal；
5. 真正 unmount 不会取消该任务，因此会释放 Binding；
6. root Scope 自己持有的 Runtime 再延迟一个 microtask dispose，让共享它的 nested Binding 先完成释放。

lifecycle source 移除 pause token 时使用类似的可取消 microtask。这样，当应用实际仍处于 inactive 时，StrictMode cleanup/setup probe 不会制造虚假的 `onResume -> onPause` transition。

应用代码仍必须保持幂等。不要根据 StrictMode 中观察到的 constructor 调用次数推断生产环境 instance 数量，并确保每个外部资源都有清理路径。

## Activation 与 Binding callbacks

ViewModel hooks 具有精确语义：

### `onCreate()`

在第一个 Binding acquire provisional generation 时运行一次。此时对象已经 attach 到 generation-owned dependency Binding，因此可以使用 getter-based dependency resolution。

如果 `onCreate` 抛错，acquire 会失败；Runtime 会 dispose 失败的 generation 及其 dependency scope，然后重新抛出错误。

### `onBind(bindingId)`

当某个 Binding id 首次成为 generation owner 时运行。keyed generation 可以从 React Scope、plain Binding 或 parent dependency Binding 获得多个 id。

### `onUnbind(bindingId)`

当该 Binding id 释放 generation 时运行。这不表示 generation 即将 dispose：其他 Binding 可能仍持有它，或者它可能由 `aliveForever` 保留。

### `onPause()` 与 `onResume()`

只在 Runtime 于 active 与 paused 之间 transition 时运行。多个 pause token 会聚合，因此添加第二个 token 不会再次调用 `onPause`，移除多个 token 中的一个也不会调用 `onResume`。

### `onDispose()`

在当前 generation 永久结束时运行一次。此时 ViewModel 已经标记为 disposed，因此不能再解析新依赖或发送新 state。

`onDispose` 之后，通过 `addDispose` 注册的 cleanup function 会按注册顺序的逆序运行。Runtime 会尝试所有清理路径，并通过 `AggregateError` 聚合多个失败，而不是因一个错误放弃剩余清理。

## 自然零 owner 销毁

Binding 释放普通 generation 时，Runtime 会先调用 `onUnbind`。若不再有 owner 且 `aliveForever` 为 false，dispose 会进入 microtask 队列。

这次短暂延迟允许对同一 generation 的立即 reacquire 取消 pending disposal。它不会让实例普遍变成长生命周期：若没有 owner 回来，generation 会从 cache 中移除并被 dispose。

parent generation dispose 时，也会 dispose 它的 generation-owned dependency Binding。所有只由该 Binding 持有的 child edge 都会释放。keyed child，或同时由其他 parent/direct Binding 持有的 child，可以继续存活。

`aliveForever` generation 会跳过自然零 owner dispose，但显式 recycle 或 Runtime dispose 仍会结束它。

## 通知与 generation snapshot

`notifyListeners(action?)` 会递增 ViewModel version，并同步进入 Runtime propagation transaction。在同一个 transaction 中，Runtime 会去重：

- 同一 handle 的重复通知 delivery；
- parent dependency bubbling；
- 同一个 queued owner callback。

`watch` snapshot 包含 ViewModel version。`read` snapshot 只包含 generation/lifecycle identity。因此：

- `useViewModel` 会因普通通知而 rerender；
- `useReadViewModel` 不会因普通通知而 rerender；
- force recycle 改变 generation，因此两个 hooks 都会更新；
- `useViewModelSelector` 会抑制判等一致的 selected value，但新 generation 仍会强制执行一次 resubscription update。

`ViewModel.subscribe` 与 `StateViewModel.subscribeState` 是 direct subscription。它们由 ViewModel 自己调用，不会自动归属于 Binding。应保存返回的 unsubscribe function，并显式清理。

## Runtime 级 pause token

Pause 是 `ViewModelRuntime` 的属性，不属于 Scope 或单个 ViewModel owner。

```ts
const applicationBackground = Symbol('application-background');
const rendererHidden = Symbol('renderer-hidden');

runtime.pause(applicationBackground);
runtime.pause(rendererHidden);
runtime.resume(applicationBackground); // Still paused by rendererHidden.
runtime.resume(rendererHidden); // Now the Runtime resumes.
```

第一个 token 触发 active-to-paused transition，并对所有已 activate generation 调用 `onPause`。移除最后一个 token 时调用 `onResume`，并 flush queued Binding/hook callbacks。

paused 期间：

- state 与 ViewModel action 可以继续运行；
- ViewModel version 会继续变化；
- parent dependency propagation 可以继续；
- Binding-delivered owner callback 会 coalesce 到 resume；
- direct `subscribe`/`subscribeState` callback 不受 Runtime pause 影响。

这个区别可以阻止后台 UI 反复更新，但不会伪装成应用对象图已经停止执行。

每个 lifecycle source 都必须在其 subscription 生命周期内保持一个稳定 token。cleanup 只移除自己的 token，不能让仍被其他 source pause 的 Runtime 意外恢复。

### Scope lifecycle 影响整个 Runtime

`ViewModelScope.lifecycle` 是对 `runtime.pause(token)` 与 `runtime.resume(token)` 的 adapter。共享 parent Runtime 的 nested Scope 不会获得隔离的 pause state。一旦其 lifecycle 变为 inactive，该 Runtime 中所有已 activate ViewModel 都会 pause。

对于页面 focus，应明确选择：

- 如果整个页面对象图应独立 pause，使用独立 Runtime；
- 如果只应改变页面特定工作，保留一个 application Runtime，并将 focus 建模为普通 state；
- 只有明确要 pause 整个应用对象图时，才对共享 Runtime 使用 lifecycle source。

## React Native 生命周期

React Native Scope 会将 `AppState` 转换为 lifecycle source：

- `active` 表示 active；
- `inactive`、`background`、`unknown` 与其他任何值都表示 inactive。

因此，应用离开前台时，root Scope 的 lifecycle token 会 pause 整个 root Runtime。React Navigation blur 不等于 unmount，也不会被自动纳入。

## Electron renderer 生命周期

Electron renderer source 只有在下列两个条件同时满足时，才认为 Runtime active：

- renderer window 处于 focused；
- `document.visibilityState` 不是 `hidden`。

window blur 或 document hidden 都会 pause Runtime。只有 focus 与 visibility 同时恢复 active 才会 resume。如果 `window` 与 `document` 都不可用，默认 source 会保持 active 且不安装 listener。

Electron main 没有 React lifecycle adapter。若需要相同行为，其 owner 必须根据明确的 application event 调用 `runtime.pause/resume`。

## 强制 recycle

`runtime.recycle(viewModel)` 会结束一个具体 generation。`runtime.recycle(spec)` 会结束该 Runtime 中所有具有相同 Spec resolved identity 与 key 的当前 handle。显式 type Spec 共享 type identity，builder-only Spec 则使用兼容 token；因此，一个 unkeyed Spec 可能会 recycle 每个 Binding 各自的私有 generation。

Recycle 会：

1. 将 generation 标记为 disposed，并从 cache 移除；
2. 对每个当前 owner 调用 `onUnbind`；
3. 运行 `onDispose` 与已注册 cleanup；
4. dispose 旧 dependency Binding 并释放 child edge；
5. 通知仍存活的 owner Binding，其 handle 已经结束；
6. 让下一次稳定 Spec 解析创建 fresh generation。

旧 generation 会在 owner 解析新 generation 之前完整清理。这可以避免新旧对象同时持有相同 IPC channel、native subscription、port 或其他独占资源。

Recycle 会忽略普通 ownership 与 `aliveForever`，因此只能用于有意的共享失效。当新旧 generation 应在过渡期并存时，优先使用新的业务 key。

## Runtime 与应用 shutdown

`runtime.dispose()` 是最终边界操作。它会：

- 将 Runtime 标记为 disposed；
- 清除 pause state 与 queued resume callback；
- 强制 dispose 所有 generation，包括 `aliveForever` 实例；
- 清除 keyed cache 与 dependency edge；
- 拒绝后续创建或 acquire。

对于注入的 Runtime，application composition root 应先 dispose React owner Binding，最后 dispose Runtime。自行创建 Runtime 的 root Scope 会自动保证该顺序。

Electron main 应使用显式 shutdown 路径：

```ts
const runtime = new ViewModelRuntime();
const binding = runtime.createBinding({ id: 'electron-main' });

app.on('before-quit', () => {
  binding.dispose();
  runtime.dispose();
});
```

两个操作都是幂等的。cleanup implementation 也应保持幂等。
