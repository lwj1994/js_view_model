# API 参考

[English](../api.md) · [Flutter 迁移](./flutter-comparison.md)

对齐新增能力尚未发布。从 npm 0.3.1 升级前请先阅读迁移说明。

## Package 入口

`@lwjlol/view_model` 与 `/core` 导出不依赖框架的 API。
`/react-native`、`/electron`、`/vue` 和 `/taro-vue` 重导出 core，并增加可选宿主适配。
没有公开 `/react` 入口，也不承诺 Web/SSR/RSC。下划线前缀和 `@internal` 成员属于实现细节，
即使在源码中可见，也不应由应用调用。

## `ViewModel`

继承该类。构造函数和 builder 必须纯净，资源在 protected `onCreate` 中获取。
公开属性包括 `version`、`isDisposed`、`isPaused`、`hasListeners`、`key`、`tag`、
`instanceInfo`、快照 `bindingIds`，以及 generation 持有的稳定 `viewModelBinding`。
尚未托管时 `instanceInfo` 为 undefined。未托管或销毁后的 `viewModelBinding` 会抛错；
通过 getter 在 commit 后解析依赖，不能在 render 中解析。

### 更新与监听

```ts
vm.notifyListeners('refresh');
vm.update(() => {
  /* mutate fields */
});
vm.update('action', () => {
  /* mutate fields */
});
await vm.update('async action', async () => {
  /* await work, then mutate */
});
const unsubscribe = vm.listen(() => {
  /* business reaction */
});
const unsubscribeAlias = vm.subscribe(() => {
  /* direct subscription */
});
vm.addListener(callback);
vm.removeListener(callback);
const cancelCleanup = vm.addDispose(cleanup);
```

`update` 返回操作结果，Promise 在最终通知后完成。同步成功在返回前通知，异步成功在完成后通知。
操作失败不发最终通知，但不会回滚之前的写入。不要在操作内添加重复 notify。
嵌套调用会恢复外层同步 action 上下文。

`notifyListeners` 递增 version，同步通知直接监听器；已移除监听跳过，投递中新增的监听等待下一事件。
原始 `addListener` 允许重复，`removeListener` 每次移除一个；每个 `subscribe/listen` 的取消函数
独立移除自己的登记。菱形依赖逐条转发事件，同步级联只合并根 Binding 刷新请求。
宿主订阅在 transaction 结束采样最终快照，业务监听保留每条事件。异步新事件开启新 transaction。

`addDispose` 注册在 `onDispose` 后逆序执行的清理，返回函数只取消登记。
通知、生命周期和清理异常通过配置安全报告，剩余监听和清理继续执行。
销毁后的 notify 被忽略；新订阅、`addDispose`、依赖解析和 `update` 拒绝已销毁实例。

### 生命周期 hook

```ts
protected onCreate(): void;
protected onBind(bindingId: string): void;
protected onUnbind(bindingId: string): void;
protected onDispose(): void;
protected onPause(): void;
protected onResume(): void;
protected assertAlive(): void;
```

不再提供 `onDependencyNotify`。watch 自动转发 child 事件，业务逻辑使用 Binding 的 `listen`。
每条精确 owner 登记分别计数，同一逻辑 ID 首 source 触发 bind，末 source 触发 unbind。
回调重入不会误删替代登记。`onCreate/onBind` 失败只报告，不自动回滚有效 owner；
如果 hook 确实移除了 owner，解析会拒绝过期登记。
Hook 是同步的，Runtime 不等待意外返回的 Promise。

## 配置与生命周期观察者

```ts
ViewModel.initialize({
  config: {
    equals: Object.is,
    isLoggingEnabled: false,
    onError: (error, type, context) => {
      reportError(error, type, context);
    },
    onWarning: (message) => {
      recordWarning(message);
    },
  },
  lifecycles: [observer],
});
const remove = ViewModel.addLifecycle(observer);
ViewModel.removeLifecycle(observer);
const config = ViewModel.config;
ViewModel.reset();
```

同一 JS realm 在 reset 前只初始化一次。观察者可实现
`onCreate(vm, info)`、`onBind(vm, info, id)`、`onUnbind(vm, info, id)`、`onDispose(vm, info)`。
`ViewModelInstanceInfo` 包含 key、tag、aliveForever、generation、debugLabel 和显式 type。
`ErrorType` 为 `listener | lifecycle | dispose | pauseResume`。
默认错误写入 console；自定义接收器抛错也不能中断所有权或清理。
日志开关用于 factory/tag 歧义提示，不会关闭错误报告。

`ViewModel.reset()` 销毁所有已登记 Runtime 的 generation（包括保活实例），清除暂停、配置和观察者，
但保留可复用根 Binding。`runtime.reset()` 只重置该 Runtime，保留全局配置。
reset 期间拒绝重入创建。手动 override 仍须调用恢复函数。
ESM/CJS 入口在同一 realm 内共享配置和 reset。

## `StateViewModel<TState>`

```ts
protected constructor(initialState: TState, equals?: Equality<TState>);
protected setState(next: TState, action?: unknown): boolean;
protected updateState(updater: (state: TState) => TState, action?: unknown): boolean;
protected onError(error: unknown): void;
```

`state`、`initialState`/`initState`、`previousState` 提供状态快照；首次成功替换前 previous 为 undefined。
判等顺序是构造函数显式 comparator、`ViewModel.config.equals`、`Object.is`，推荐不可变替换。
判等异常保持状态不变，调用 `onError`（默认交给统一错误报告）。
销毁后的状态方法返回 false，且不执行 updater。

```ts
const stop1 = vm.listenState((previous, current) => {
  /* real state transition */
});
const stop2 = vm.listenStateSelect(selector, (previous, current) => {}, Object.is);
const stop3 = vm.subscribeState(({ previous, current }) => {
  /* legacy object payload */
});
```

`StateChangeListener<T>` 为 `(previous: T, current: T) => void`，T 本身可以 nullable。
`StateListener<T>` 保留 `subscribeState` 使用的 `StateChange<T>` 对象。
状态事件重入时按 FIFO 投递：所有监听先完成旧事件，再接收嵌套新事件。
存储状态立即改变，判断当前事件请使用回调参数，而非重新读取 state。
普通 notify 不重放 state diff。选择判等同样采用显式/全局/`Object.is`。
直接订阅需要自行持有取消函数，不受界面暂停影响。

## `ViewModelSpec<T>` 与 family

```ts
const spec = viewModelSpec(CounterViewModel, () => new CounterViewModel(), {
  key: 'counter',
  tag: 'counters',
  aliveForever: false,
  debugLabel: 'counter',
  debugSource: stableFactoryIdentity,
});
const alternativeSyntax = new ViewModelSpec(CounterViewModel, () => new CounterViewModel());
const keyed = spec.withKey('another-counter');
const byId = ViewModelSpec.arg(UserViewModel, (id: string) => new UserViewModel(id), {
  key: (id) => id,
  tag: () => 'users',
  aliveForever: () => false,
});
const concrete = byId('ada');
```

`arg2/arg3/arg4` 提供对应数量的类型化 builder 参数与选项函数。
同一 Runtime 内显式类 + 有效 key 决定身份；unkeyed 私有于 Binding。
参数、tag、debugLabel、debugSource 都不参与身份，后来的 builder 不会替换命中实例。
`debugSource` 仅区分声明并产生诊断；family 共享同一 source。
key 可为 string、number、symbol、boolean、bigint 或 object；对象按引用相等。
undefined 表示 unkeyed，null 被拒绝；aliveForever 必须有显式 key。

仍支持 builder-only overload，但每个基础 Spec 使用私有 token，推荐显式类声明。
`withKey` 保留类型/token 与选项，override 角度则是独立具体声明。

### 覆盖

```ts
const restore = spec.overrideWith(replacementSpec);
try {
  binding.read(spec);
} finally {
  restore();
}
await spec.runWithOverride(replacementSpec, async (runtime) => {
  const binding = runtime.createBinding();
  await prepareFixture();
  binding.read(spec);
});
await ViewModelRuntime.runWithOverrides([[spec, replacementSpec]], async (runtime) => {});
await parentRuntime.runWithOverrides([[spec, replacementSpec]], async (runtime) => {});
```

family 支持同样的 helper，参数类型须匹配。
手动覆盖在当前 realm 全局生效，支持堆叠、幂等恢复和乱序恢复。
`setProxy/clearProxy` 是已弃用的兼容 fallback，覆盖环会在构造前拒绝。
保留原始显式类身份，builder/key/tag/保活策略来自替代声明；既有 generation 不变。
异步 helper 创建并传入隔离 Runtime，快照继承的覆盖，最终自动销毁，不安装隐式异步上下文。
await 前后都必须使用传入 Runtime，详见[迁移边界](./flutter-comparison.md)。

## `ViewModelRuntime`

`new ViewModelRuntime({ overrides?, inheritGlobalOverrides? })` 定义缓存/依赖图和暂停边界。
overrides 为 `[source, replacement]` 的 iterable，默认也可见全局覆盖。
手动创建的 Runtime 由调用方负责 dispose。

| 成员                                | 约定                                                      |
| ----------------------------------- | --------------------------------------------------------- |
| `createBinding({ id?, onUpdate? })` | 稳定生命周期 owner；onUpdate 是刷新请求，不是每条业务事件 |
| `isDisposed`、`isPaused`            | Runtime 状态                                              |
| `pause(token?)`、`resume(token?)`   | 聚合应用/窗口暂停原因，边界变化才触发 VM hook             |
| `recycle(vmOrSpec): number`         | 为所有 owner 强制销毁匹配 generation，包括保活实例        |
| `reset()`                           | 清空 generation 和暂停，不结束可复用根 Binding            |
| `dispose()`                         | 永久结束 Runtime，后续解析失败                            |
| `maybeReadCached(target, lookup?)`  | 不持有所有权的查询，缺失为 undefined，不构造              |
| `readCached(target, lookup?)`       | 不持有所有权的查询，缺失抛错                              |
| `readCachesByTag(target, tag)`      | 不持有所有权，最新创建优先                                |
| `countInstances(target?, lookup?)`  | 当前 generation 数量，可按 type/key/tag 过滤              |
| `getDiagnostics()`                  | 实例元数据、owner、source 计数与依赖边快照                |

Spec recycle 目标按有效覆盖身份匹配，unkeyed 可匹配每个 Binding 的私有 generation。
销毁前先移除 cache，独占 child 完成清理后才触发替代刷新。
Runtime 查询**不会** bind 或保活；需要持有依赖时使用 Binding 查询。
查询目标为 Spec 时仅提供 type/token，key/tag 要在 lookup 显式指定。
优先查 key，只有 key 不存在才回退 tag；两者都省略时返回最新创建，而非最近读取的实例。
tag 按身份比较，不做强制字符串转换。

## `ViewModelBinding`

`id`、`runtime`、`isDisposed`、`isPaused` 描述 owner。
`read(spec)` 和 `watch(spec, listener?)` 都获取所有权，只有 watch 转发普通通知。
read 升级 watch 不重建实例，后续 read 不会降级 watch。
依赖与所有权保留到 unbind、recycle 或 dispose，不依赖下一次 render/build。

`watch(spec, listener)` 与 `onUpdate` 是界面刷新回调，按 transaction 合并并受界面暂停控制。
逐条业务事件请使用 listen，不要用 watch 的可选 callback。

```ts
const stop = binding.listen(spec, () => {});
const stopState = binding.listenState(stateSpec, (previous, current) => {});
const stopSelect = binding.listenStateSelect(
  stateSpec,
  selector,
  (previous, current) => {},
  Object.is,
);
binding.unbind(vmOrSpec);
binding.recycle(vmOrSpec);
binding.pause();
binding.resume();
binding.dispose();
```

`listen*` 获取 read owner，不隐式增加 broad watch，业务回调不受界面暂停抑制。
取消函数、精确 owner 登记结束或 generation 结束都会移除监听。
unbind 只释放当前 Binding 的登记，recycle 影响同 Runtime 全部 owner。
局部 pause/resume 只延迟该 Binding 的界面刷新，不触发 VM 暂停 hook，不影响其他 owner。
自然末 owner 释放延迟到 microtask，强制 recycle/reset/dispose 同步完成。

### 持有所有权的缓存查询

`readCached/watchCached(target, lookup?)`、`maybeReadCached/maybeWatchCached(target, lookup?)`、
`readCachesByTag/watchCachesByTag(target, tag)` 不执行 builder，但命中**会**获取所有权、建立 parent edge。
只有 watch 变体转发普通通知；maybe 仅对缺失返回 undefined，依赖环和 owner 错误仍抛出。
批量查询先预检整个图，再获取所有权，最后升级 watch。失败只回滚本次精确新增登记，不删除重入替代登记。

### 宿主适配方法

`prepare(spec)` 只创建 provisional 纯对象，不运行 owner hook。
`subscribe(spec, mode, listener)` 在 commit 获取所有权，取消仅移除订阅，不释放 Binding owner。
`getSnapshot(spec, mode)` 组合 generation 与 version（watch）或 lifecycle（read）。
应用代码优先使用 read/watch 或平台适配，不直接使用这些内部宿主机制。

## React hooks

两个 platform entry 导出相同 hook API。

Scope 是 owner 边界：同一 Scope 下的所有 hook 共享它的 Binding。单个 hook subscription 可以独立 unmount，但 ViewModel ownership 会保留到该 Scope Binding 释放 generation 或 Scope dispose。React render 只能 prepare provisional object；commit 才建立 ownership 并执行 lifecycle acquire。

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

`@lwjlol/view_model/react-native` 重新导出所有 core symbol，并添加以下内容。

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

`@lwjlol/view_model/electron` 重新导出所有 core symbol，并添加以下内容。

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

## Vue 与 Taro

Vue 返回 raw VM 的响应式 ref，Taro 复用该桥接并处理页面生命周期，详见 [Vue/Taro 指南](./vue-taro.md)。

## 导出的错误

`ViewModelError`、`ViewModelDisposedError`、`UnmanagedViewModelError`、`ViewModelRuntimeDisposedError`、
`ViewModelBindingDisposedError`、`ViewModelDependencyCycleError`、`ViewModelSpecError` 用于同步校验错误。
通知、生命周期与清理错误走 `config.onError`。运行时专属边界见 [Flutter 对照](./flutter-comparison.md)。
