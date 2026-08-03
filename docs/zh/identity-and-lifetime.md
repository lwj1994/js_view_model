# 身份与生命周期

[English](../identity-and-lifetime.md)

实例共享与 disposal 由四项因素决定：

1. `ViewModelRuntime`；
2. Spec token；
3. 可选 key；
4. owner Binding 集合。

Runtime 是最大的共享边界。Spec token 与 key 在该 Runtime 内选定 identity。Binding 负责保活当前 generation。

## Spec 是 identity 声明

每次新调用 `viewModelSpec(...)` 都会创建新 token。

```ts
const firstSpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'primary',
});
const secondSpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'primary',
});
```

`firstSpec` 与 `secondSpec` 不共享实例。它们的 key string 相同，但 token 不同。

对于 keyed identity，cache key 在概念上是：

```text
(runtime object, spec token, explicit key)
```

对于 unkeyed identity，cache key 在概念上是：

```text
(runtime object, binding object, spec token, undefined)
```

因此，Spec 通常应该是稳定的模块级声明：

```ts
export const sessionSpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'primary',
});
```

## 不要在 render 中创建 Spec

下面的写法错误：

```tsx
function Profile(): React.JSX.Element {
  const profile = useViewModel(viewModelSpec(() => new ProfileViewModel()));
  // ...
}
```

每次 render 都创建一个 token，因此也创建了不同 identity。Scope Binding 会保留已 acquire 的 entry，直到 Binding 被 dispose；所以这种写法会累积 generation 并引发生命周期抖动，而不是简单重建一个值。

应在 render 外定义 Spec。如果 identity 依赖业务数据，应为该数据创建并保留稳定声明，不要在每次 render 中派生新 Spec。

## Unkeyed identity

```ts
const editorSpec = viewModelSpec(() => new EditorViewModel());
```

unkeyed Spec 对 Binding 私有：

- 从同一个 Binding 重复解析会返回同一个当前 generation；
- 不同 Binding 会得到不同 generation；
- 同一个 Scope 中的 sibling component 使用同一个 Scope Binding，因此会共享；
- 嵌套 Scope 创建另一个 Binding，因此会得到私有 generation；
- 每个 parent ViewModel 都有私有 dependency Binding，因此 unkeyed child 对该 parent generation 私有。

页面、窗口局部模块或私有依赖子图适合默认使用 unkeyed identity。

## Keyed identity

```ts
const sessionSpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'primary-session',
});
```

同一个 Runtime 内，解析相同 token 与 key 的 Binding 共享同一个 generation：

```ts
const runtime = new ViewModelRuntime();
const first = runtime.createBinding({ id: 'first' });
const second = runtime.createBinding({ id: 'second' });

const fromFirst = first.read(sessionSpec);
const fromSecond = second.read(sessionSpec);

console.log(fromFirst === fromSecond); // true
```

Keyed 不表示永久存活。除非启用 `aliveForever`，最后一个 owner 离开后仍会调度该 generation 的 disposal。

key 可以是 string、number 或 symbol。优先使用稳定且具有业务含义的标识符。每个新 `Symbol()` 都是新 key；随机或随 render 变化的 key 会破坏 identity 稳定性。

### `withKey`

`withKey` 在保留原 token 的同时创建 Spec variant：

```ts
const workerSpec = viewModelSpec(() => new WorkerViewModel());

const primaryWorkerSpec = workerSpec.withKey('primary');
const secondaryWorkerSpec = workerSpec.withKey('secondary');
```

重复调用 `workerSpec.withKey('primary')` 表示同一个 keyed identity，因为 token 与 key 都相同。builder 也相同；key 不会作为 builder argument 传入。

如果 construction 本身需要 ID，应为每个 ID 保留稳定的参数化 Spec 声明。不要在 consumer 每次请求该 ID 时都创建一个未缓存的新 Spec。

## Runtime 边界

同一个 Spec 与 key 在两个 Runtime object 中会产生两个实例：

```ts
const firstRuntime = new ViewModelRuntime();
const secondRuntime = new ViewModelRuntime();
const firstBinding = firstRuntime.createBinding();
const secondBinding = secondRuntime.createBinding();

const first = firstBinding.read(sessionSpec);
const second = secondBinding.read(sessionSpec);

console.log(first === second); // false

firstBinding.dispose();
secondBinding.dispose();
firstRuntime.dispose();
secondRuntime.dispose();
```

Runtime 不能跨 JavaScript realm 共享。Electron main、preload 与 renderer 必须使用不同容器，并通过可序列化 IPC 数据通信。在这些 realm 中使用相同 key 也不会共享 object identity。

## Binding 是 owner

调用 `read` 或 `watch` 会让 Binding 成为已解析 generation 的 owner：

```ts
const binding = runtime.createBinding();
const viewModel = binding.read(spec);
```

owner 会一直存在，直到发生以下事件之一：

- `binding.dispose()` release 该 Binding 拥有的所有 generation；
- `runtime.recycle(...)` 强制 dispose 匹配 generation；
- `runtime.dispose()` 结束整个容器。

同一个 Binding 重复解析同一个 generation 不会创建重复 owner。把现有 Binding entry 从 `read` 切换到 `watch` 只改变通知传播，不改变 identity。

### Binding ID 与 bind callback

每个 Binding 都有 ID。默认 ID 唯一。具有该逻辑 ID 的第一个 owner 到来时运行 `onBind(bindingId)`，最后一个 owner 离开时运行 `onUnbind(bindingId)`。

即使由多个 Binding object 表示，重复的自定义 ID 也会作为一个逻辑 source 进行引用计数。只有确实需要这种分组时，才使用稳定且有意义的自定义 ID。

## React Scope owner

一个 `ViewModelScope` 拥有一个稳定 Binding：

- Scope 中的 component 通过该 Binding 解析；
- 多个 hook 不会为相同 generation 与 Binding ID 产生多次 `onBind` 调用；
- hook cleanup 移除 hook subscription，而不是 Binding owner entry；
- Scope cleanup 会 dispose Binding，并 release 它的所有 entry。

因此，从应用 root Scope 中移除最后一个 consumer component，不会立即 release 其 ViewModel。root Binding 可能仍然拥有它。如果 screen unmount 时必须 release screen-local 模块，应给它们合适的 Scope/Binding 边界。

没有注入 Runtime 的 root Scope 会创建并拥有自己的 Runtime。嵌套 Scope 继承 parent Runtime，但会创建新 Binding。接收显式 Runtime 的 Scope 会 dispose 自己的 Binding，但不拥有该 Runtime 的最终 disposal。

## 依赖 owner

受管理 parent 会得到自己的 dependency Binding。parent 通过 `viewModelBinding.read` 或 `watch` 解析 child 时，该 Binding 会拥有 child，Runtime 则记录 parent 到 child 的边。

parent 使用 child 期间，依赖边负责保活 child。parent generation 结束时，其 dependency Binding 会被 dispose。没有 owner 且非永久存活的 child 随后可以 disposal。

不要无限期保存已解析 child。应保存其 Spec 并通过 getter 解析，这样强制 recycle child 后可以得到当前 generation。

## 普通自动 release

对于普通 Spec，移除最后一个 owner 会在 microtask 中调度 disposal。这一短暂延迟使 release/reacquire 流程可以取消不必要的销毁，也支持 React StrictMode 协调。

```ts
binding.dispose();

// The generation may still be alive here.
await Promise.resolve();
await Promise.resolve();

// It is now expected to be disposed if no owner reacquired it.
```

不要让生产行为依赖确切的 microtask 数量。测试可以在断言最终 disposal 前 flush queue；应用代码应响应 owner 与生命周期，而不是轮询 `isDisposed`。

generation 被 dispose 时：

1. owner 被 unbind；
2. activated 实例运行 `onDispose`；
3. 已登记 disposer 按逆序运行；
4. dependency Binding 被 dispose，并 release 独占且零 owner 的 child；
5. 仍存活的 owner 收到 generation 已变化的通知。

Runtime 会先完整结束旧 generation 及其独占依赖树，再让 owner 解析替代实例。这样可以防止新旧 generation 同时占用同一项独占原生或 IPC 资源。

## `aliveForever`

`aliveForever` 阻止普通零 owner release：

```ts
const telemetrySpec = viewModelSpec(() => new TelemetryViewModel(), {
  key: 'application-telemetry',
  aliveForever: true,
});
```

`aliveForever` Spec 必须有显式 key。构造没有 key 的实例会抛出 `ViewModelSpecError`。

该选项不表示进程全局或永生：

- 它只在一个 Runtime 内生效；
- 从未 acquire provisional generation 的 abandoned render 仍会被清理；
- `runtime.recycle(...)` 可以强制 dispose 它；
- `runtime.dispose()` 一定会结束它。

如果 application Binding 已经拥有应用生命周期模块，大多数模块不需要 `aliveForever`。只有 identity 必须刻意跨越一段零 owner 时间时才使用它。

## `recycle`

Recycle 是强制失效，不是普通 release。

```ts
const recycled = runtime.recycle(sessionSpec);
```

它会同步 dispose 该 Runtime 中每个匹配的当前 generation，并返回 dispose 数量。它忽略 active owner count 与 `aliveForever`。

目标可以是 Spec 或实例：

```ts
runtime.recycle(viewModel); // Exactly that managed generation, if owned by this Runtime.
runtime.recycle(spec); // Every generation matching this Spec token and key.
```

这一区别对 unkeyed Spec 至关重要。一个 Runtime 中每个 Binding 都可能有一个 unkeyed generation。`runtime.recycle(unkeyedSpec)` 会匹配所有这些 generation，因为它们拥有相同 token 与 undefined key。只需要使一个私有 generation 失效时，应使用 `runtime.recycle(instance)`。

对于 keyed Spec，recycle 会影响该 Runtime 中每个 Scope、plain Binding 与 parent dependency owner 所使用的共享 generation。

### owner 会观察到什么

Recycle 不会把旧 object 修改成新 object。旧引用会永久 disposed。

- 已 mounted React hook 收到通知并解析新 generation。
- plain Binding 的 `onUpdate` callback 收到通知，并应从 Spec 重新解析。
- parent dependency getter 下次访问时解析新 child generation。
- 长期缓存实例保持过期状态，不能继续使用。

只有 logout、替换 account 或强制断开设备等真正的全局失效操作，才应使用 recycle。局部变化应优先使用普通 state update、不同 owner 边界或新的业务 key。

recycle 前应确认：

- identity 是否跨 Scope 或 parent 共享？
- 它是否拥有独占依赖树？
- 是否有异步 task 持有旧引用？
- 所有 owner 是否都接受同时失效？

## Pause 不是生命周期结束

Runtime pause 会保留 generation 与 owner 边。它在 active 实例上调用 `onPause`，并延迟、合并 Binding update 投递。只有最后一个 pause token 被移除后才会 resume。

因为 pause 属于 Runtime，所以该 Runtime 中每个 active generation 都会受影响，而不只由提供 lifecycle source 的 Scope 所拥有的 generation。

Pause 不会阻止 action、state mutation 或直接实例订阅。模块必须在 `onPause` 中实现所需资源暂停，并在 `onResume` 中恢复。

## 汇总表

| 声明与 owner 状态                | 共享方式                                    | 零 owner 行为                      |
| -------------------------------- | ------------------------------------------- | ---------------------------------- |
| Unkeyed Spec                     | 每个 Binding 一个 generation                | 调度 disposal                      |
| Keyed Spec                       | 每个 Runtime 的 token + key 一个 generation | 调度 disposal                      |
| Keyed `aliveForever` Spec        | 每个 Runtime 的 token + key 一个 generation | 保留到 recycle 或 Runtime disposal |
| 同一个 Spec 位于另一个 Runtime   | 永不与第一个 Runtime 共享                   | 独立管理                           |
| 相同文本 key 位于不同 Spec token | 不共享                                      | 独立管理                           |

## 相关指南

- [快速开始](./getting-started.md)
- [ViewModel 与 state](./view-models.md)
- [依赖注入](./dependency-injection.md)
- [测试](./testing.md)
