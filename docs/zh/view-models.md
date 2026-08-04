# ViewModel 与 State

[English](../view-models.md)

ViewModel 是由 `ViewModelRuntime` 管理的有状态应用对象。它可以表示 UI state，也可以表示应用 session、设备连接、repository coordinator、后台同步器、Electron main 进程 service，或任何具有明确生命周期的有状态模块。

React 不属于基础 `ViewModel` contract。React Native 与 Electron renderer hook 只是同一套核心通知与 owner 模型之上的 adapter。

## `ViewModel`

模块需要自定义字段或通知行为时，继承 `ViewModel`。

```ts
import { ViewModel, viewModelSpec } from '@lwjlol/view_model/core';

class ConnectionViewModel extends ViewModel {
  #status: 'disconnected' | 'connecting' | 'connected' = 'disconnected';

  public get status(): 'disconnected' | 'connecting' | 'connected' {
    return this.#status;
  }

  public connect(): void {
    if (this.#status !== 'disconnected') return;

    this.update('connection.connect', () => {
      this.#status = 'connecting';
      this.notifyListeners();
    });
  }
}

export const connectionSpec = viewModelSpec(() => new ConnectionViewModel());
```

公开实例提供：

- `version`：一个存活实例每次开始执行 `notifyListeners` 通知投递时递增，即使某个 listener 随后抛错也不会回滚；
- `isDisposed`：当前 generation 是否已经结束；
- `isPaused`：所属 Runtime 是否已进入 paused 状态；
- `subscribe(listener)`：直接订阅实例，并返回 unsubscribe function。

子类使用以下 protected method 与 callback：

- `notifyListeners(action?)`；
- `update(action, mutation)`；
- `addDispose(cleanup)`；
- `assertAlive()`；
- 下文介绍的生命周期 callback。

### `update` 不会自动通知

`update(action, mutation)` 只为 `mutation` 内同步发出的通知建立 action context。它不会检测字段变化，也不会自动调用 `notifyListeners`。

这是正确写法：

```ts
public rename(name: string): void {
  this.update('profile.rename', () => {
    this.#name = name;
    this.notifyListeners();
  });
}
```

下面的写法会静默修改字段，通常是 bug：

```ts
public renameSilently(name: string): void {
  this.update('profile.rename', () => {
    this.#name = name;
  });
}
```

嵌套 `update` 在内部 mutation 返回后，会恢复外层 action context。action context 是同步的；不要用 `update` 包住长时间异步操作。应先完成异步工作，再用 `update` 或 state method 包围每次同步 commit。

### 通知失败

ViewModel 在投递通知前递增 version。即使一个 listener 抛错，它仍会尝试通知所有直接 listener 与 Runtime，最后把收集到的失败报告为 `AggregateError`。

不要把 listener 抛错当成 state commit 已回滚的证据。通知投递不是 state transaction rollback 机制。

## `StateViewModel<State>`

不可变 snapshot 优先使用 `StateViewModel`。

```ts
import { StateViewModel, viewModelSpec } from '@lwjlol/view_model/core';

type ProfileState = Readonly<{
  displayName: string;
  saving: boolean;
}>;

class ProfileViewModel extends StateViewModel<ProfileState> {
  public constructor() {
    super({ displayName: '', saving: false });
  }

  public setDisplayName(displayName: string): boolean {
    return this.updateState((current) => ({ ...current, displayName }), 'profile.set-display-name');
  }

  public replace(state: ProfileState): boolean {
    return this.setState(state, 'profile.replace');
  }
}

export const profileSpec = viewModelSpec(() => new ProfileViewModel());
```

protected update method 会返回 state 是否发生变化：

- `setState(nextState, action?)` 比较并替换 snapshot；
- `updateState(updater, action?)` 计算下一个 snapshot，然后委托给 `setState`。

默认 equality 是 `Object.is`。原地修改对象并传入同一个引用不会发出通知：

```ts
// Do not do this.
const sameObject = this.state;
sameObject.items.push(item);
this.setState(sameObject); // Object.is sees the same reference.
```

应改为不可变替换：

```ts
this.updateState((current) => ({
  ...current,
  items: [...current.items, item],
}));
```

子类可以向 `super(initialState, equals)` 传入自定义 equality function。equality function 必须是确定性的，而且执行成本应足够低，因为每次尝试替换 state 都会调用它。

### React 之外的 state 订阅

`subscribeState` 报告前后两个 snapshot，并返回 unsubscribe function：

```ts
const unsubscribe = profile.subscribeState(({ previous, current }) => {
  auditProfileChange(previous, current);
});

// Later:
unsubscribe();
```

`subscribeState` 是直接实例订阅。Runtime pause 不会延迟它。plain host 如果需要感知 pause 的 render scheduling，应改用带 `onUpdate` 的 watched Binding。

## Construction 必须保持纯净

React render 期间可能运行 Spec builder 与 ViewModel constructor。并发或 Suspense render 可能被放弃，其 provisional generation 可能在从未 activate 的情况下被清理。

安全的 constructor 工作包括：

- 赋值 primitive value 与不可变 initial state；
- 保存注入的 plain object 或 Spec；
- 创建无需外部 cleanup 的内存 collection。

不安全的 constructor 工作包括：

- timer；
- 网络、数据库、IPC 或设备连接；
- event 或原生订阅；
- file handle；
- 通过 Binding 解析另一个 ViewModel；
- dispatch 应用 action。

应在 `onCreate` 中获取资源，并立即登记 cleanup。

## 资源生命周期

```ts
interface FeedPort {
  subscribe(listener: (items: readonly string[]) => void): () => void;
  pause(): void;
  resume(): void;
}

class FeedViewModel extends StateViewModel<readonly string[]> {
  public constructor(private readonly feed: FeedPort) {
    super([]);
  }

  protected override onCreate(): void {
    const unsubscribe = this.feed.subscribe((items) => {
      this.setState(items, 'feed.items');
    });
    this.addDispose(unsubscribe);
  }

  protected override onPause(): void {
    this.feed.pause();
  }

  protected override onResume(): void {
    this.feed.resume();
  }
}
```

`addDispose` 保存一项 cleanup，在当前 generation 结束时执行。已登记 cleanup 会在 `onDispose` 之后按登记顺序逆序执行。`addDispose` 返回的 function 用于取消登记，不会直接执行 cleanup。

每获取一项资源就应立即登记 cleanup，这样后续 `onCreate` 或 `onBind` 失败时仍能安全 rollback。

## 生命周期 callback

### `onCreate()`

generation 首次被 Binding acquire 时调用一次。属于整个 generation 的资源应在这里启动。

如果 Runtime 已经 paused，acquire 会先调用 `onCreate`，再调用 `onPause`，然后完成 bind。

### `onBind(bindingId)`

第一个具有某逻辑 Binding ID 的 owner 绑定该 generation 时调用。同一个 Scope 中的多个 hook 使用同一个 Binding，因此不会按 hook 分别调用 `onBind`。

两个 Binding object 可以有意使用相同的自定义 ID。此时 `onBind` 与 `onUnbind` 按该逻辑 ID 引用计数。

`onBind` 只应用于真正属于某个逻辑 owner source 的工作。generation 范围的资源属于 `onCreate`。

### `onUnbind(bindingId)`

最后一个具有该逻辑 Binding ID 的 owner 离开时调用。移除单个 React hook listener 不一定会 unbind Scope 的 Binding；owner 会一直存在，直到 Binding 本身被 dispose 或 generation 被 recycle。

### `onPause()` 与 `onResume()`

Runtime 在 active 与 paused 之间切换时，对 active 实例调用。多个 pause source 按 token 聚合，因此只有最后一个 pause 原因被移除后才会运行 `onResume`。

Pause 不是 disposal。实例与依赖图仍然存活。

Pause 也不会阻止 method、`setState`、`notifyListeners`、直接 `subscribe` 或 `subscribeState` 运行。它让模块有机会暂停自己的资源，并让 Runtime 延迟、合并 Binding 与 React update callback，直到 resume。

### `onDependencyNotify(child)`

通过 `viewModelBinding.watch` 解析的依赖发出通知，或已解析的依赖 generation 被强制 dispose 时调用。该 callback 返回后，Runtime 会自动通知 parent。不要只是为了重复转发而调用 `notifyListeners`。

如果 callback 通过 `setState` commit parent state，该 state commit 除 Runtime 的依赖通知外，还会发出自己的通知。解释 version 与 diagnostics 时应考虑这一行为。

### `onDispose()`

activated generation 结束时调用一次。此时 disposal 已开始，并且 `isDisposed` 已为 true。不要在 `onDispose` 中调用 `viewModelBinding`、`addDispose`、state mutation method 或其他要求实例存活的 API。

`onDispose` 只用于对实例已经持有的字段执行最终同步工作。资源 cleanup 更适合提前通过 `addDispose` 登记；这些 cleanup 会在 `onDispose` 后立即运行。

已经 constructed 但从未 acquired 的 provisional generation 不会运行 `onCreate` 或 `onDispose`。这也是 constructor 不能获取资源的另一个原因。

### 生命周期 callback 是同步的

callback signature 返回 `void`，Runtime 不会 await `async` override 意外返回的 Promise。确有需要时，应启动显式管理的 task，保存它的 cancellation mechanism，并确保 disposal 能停止它或让它失效。

## 已 dispose 的 generation

Recycle 或最终 release 会永久结束一个 generation。disposal 后，修改状态的 protected API 会调用 `assertAlive` 并抛出 `ViewModelDisposedError`。

不要在长生命周期 service 中保留 ViewModel 引用并假设它一直是当前实例。应保留稳定 Spec，需要时从当前 Binding 解析，尤其要跨越显式 recycle。

最后一个 owner 离开后的自动 release 通过 microtask 调度。`binding.dispose()` 刚返回时，非 `aliveForever` 实例可能尚未报告 `isDisposed`。`runtime.recycle(...)` 与 `runtime.dispose()` 会同步强制 disposal。

## 作为 callback 传递的 method

普通 JavaScript prototype method 在脱离 receiver 传递时会丢失 `this`。UI callback 应使用 arrow field 或显式 wrapper：

```ts
public readonly submit = (): void => {
  this.updateState((state) => ({ ...state, saving: true }), 'profile.submit');
};
```

```tsx
<Button title="Submit" onPress={profile.submit} />
```

也可以：

```tsx
<Button title="Submit" onPress={() => profile.submit()} />
```

## 相关指南

- [快速开始](./getting-started.md)
- [依赖注入](./dependency-injection.md)
- [身份与生命周期](./identity-and-lifetime.md)
- [测试](./testing.md)
