# 核心概念

[English](../concepts.md) · [文档索引](./README.md)

> 本指南描述 `view_model` 在 React Native 与 Electron 应用中的正式支持行为；本包不提供通用 React Web 入口。

`view_model` 将应用级依赖注入、状态传播与自动生命周期管理组合在一起。应用对象图存在于 `ViewModelRuntime` 中。React `ViewModelScope` 只是 owner adapter：它通过 `ViewModelBinding` 将一棵 React 子树连接到 Runtime；Scope 本身并不是 DI 容器。

## 应用对象图

典型应用会为每个需要独立管理的执行环境使用一个 Runtime：

```text
Application composition root
└── ViewModelRuntime
    ├── plain ViewModelBinding (bootstrap, service, or Electron main)
    ├── React Scope Binding (application UI)
    ├── nested React Scope Binding (optional owner boundary)
    └── ViewModel generation
        └── dependency Binding
            └── child ViewModel generation
```

Runtime 是下列能力的最大边界：

- 显式 type + key 实例共享；
- 受管理的依赖图；
- generation 编号；
- 强制 recycle；
- Runtime 级 pause token；
- 最终销毁。

即使两个 Runtime 解析同一个 Spec 与 key，它们也绝不会共享受管理实例。在 Electron 中，对象同样不能跨进程边界：main 与每个 renderer 必须在各自的 JavaScript 环境中使用 Runtime，并通过可序列化的 IPC 消息通信。

## Runtime、Scope、Binding、Spec 与 generation

| 概念               | 职责                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `ViewModelRuntime` | 持有受管理实例、keyed cache、依赖边、pause 状态、recycle 与最终清理。                                         |
| `ViewModelScope`   | 将 React 子树适配到 Runtime。它创建一个稳定 Binding，并提供给 hooks。                                         |
| `ViewModelBinding` | 表示一个 owner。`read` 与 `watch` acquire 实例；`dispose` 释放该 Binding acquire 的所有内容。                 |
| `ViewModelSpec<T>` | 声明显式 ViewModel type、纯 builder 以及 identity/lifetime options。                                          |
| generation         | 针对某个 Spec identity 创建的一个具体受管理对象。Recycle 会结束 generation；后续解析会创建另一个 generation。 |

未注入 Runtime 且没有 parent 的 root Scope 会创建并最终销毁自己的 Runtime。nested Scope 默认复用 parent Runtime，但始终创建不同的 Binding。显式注入的 Runtime 由调用方持有，而不是 Scope。

这个区别直接影响应用级 DI。长期存在的 application Binding 可以在自己的生命周期内拥有一棵 unkeyed 对象图；若要让同一个 service 跨独立的 plain/Scope/parent Binding 共享，还必须使用同一个 Runtime、相同的显式 ViewModel type 与显式 key。React 嵌套本身不会让 ViewModel 变成全局实例。

## 显式 type 定义 identity，稳定 Spec 定义 construction

把 ViewModel class 作为显式 runtime identity value。推荐声明形式是 `viewModelSpec(MyViewModel, () => new MyViewModel(), options)`。

builder 结果必须是该显式 type 或其子类的实例。带 protected constructor 的抽象基类也可以作为 identity value。

应在模块顶层声明一次 Spec，让 builder 与 options 保持稳定：

```ts
import { ViewModel, viewModelSpec } from '@lwjlol/view_model/core';

class CartViewModel extends ViewModel {
  // ...
}

export const cartSpec = viewModelSpec(CartViewModel, () => new CartViewModel(), {
  debugLabel: 'CartViewModel',
});
```

不要在 React render 中创建 Spec：

```tsx
function CartScreen() {
  // Wrong: this allocates a new Spec and builder during every render.
  const cart = useViewModel(viewModelSpec(CartViewModel, () => new CartViewModel()));
  return <CartView cart={cart} />;
}
```

显式 class 参数能跨过 TypeScript 泛型擦除保留 identity。在同一个 Runtime 内，相同 ViewModel type 与 key 的独立显式 Spec 会共享同一 generation。首个命中 cache miss 的 builder 负责构造它，所以即使 identity 相同，重复声明相互分歧的 builder 或 options 也不安全。

identity 规则是确定的：

```text
explicit identity = ViewModel type + effective key inside one Runtime
unkeyed            = effective key is private to one Binding
keyed              = effective key is the explicit key
```

builder-only 形式 `viewModelSpec(() => new MyViewModel(), options)` 作为兼容 fallback 仍然保留。每个 builder-only Spec 都有独立 token，因此即使 builder 返回相同 class 且 key 相同，不同 builder-only Spec 也不会共享。

`debugLabel` 只是诊断元数据，从不参与 identity。`withKey(key)` 会保留显式 Spec 的 ViewModel type identity；对 builder-only Spec 则保留该 Spec 的 fallback token。

## Unkeyed、keyed 与 aliveForever

### Unkeyed 实例

unkeyed Spec 对解析它的 Binding 私有：

- 在同一 Binding 中重复解析同一显式 ViewModel type，会返回同一 generation，包括通过不同显式 Spec 解析；
- 两个 Scope Binding 会解析出相互隔离的 generation；
- parent ViewModel 的 dependency Binding 拥有自己的 unkeyed generation；
- 最后一个 owner Binding 释放后，unkeyed generation 通常会被销毁。

这是 screen-local state，以及应对一个 parent generation 私有的模块的默认选择。

### Keyed 实例

显式 key 让实例能够在同一 Runtime 的多个 Binding 之间共享：

```ts
export const sessionSpec = viewModelSpec(SessionViewModel, () => new SessionViewModel(), {
  key: 'primary-session',
  debugLabel: 'SessionViewModel',
});
```

Keyed 不等于永久存活。除非启用 `aliveForever`，最后一个 owner 离开后，generation 仍会正常释放。

当应用确实需要 UI Scope、plain Binding 或多个 parent module 共享同一 identity 时，应使用 key。`ViewModelKey` 仅限 `string | number | symbol`；应优先使用稳定、具有业务含义的 primitive key。

### `aliveForever`

`aliveForever` 会阻止普通的零 owner 清理，但不会让实例脱离 Runtime 独立存在：

```ts
export const telemetrySpec = viewModelSpec(TelemetryViewModel, () => new TelemetryViewModel(), {
  key: 'application-telemetry',
  aliveForever: true,
  debugLabel: 'TelemetryViewModel',
});
```

每个 `aliveForever` Spec 都必须有显式 key。Spec constructor 会在 builder 运行前拒绝无效配置。`aliveForever` generation 仍会在下列情况结束：

- `runtime.recycle(...)` 命中它；
- 执行 `runtime.dispose()`；
- 一个被放弃的 render prepare 了它，但从未 commit owner。

只应将该选项用于有意长期保留的应用基础设施。普通 keyed module 通常已经足够，因为 owner Binding 会表达它的生命周期。

## 应用全局与 owner-local DI

若要建立应用全局对象图，应在 composition root 创建一个 Runtime，并将同一个 Runtime 交给所有需要参与其中的 owner：

```ts
const runtime = new ViewModelRuntime();
const bootstrapBinding = runtime.createBinding({ id: 'application-bootstrap' });

const session = bootstrapBinding.read(sessionSpec);
```

也可以将同一个 Runtime 注入 root platform Scope：

```tsx
<ViewModelScope runtime={runtime}>
  <Application />
</ViewModelScope>
```

Scope 只贡献一个 React owner Binding，不会取代或包裹应用 DI 图。plain Binding、Scope Binding 与 ViewModel dependency Binding 可以共同拥有同一个 keyed generation。

对于 owner-local state，应让 Spec 保持 unkeyed。这样，即使所有 owner 使用同一个 Runtime，每个 Binding 仍会得到隔离的 generation。

## `watch` 与 `read`

两种操作都会解析 Spec 并建立生命周期所有权：

| 操作          | 缺失时创建 | 为 Binding acquire | 普通通知触发 React/plain owner 更新 | 感知 generation dispose/recycle |
| ------------- | ---------- | ------------------ | ----------------------------------- | ------------------------------- |
| `watch(spec)` | 是         | 是                 | 是                                  | 是                              |
| `read(spec)`  | 是         | 是                 | 否                                  | 是                              |

`read` 从不表示“unmanaged”或“unbound”。当普通 ViewModel 通知不应更新 owner 时，它适合用于 command 与命令式协作。

在 React 中，应使用对应 hooks：

```tsx
const model = useViewModel(modelSpec);
const commands = useReadViewModel(modelSpec);
const title = useViewModelSelector(modelSpec, (vm) => vm.state.title);
```

`useReadViewModel` 不会因为普通 `notifyListeners` 而 rerender，但强制 recycle 会改变 generation snapshot，使 hook 解析 replacement generation。

`useViewModelSelector` 在返回 selected value 的同时订阅 ViewModel。它默认使用 `Object.is`，并接受第三个显式 equality 参数。即使新 generation 的 selected value 判等一致，也会产生一次更新，确保 hook 重新订阅正确的对象。

## Scope ownership 不等于 hook ownership

React hooks 在 commit 时订阅，但真正的 owner 是 Scope Binding。单个 hook unmount 时只会移除其 listener；Binding 的 ownership entry 会一直保留到 Scope 本身 dispose，或 generation 被强制 recycle。

该设计为 React 子树提供稳定 owner 边界，避免瞬时 component 变化反复销毁应用模块。如果某个功能需要更短的独立生命周期，应为它提供 nested Scope/Binding 边界，或单独管理的 plain Binding。要记住，共享同一 Runtime 的 nested Scope 不会创建新的全局 DI 容器。

## ViewModel 模块与 getter-based DI

任何 feature、repository、coordinator、state holder 或 platform capability 都可以建模为 ViewModel。parent module 通过其 generation-owned `viewModelBinding` 解析 child module：

```ts
const authSpec = viewModelSpec(AuthViewModel, () => new AuthViewModel(), {
  key: 'application-auth',
});

class OrdersViewModel extends ViewModel {
  private get auth(): AuthViewModel {
    return this.viewModelBinding.read(authSpec);
  }

  async refresh(): Promise<void> {
    const token = await this.auth.requireToken();
    await this.loadOrders(token);
  }

  private async loadOrders(_token: string): Promise<void> {
    // ...
  }
}
```

getter 声明本身是惰性的，不会创建任何东西。在 attach 后首次求值时：

1. parent dependency Binding 解析 child；
2. Runtime 记录一条 `parent generation -> child generation` 边；
3. dependency Binding 成为 child owner；
4. 在 parent generation 释放该 Binding 之前，child 不会自然 dispose。

unkeyed child 对该 parent generation 的 dependency Binding 私有。keyed child 也可以同时由其他 parent、Scope 或 plain Binding 持有，因此能够比某一个 parent 活得更久。

root ownership 按 source 传播。当前拥有 parent 的每个 root Binding source 都会传递给该 parent 已解析的 child，后续 root bind/unbind 也会实时同步到这些 child。

使用 `read` 进行命令式 child 调用。只有 child 通知必须通过 `onDependencyNotify(child)` 冒泡并继续通知 parent 时，才使用 `watch`。同步传播会按 transaction 去重。

## 依赖访问只能发生在 commit 后

Spec builder 与 ViewModel constructor 必须保持纯净。ViewModel 只有在构造完成、Runtime attach 新 generation 后，才会获得 dependency Binding。dependency getter 只能从已经 commit 的 ViewModel 行为中解析，例如：

- mount/bootstrap 后调用的 action；
- `onCreate` 及更晚的 lifecycle callback；
- activation 后启动的内部异步工作流。

不要从下列位置解析 dependency getter：

- Spec builder 或 ViewModel constructor；
- component render 或 JSX 求值；
- `useViewModelSelector` selector；
- 其他由 render 派生的计算。

React render 可能被重放或放弃。UI 代码应选择 parent 已经暴露的 state，而不是在 render 中遍历并 acquire 它的 child graph。

## 依赖图必须无环

Runtime 会拒绝直接与间接 owner cycle。unkeyed recursion 也会通过活跃 ancestor identity lineage 检测。

当两个模块看似互相依赖时，优先采用以下设计之一：

- 将共同能力提取为第三个 ViewModel；
- 将编排移到更高层 coordinator；
- 交换事件或普通函数结果，而不是建立反向 owner edge。

diamond graph 合法。共享 child 的通知会在一个同步 propagation transaction 内去重。

## Generation 与 recycle

generation 的对象 identity 不会原位改变。本库没有 in-place replacement 操作。generation 被 recycle 后，再次解析其稳定 Spec 会创建一个新对象、新 generation 编号与全新的 dependency Binding。

若某个操作可能 recycle ViewModel，不要让外部长期字段一直保存该 ViewModel 引用。需要 fresh generation 时，应通过当前 Binding 与稳定 Spec 重新解析。

`runtime.recycle(viewModel)` 命中一个具体 generation。`runtime.recycle(spec)` 命中该 Runtime 中所有匹配 identity。对于 unkeyed Spec，由于 effective key 属于 Binding 私有，可能同时命中每个 Binding 的一个 generation。

Recycle 会忽略当前 owners 与 `aliveForever`。它适合 logout、disconnect 等有意的应用全局失效。若需要独立 replacement，使用新的业务 key 比强制 recycle 共享 generation 更安全。

## 设计规则

- 将应用 DI 图放入所有权明确的 Runtime。
- 将 Scope 视为 React Binding adapter，而不是 service container。
- 优先使用显式 type Spec，并只声明一次，让 builder 与 options 保持稳定。
- 默认使用 unkeyed owner-local module；需要 Runtime 范围共享时才提供显式 key。
- 使用 `watch` 表达 reactive ownership，使用 `read` 表达 imperative ownership。
- builder 与 constructor 保持纯净；在 `onCreate` 启动资源，并通过 `addDispose` 注册清理。
- attach 后通过 parent getter 解析 child module。
- 永远不要在 React render 或 selection 中使用 dependency getter。
- 只有明确接受 Runtime 范围影响时才使用 `aliveForever` 与 recycle。
- 不要导入或记录 `@lwjlol/view_model/react` package entry；它有意不对外公开。
