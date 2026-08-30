# 依赖注入

[English](../dependency-injection.md)

`view_model` 的依赖注入是一项核心 Runtime 能力。它不依附 component tree，也不限于面向 UI 的 ViewModel。

应用可以把依赖图用于 session、repository、native bridge、设备连接、coordinator、后台工作或 Electron main 进程 service。React Native 与 Electron renderer Scope 只是把 React owner 接入同一个核心依赖图。

## 四种角色

### `ViewModelSpec<T>`

Spec 是关于如何构造及识别 ViewModel 的稳定声明。应用模块导出 Spec，让 consumer 依赖声明，而不是手动构造受管理实例。

```ts
export const sessionSpec = viewModelSpec(SessionViewModel, () => new SessionViewModel(), {
  key: 'primary-session',
  debugLabel: 'Session',
});
```

### `ViewModelRuntime`

Runtime 保存受管理 generation、keyed cache、依赖边、pause state 与 owner 关系。它是最大的共享边界。

### `ViewModelBinding`

Binding 同时是 owner 与 resolver。plain host 通过 `runtime.createBinding()` 创建 Binding。每个 React Scope 在内部拥有一个 Binding。

### `ViewModel.viewModelBinding`

ViewModel 完成 build 与 attach 后，Runtime 会给它一个私有 dependency Binding。parent 使用这个 Binding 解析 child。这些解析会创建显式的 parent-generation 到 child-generation 边。

## 不依赖 React 的应用级组合

当依赖容器需要独立于 UI 存在时，创建应用 Runtime 与 root Binding。

```ts
import {
  ViewModel,
  ViewModelRuntime,
  viewModelSpec,
  type ViewModelSpec,
} from '@lwjlol/view_model/core';

class SessionViewModel extends ViewModel {
  public async requireAccessToken(): Promise<string> {
    return 'token';
  }
}

class SyncViewModel extends ViewModel {
  public constructor(private readonly dependency: ViewModelSpec<SessionViewModel>) {
    super();
  }

  private get session(): SessionViewModel {
    return this.viewModelBinding.read(this.dependency);
  }

  public async authorizationHeader(): Promise<string> {
    const accessToken = await this.session.requireAccessToken();
    return `Bearer ${accessToken}`;
  }
}

const sessionSpec = viewModelSpec(SessionViewModel, () => new SessionViewModel(), {
  key: 'primary-session',
});
const syncSpec = viewModelSpec(SyncViewModel, () => new SyncViewModel(sessionSpec), {
  key: 'application-sync',
});

const runtime = new ViewModelRuntime();
const application = runtime.createBinding({ id: 'application' });

const sync = application.read(syncSpec);
const authorization = await sync.authorizationHeader();

application.dispose();
runtime.dispose();
```

把 Spec 传入 constructor 是安全的：Spec 是惰性声明。在 constructor 中解析 child 则不安全。Runtime 完成 builder 并 attach 新实例之前，`viewModelBinding` 不可用。

root Binding 保活 `SyncViewModel`。`authorizationHeader` 首次访问 `session` 时，parent 的 dependency Binding 会保活 `SessionViewModel`。移除这条 parent 边之前，child 不会被自动 release。

## 不要传递受管理实例

已经解析出的 ViewModel object 不是依赖声明。不要把它传给另一个 component、module、owner、constructor、registry 或 callback payload。Runtime 无法观察普通 JavaScript 引用，因此这种传递不会 acquire generation、创建 parent edge、传播 root owner source，也不会登记 release 边界。

原 Binding 存活时，这种写法可能看似安全；真正的问题发生在生命周期边界。原 owner dispose 或 generation 被强制 recycle 后，接收方会持有过期且已 disposed 的 object；长生命周期的手工 cache 还可能让引用越过预期 Scope。

应传递稳定 Spec 与所需业务 key/ID，再由接收方从自己的 Binding 解析。如果接收方只需要数据或行为，应传递不可变 DTO、plain function 或窄接口 port。不同 Binding 确实要共享一个 generation 时，应通过同一个 Runtime 与显式 key 表达。

## 基于 getter 解析 child

使用 getter，让每次访问都解析当前 generation：

```ts
class InboxViewModel extends ViewModel {
  public constructor(private readonly sessionDeclaration: ViewModelSpec<SessionViewModel>) {
    super();
  }

  private get session(): SessionViewModel {
    return this.viewModelBinding.read(this.sessionDeclaration);
  }

  public async authorizationHeader(): Promise<string> {
    const accessToken = await this.session.requireAccessToken();
    return `Bearer ${accessToken}`;
  }
}
```

不要把已解析 child 缓存在长生命周期字段中：

```ts
// Avoid this pattern.
#session: SessionViewModel | undefined;

private get session(): SessionViewModel {
  return (this.#session ??= this.viewModelBinding.read(sessionSpec));
}
```

显式 recycle 会永久 dispose 旧 child generation。由 Binding 支持的 getter 可以解析替代实例；缓存实例则会过期，并在 action 检查实例存活时抛错。

Runtime 已经按照 Spec identity 缓存当前结果，因此不需要应用层实例缓存。

## `read` 与 `watch` 依赖

两种模式都会：

- 解析或创建 child；
- 让 dependency Binding 成为 owner；
- 添加 parent 到 child 的生命周期边；
- 把 parent 当前的 external root Binding source 镜像给 child；
- 在边被 release 前保活 child；
- 参与依赖环检测；
- 允许强制 child disposal 使 parent 的 dependency entry 失效。

普通通知行为不同：

| Parent getter                            | Child 普通通知 | Parent 行为                                                      |
| ---------------------------------------- | -------------- | ---------------------------------------------------------------- |
| `this.viewModelBinding.read(childSpec)`  | 不冒泡         | Parent 仍被保活，但不会因 child update 收到通知                  |
| `this.viewModelBinding.watch(childSpec)` | 冒泡           | Runtime 调用 `parent.onDependencyNotify(child)`，然后通知 parent |

parent 调用 child action，或只在命令式操作期间读取 child 时，使用 `read`。

```ts
private get session(): SessionViewModel {
  return this.viewModelBinding.read(sessionSpec);
}
```

child 变化必须使 parent 失效或唤醒 parent 时，使用 `watch`：

```ts
class NetworkCoordinator extends ViewModel {
  public constructor(
    private readonly connectivityDeclaration: ViewModelSpec<ConnectivityViewModel>,
  ) {
    super();
  }

  private get connectivity(): ConnectivityViewModel {
    return this.viewModelBinding.watch(this.connectivityDeclaration);
  }

  protected override onCreate(): void {
    // Establish monitoring only after this parent has been acquired.
    void this.connectivity;
  }

  protected override onDependencyNotify(_child: ViewModel): void {
    // Reconcile generation-owned resources if needed.
    // The Runtime notifies this parent automatically after this returns.
  }
}
```

不要在 `onDependencyNotify` 中只为转发同一个 child event 而调用 `notifyListeners`。Runtime 已经负责该传播。如果 callback 还通过 `setState` commit parent state，该 state commit 会发出自己的通知。

## Binding 托管的 side-effect listener

依赖需要执行 side effect、但不应 broad notify parent 时，使用 Binding listener method：

```ts
protected override onCreate(): void {
  this.viewModelBinding.listenStateSelect(
    connectivitySpec,
    (state) => state.online,
    ({ current, previous }) => {
      this.reconcileConnectivity(previous, current);
    },
  );
}
```

- `listen(spec, callback)` 观察普通 ViewModel 通知。
- `listenState(spec, callback)` 接收完整的 `StateViewModel` state change。
- `listenStateSelect(spec, selector, callback, equals?)` 接收 selected state change；equality 默认使用 `Object.is`。

这些 method 通过传入的 Spec 解析并 bind，因此会建立 parent-to-child lifetime edge，但不会启用 broad `watch` 冒泡。每个 method 都返回 disposer，可用于提前移除 listener；该 disposer 不会释放 Binding 对 generation 的 ownership。Binding 或 child generation handle dispose/recycle 时，也会自动移除 listener。

应在 `onCreate` 等 owner lifecycle 中只注册一次 listener。不要把 `listen` 放进反复求值的 dependency getter，因为每次求值都会再注册一个 side effect。直接使用 `viewModel.subscribe` 与 `subscribeState` 仍属于底层 subscription，需要手动管理 cleanup。

## 高级 cached lookup

普通 DI 应保留 Spec，并调用 `read(spec)` 或 `watch(spec)`。这样 declaration 可以在需要时创建 generation，construction order 也保持明确。

cached method 是 lookup-only 逃生口，只用于查询已经由其他路径创建的 generation：

```ts
const existing = binding.readCached(SessionViewModel, {
  key: 'primary-session',
});

const optional = binding.maybeReadCached(sessionSpec, {
  key: 'primary-session',
});

const sessions = binding.watchCachesByTag(SessionViewModel, 'active-sessions');
```

cache target 可以是显式 ViewModel class 或 Spec。`ViewModelSpecOptions.tag` 提供分组 label，不参与 identity。单值 method 接受 `{ key?, tag? }`；精确 key 优先，key 未命中时可回退到匹配 tag。`maybeReadCached`/`maybeWatchCached` 未命中时返回 `undefined`，required `readCached`/`watchCached` 则抛错。`readCachesByTag`/`watchCachesByTag` 返回所有匹配项，未命中时返回空数组。

cached method 都不会运行 builder，也不会创建缺失 generation。但命中后，Binding 会 acquire 现有 generation、镜像 parent root source，并建立与 Spec-based resolution 相同的 parent lifetime edge。`readCached` 与 `readCachesByTag` 不冒泡普通通知；`watchCached` 与 `watchCachesByTag` 会冒泡。

cached lookup 会把调用方耦合到 cache identity、creation order、miss handling，以及可能出现的多个 tag match。只应把它用于有意的 cross-owner 查询，不要作为默认依赖解析方式。

## 何时可以使用依赖 getter

只有 parent 完成 attach 与 acquire 后，才能使用依赖 getter。安全调用位置包括：

- 解析完成后调用的 ViewModel action；
- `onCreate`；
- `onBind`；
- `onPause` 与 `onResume`；
- `onDependencyNotify`；
- 明确在 commit/acquire 后运行的其他内部工作。

从技术上说，`onUnbind` 期间 `viewModelBinding` 仍然可用；但 teardown 代码不应仅仅因为一个 owner 正在离开，就建立新的依赖。应提前解析必需依赖，并为 generation 所拥有的资源登记 cleanup。

不要在以下位置使用：

- Spec builder；
- ViewModel constructor；
- React render 或 JSX；
- `useViewModelSelector` selector；
- 任何 render 派生 helper；
- `onDispose`。

`onDispose` 在 ViewModel 已标记 disposed 后开始，因此 `viewModelBinding` 已不可用。应提前通过 `addDispose` 登记 cleanup，或只清理实例已经拥有的字段，不要再解析新依赖。

### 为什么禁止从 render 访问

React render 可能重复、交错、suspend 或被放弃。hook 内部可以在 render 期间 prepare 一个纯 parent object，而不创建 owner。parent 依赖 getter 会调用 `read` 或 `watch`，从而 acquire child 并建立真实依赖图边。这是 commit-time side effect，不能由 JSX 或 selector 触发。

UI 所需数据应由 parent 自己公开。让 commit 后的 action 或依赖通知同步 parent 所拥有的 state。

## Unkeyed child 对 parent Binding 私有

unkeyed identity 按 Binding 缓存。Scope Binding 与每个 parent dependency Binding 都是不同 owner。

```ts
const localCacheSpec = viewModelSpec(LocalCacheViewModel, () => new LocalCacheViewModel());
```

如果两个 parent generation 分别解析 `localCacheSpec`，它们会得到不同 child，因为每个 parent 都有不同 dependency Binding。这适合私有子图。

同一个 Runtime 中多个 parent 或 Scope 必须共享 child 时，使用 keyed Spec：

```ts
const sharedCacheSpec = viewModelSpec(SharedCacheViewModel, () => new SharedCacheViewModel(), {
  key: 'application-cache',
});
```

显式 ViewModel class 与 key 共同组成 keyed identity。显式 class 与 key 相同的独立 Spec 会在同一 Runtime 中共享。builder-only 兼容 overload 则会为每个独立创建的 base Spec 分配唯一 fallback token。

## 把 React owner 接入应用容器

在同一个 realm 内，React Scope 可以接收应用 Runtime：

```tsx
<ViewModelScope runtime={applicationRuntime}>
  <RootNavigator />
</ViewModelScope>
```

Scope 会创建自己的 Binding。因此：

- 显式 class identity 与 key 匹配时，它会与 plain application Binding 共享 keyed application Spec；
- 对 unkeyed Spec，它会得到私有实例；
- dispose Scope 只会 release Scope Binding；
- 创建 `applicationRuntime` 的代码仍负责 dispose 它。

未注入 Runtime 时，root Scope 会创建并拥有一个 Runtime。嵌套 Scope 继承 parent Runtime，但创建单独 Binding。

Scope 是 owner adapter，不是 service locator 的必要条件。非 React 模块应通过普通模块组合接收 Spec 或 plain port，并从自己的 ViewModel Binding 解析受管理依赖。

## Runtime pause 影响整个依赖图

平台 Scope 生命周期连接到 `runtime.pause(token)` 与 `runtime.resume(token)`。Pause state 属于 Runtime，而不是某个 Binding。

因此，继承 parent Runtime 的嵌套 Scope 不能用 navigation lifecycle source 只暂停嵌套页面依赖图。它的 inactive token 会暂停该 Runtime 中每个 active generation，包括 parent 或 sibling Binding 所拥有的 generation。

需要页面局部行为时，可以：

- 把 focus 建模为普通 state 或该页面 ViewModel 消费的 action；或
- 使用独立 Runtime，并显式管理该 Runtime 的 disposal。

多个独立 pause source 必须使用不同的稳定 token。平台 adapter 会自动处理。core 无参数 `pause()` 使用同一个默认 token，并且幂等，而非引用计数。

## 依赖环

依赖图必须无环。Runtime 通过 `ViewModelDependencyCycleError` 拒绝直接或间接依赖环。

```text
Orders -> Session -> Orders
```

应通过改变架构来消除依赖环：

- 把共享行为提取为第三个依赖；
- 把编排移到更高层 coordinator；
- 传递不可变数据或 plain function，而不是受管理的反向引用；
- 通过刻意设计的单向边界发布 event。

不要通过缓存实例或手动构造某个依赖来隐藏环。这样会绕过 owner 管理，并让 disposal 顺序无法定义。

## Runtime 与 realm 边界

Runtime 是最大的共享边界，但它仍然是内存中的 JavaScript object。共享要求同一个 realm 中的同一个 Runtime object。

- 不同 Runtime 实例永远不共享 generation。
- Electron main、preload 与 renderer 属于不同 realm。
- 不同 Electron renderer 进程不能共享 Runtime。
- Worker thread 与其他隔离 JavaScript context 不能共享受管理 object identity。
- 在另一个 Runtime 或 realm 中使用文本相同的 key string，不会产生全局共享。

realm 之间应使用 IPC 或其他显式 transport。传递可序列化 DTO 与 event，并让每个 realm 维护自己的 Runtime 与 ViewModel。

## 相关指南

- [快速开始](./getting-started.md)
- [ViewModel 与 state](./view-models.md)
- [身份与生命周期](./identity-and-lifetime.md)
- [测试](./testing.md)
