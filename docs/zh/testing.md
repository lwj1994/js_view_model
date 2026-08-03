# 测试

[English](../testing.md)

测试 ViewModel 时，应主要通过公开 action、Spec、Runtime 与 Binding 验证。React commit 时序或原生生命周期映射很重要时，再添加平台 adapter 测试。

最有价值的测试覆盖普通 UI snapshot 无法证明的行为：

- state equality 与通知；
- `read` 与 `watch` 的传播差异；
- unkeyed 与 keyed identity；
- owner release 与最终 disposal；
- `aliveForever` 与 recycle；
- parent-child 依赖边与依赖环；
- pause token 聚合；
- React commit、StrictMode 与 generation replacement；
- React Native AppState 或 Electron focus/visibility 映射。

不要围绕 `prepare`、hook subscription plumbing 或 generation snapshot 等内部 method 编写应用测试。这些 method 属于实现细节，也会从公开 TypeScript declaration 中移除。

## 串行运行测试

本仓库配置 Vitest 禁止文件并行：

```sh
npm test
```

等价的直接命令是：

```sh
vitest run --no-file-parallelism
```

串行执行可使 Runtime 生命周期时序与进程级 diagnostic counter 保持确定。每个断言仍应创建并 dispose 自己的 Runtime；串行模式不能代替 cleanup。

提交变更前，运行完整项目验证：

```sh
npm run check
npm audit --audit-level=low
```

## 小型测试 ViewModel

```ts
import { describe, expect, it, vi } from 'vitest';
import { StateViewModel, ViewModelRuntime, viewModelSpec } from 'view_model/core';

type CounterState = Readonly<{
  count: number;
  label: string;
}>;

class CounterViewModel extends StateViewModel<CounterState> {
  public constructor() {
    super({ count: 0, label: 'counter' });
  }

  public increment(): boolean {
    return this.updateState((state) => ({ ...state, count: state.count + 1 }), 'counter.increment');
  }

  public replace(next: CounterState): boolean {
    return this.setState(next, 'counter.replace');
  }
}

const counterSpec = viewModelSpec(() => new CounterViewModel());
```

除非测试刻意验证模块级 identity，否则每个测试的 Spec 应保持局部。这样可以防止一个测试意外依赖另一个测试的声明或容器。

## 测试不可变 state 与直接订阅

```ts
it('notifies only when the state reference changes', () => {
  const runtime = new ViewModelRuntime();
  const binding = runtime.createBinding();
  const spec = viewModelSpec(() => new CounterViewModel());

  try {
    const counter = binding.read(spec);
    const listener = vi.fn();
    const unsubscribe = counter.subscribeState(listener);
    const initial = counter.state;

    expect(counter.replace(initial)).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    expect(counter.increment()).toBe(true);
    expect(listener).toHaveBeenCalledWith({
      previous: initial,
      current: counter.state,
    });

    unsubscribe();
  } finally {
    binding.dispose();
    runtime.dispose();
  }
});
```

即使 Runtime 已 paused，直接 `subscribe` 与 `subscribeState` callback 仍会同步运行。测试感知 pause 的 update delivery 时，使用 watched Binding 或 mounted hook。

## 测试 `read` 与 `watch`

```ts
it('read retains without ordinary Binding updates; watch propagates', () => {
  const onUpdate = vi.fn();
  const runtime = new ViewModelRuntime();
  const binding = runtime.createBinding({ onUpdate });
  const spec = viewModelSpec(() => new CounterViewModel());

  try {
    const counter = binding.read(spec);
    counter.increment();
    expect(onUpdate).not.toHaveBeenCalled();

    expect(binding.watch(spec)).toBe(counter);
    counter.increment();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  } finally {
    binding.dispose();
    runtime.dispose();
  }
});
```

`read` 仍然拥有该实例。这个测试区分的是通知传播，而不是 retention。

如果使用 `binding.watch(spec, listener)` 的可选 listener argument，应记住公开 method 返回 ViewModel，而不是 unsubscribe function。该 listener 会一直登记，直到 Binding entry 被移除或 Binding 被 dispose。host rendering 应优先使用 Binding 的 `onUpdate`；需要单独移除的直接 listener 时，使用 `viewModel.subscribe`。

## 刻意 flush 自动 disposal

普通零 owner disposal 通过 microtask 调度。生命周期测试可以使用小型 helper：

```ts
async function flushDisposals(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
```

```ts
it('disposes after the final owner leaves', async () => {
  const runtime = new ViewModelRuntime();
  const binding = runtime.createBinding();
  const spec = viewModelSpec(() => new CounterViewModel());
  const counter = binding.read(spec);

  binding.dispose();
  expect(counter.isDisposed).toBe(false);

  await flushDisposals();
  expect(counter.isDisposed).toBe(true);

  runtime.dispose();
});
```

该 helper 用于在测试中等待当前实现已经排队的 cleanup。生产代码不应通过计算 microtask 或轮询 `isDisposed` 来协调业务行为。

## 测试 unkeyed 与 keyed identity

```ts
it('keeps unkeyed identity private to a Binding', () => {
  const runtime = new ViewModelRuntime();
  const first = runtime.createBinding();
  const second = runtime.createBinding();
  const spec = viewModelSpec(() => new CounterViewModel());

  try {
    expect(first.read(spec)).toBe(first.read(spec));
    expect(second.read(spec)).not.toBe(first.read(spec));
  } finally {
    first.dispose();
    second.dispose();
    runtime.dispose();
  }
});
```

```ts
it('shares the same token and key within one Runtime', () => {
  const runtime = new ViewModelRuntime();
  const first = runtime.createBinding();
  const second = runtime.createBinding();
  const spec = viewModelSpec(() => new CounterViewModel(), {
    key: 'shared-counter',
  });

  try {
    expect(second.read(spec)).toBe(first.read(spec));
  } finally {
    first.dispose();
    second.dispose();
    runtime.dispose();
  }
});
```

identity 很重要时，还应测试反例：两个单独创建、文本 key 相同的 Spec 拥有不同 token，因此不能共享。

```ts
it('does not share a key across different Spec tokens', () => {
  const runtime = new ViewModelRuntime();
  const binding = runtime.createBinding();
  const firstSpec = viewModelSpec(() => new CounterViewModel(), { key: 'same' });
  const secondSpec = viewModelSpec(() => new CounterViewModel(), { key: 'same' });

  try {
    expect(binding.read(firstSpec)).not.toBe(binding.read(secondSpec));
  } finally {
    binding.dispose();
    runtime.dispose();
  }
});
```

## 测试生命周期 callback，而不是 constructor side effect

```ts
import { ViewModel } from 'view_model/core';

type LifecycleEvent =
  'create' | `bind:${string}` | `unbind:${string}` | 'pause' | 'resume' | 'dispose' | 'cleanup';

class LifecycleProbe extends ViewModel {
  public constructor(private readonly events: LifecycleEvent[]) {
    super();
  }

  protected override onCreate(): void {
    this.events.push('create');
    this.addDispose(() => this.events.push('cleanup'));
  }

  protected override onBind(bindingId: string): void {
    this.events.push(`bind:${bindingId}`);
  }

  protected override onUnbind(bindingId: string): void {
    this.events.push(`unbind:${bindingId}`);
  }

  protected override onPause(): void {
    this.events.push('pause');
  }

  protected override onResume(): void {
    this.events.push('resume');
  }

  protected override onDispose(): void {
    this.events.push('dispose');
  }
}
```

```ts
it('runs the activated generation lifecycle in order', async () => {
  const events: LifecycleEvent[] = [];
  const runtime = new ViewModelRuntime();
  const binding = runtime.createBinding({ id: 'screen' });
  const spec = viewModelSpec(() => new LifecycleProbe(events));

  binding.read(spec);
  expect(events).toEqual(['create', 'bind:screen']);

  binding.dispose();
  expect(events).toEqual(['create', 'bind:screen', 'unbind:screen']);

  await flushDisposals();
  expect(events).toEqual(['create', 'bind:screen', 'unbind:screen', 'dispose', 'cleanup']);

  runtime.dispose();
});
```

这证明 cleanup 附着于 activation，而不是 construction，也证明已登记 disposer 在 `onDispose` 后运行。

对 `onCreate` 或 `onBind` 期间可能抛错的资源添加失败测试。失败 generation 应被 dispose；后续解析应构造新 generation，而不是返回失败实例。

## 测试 pause token 聚合

```ts
it('resumes only after the final pause token is removed', () => {
  const updates = vi.fn();
  const events: LifecycleEvent[] = [];
  const runtime = new ViewModelRuntime();
  const binding = runtime.createBinding({ onUpdate: updates });
  const spec = viewModelSpec(() => new LifecycleProbe(events));
  const appToken = {};
  const windowToken = {};

  try {
    binding.watch(spec);
    runtime.pause(appToken);
    runtime.pause(windowToken);

    expect(runtime.isPaused).toBe(true);
    expect(events).toContain('pause');

    runtime.resume(appToken);
    expect(runtime.isPaused).toBe(true);
    expect(events).not.toContain('resume');

    runtime.resume(windowToken);
    expect(runtime.isPaused).toBe(false);
    expect(events).toContain('resume');
  } finally {
    binding.dispose();
    runtime.dispose();
  }
});
```

使用不同 object 表示独立 source。重复调用无参数 `pause()` 会使用同一个默认 token，并且幂等；它不会创建引用计数。

要测试延迟通知，可以添加调用 `notifyListeners` 的公开 action，在 paused 期间多次调用，然后断言最后一个 token resume 后，稳定 Binding callback 只投递一次。不要期待直接实例 subscriber 被延迟。

## 测试依赖传播

```ts
import { ViewModel, type ViewModelSpec } from 'view_model/core';

class ChildViewModel extends ViewModel {
  public change(): void {
    this.notifyListeners('child.change');
  }
}

class ParentViewModel extends ViewModel {
  public constructor(private readonly childDeclaration: ViewModelSpec<ChildViewModel>) {
    super();
  }

  public get childRead(): ChildViewModel {
    return this.viewModelBinding.read(this.childDeclaration);
  }

  public get childWatch(): ChildViewModel {
    return this.viewModelBinding.watch(this.childDeclaration);
  }
}
```

```ts
it('bubbles watched child changes to the parent owner', () => {
  const rootUpdate = vi.fn();
  const runtime = new ViewModelRuntime();
  const root = runtime.createBinding({ onUpdate: rootUpdate });
  const childSpec = viewModelSpec(() => new ChildViewModel());
  const parentSpec = viewModelSpec(() => new ParentViewModel(childSpec));

  try {
    const parent = root.watch(parentSpec);
    const child = parent.childWatch;

    child.change();

    expect(parent.version).toBe(1);
    expect(rootUpdate).toHaveBeenCalledTimes(1);
  } finally {
    root.dispose();
    runtime.dispose();
  }
});
```

编写对应的 `childRead` 测试，并断言普通 child 通知不会改变 `parent.version` 或调用 root update。两种模式都应保活 child，直到 parent 边被 release。

对于复杂模块图，应添加显式依赖环测试并期待 `ViewModelDependencyCycleError`。依赖环失败不应遗留半创建 generation 或已获取资源。

## 分别测试 `aliveForever` 与 recycle

`aliveForever` 改变零 owner 行为。Recycle 会忽略 owner count 与 permanence。

```ts
it('retains an aliveForever generation until explicit invalidation', async () => {
  const runtime = new ViewModelRuntime();
  const binding = runtime.createBinding();
  const spec = viewModelSpec(() => new CounterViewModel(), {
    key: 'application-counter',
    aliveForever: true,
  });
  const counter = binding.read(spec);

  binding.dispose();
  await flushDisposals();
  expect(counter.isDisposed).toBe(false);

  expect(runtime.recycle(spec)).toBe(1);
  expect(counter.isDisposed).toBe(true);
  expect(runtime.recycle(spec)).toBe(0);

  runtime.dispose();
});
```

测试 unkeyed recycle 时，应区分目标形式：

- `runtime.recycle(instance)` 应只使该 generation 失效；
- `runtime.recycle(unkeyedSpec)` 应使该 Runtime 内每个匹配的私有 generation 失效。

recycle 后，断言旧引用已 disposed，而且解析稳定 Spec 会得到不同实例。

## 通过 commit 测试 React adapter

使用 `react-test-renderer` 或宿主应用偏好的 React Native/Electron renderer 测试环境。mount、update、生命周期 emit、recycle 与 unmount 都应包在 `act` 中。

```tsx
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  ViewModelRuntime,
  ViewModelScope,
  useReadViewModel,
  useViewModelSelector,
  viewModelSpec,
  type ElectronLifecycleSource,
} from 'view_model/electron';

class FakeLifecycle implements ElectronLifecycleSource {
  public active = true;
  readonly #listeners = new Set<(active: boolean) => void>();

  public isActive(): boolean {
    return this.active;
  }

  public subscribe(listener: (active: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public emit(active: boolean): void {
    this.active = active;
    this.#listeners.forEach((listener) => listener(active));
  }
}
```

```tsx
it('rerenders a selector only when its selected value changes', async () => {
  const runtime = new ViewModelRuntime();
  const lifecycle = new FakeLifecycle();
  const spec = viewModelSpec(() => new CounterViewModel());
  let counter: CounterViewModel | undefined;
  let selected = -1;
  let renders = 0;
  let renderer: ReactTestRenderer | undefined;

  function Actions(): null {
    counter = useReadViewModel(spec);
    return null;
  }

  function Consumer(): null {
    selected = useViewModelSelector(spec, (counter) => counter.state.count);
    renders += 1;
    return null;
  }

  try {
    await act(async () => {
      renderer = create(
        <ViewModelScope runtime={runtime} lifecycle={lifecycle}>
          <Actions />
          <Consumer />
        </ViewModelScope>,
      );
    });

    expect(selected).toBe(0);
    const initialRenders = renders;

    act(() => {
      counter?.replace({ count: 0, label: 'renamed' });
    });
    expect(selected).toBe(0);
    expect(renders).toBe(initialRenders);

    act(() => {
      counter?.increment();
    });
    expect(selected).toBe(1);
    expect(renders).toBe(initialRenders + 1);
  } finally {
    await act(async () => {
      renderer?.unmount();
      await flushDisposals();
    });
    runtime.dispose();
  }
});
```

因为该测试注入 Runtime，所以测试拥有最终 `runtime.dispose()` 的责任。

有价值的 adapter 断言包括：

- 同一个 Scope 中两个 consumer 得到同一个 unkeyed 实例；
- 嵌套 Scope 继承 Runtime，但得到另一个 unkeyed 实例；
- `useViewModel` 在每次普通通知时重新 render；
- `useReadViewModel` 忽略普通通知，但在 recycle 后迁移；
- `useViewModelSelector` 忽略无关 state，并且在新 generation 选中相等值时仍会迁移；
- 真正 unmount 最终会 unbind 并 dispose；
- StrictMode effect probing 不会重复逻辑 bind；
- commit 时 inactive 的 lifecycle source 依次产生 `onCreate`、`onPause` 与 bind；
- 多个 Scope lifecycle token 会让共享 Runtime 保持 paused，直到全部 active。

## 测试 StrictMode 与 abandoned render 行为

StrictMode、Suspense 或并发 render 下，constructor count 可能高于 activation count。这符合预期：construction 是 provisional，而 `onCreate` 表示已 commit 的 acquire。

测试应断言 invariant，而不是假设 constructor 只调用一次：

- abandoned render 不调用 `onCreate`；
- abandoned generation 不保留外部资源；
- committed generation 针对其 Scope Binding ID 只获得一次逻辑 bind；
- 真正 unmount 最终调用 `onUnbind`、`onDispose` 与已登记 cleanup；
- mounted hook 在 recycle 后迁移到新 generation。

如果 Suspense 测试创建永不 resolve 的 Promise，cleanup 中必须 unmount renderer，并 dispose 每个已注入 Runtime。

## 在边界测试平台 lifecycle source

对于 React Native，fake `AppState` 应证明：

- 只有 `'active'` 映射为 active；
- `'inactive'`、`'background'`、`null` 与其他状态映射为 inactive；
- cleanup 调用 subscription 的 `remove()`。

对于 Electron renderer，fake window 与 document target 应证明：

- blur 使 source inactive；
- hidden visibility 使其 inactive；
- 只有 focused 且 visible 时才 active；
- 所有已安装 event listener 都被移除；
- 没有 renderer global 的环境会安全地保持 active。

adapter 测试应与业务 ViewModel 测试分离。业务模块不应仅为了证明 state 与依赖行为而需要 DOM 或 React Native bridge。

## Cleanup checklist

每个测试都应：

1. 直接 listener 的生命周期属于测试内容时，执行 unsubscribe；
2. dispose plain Binding；
3. 在 `act` 内 unmount React renderer；
4. 断言自动 release 时 flush 已排队 lifecycle cleanup；
5. dispose 测试创建或注入的每个 Runtime；
6. 在 `finally` 或 `afterEach` 中恢复 spy 与全局测试 flag。

干净 shutdown 本身就是依赖边、subscription、timer 与 native adapter 没有泄漏的证据。

## 相关指南

- [快速开始](./getting-started.md)
- [ViewModel 与 state](./view-models.md)
- [依赖注入](./dependency-injection.md)
- [身份与生命周期](./identity-and-lifetime.md)
