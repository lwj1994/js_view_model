# Testing

[简体中文](./zh/testing.md)

Test ViewModels primarily through their public actions, Specs, Runtime, and Bindings. Add platform adapter tests where React commit timing or native lifecycle mapping matters.

The most valuable tests cover behavior that ordinary UI snapshots cannot prove:

- state equality and notifications;
- `read` versus `watch` propagation;
- unkeyed and keyed identity;
- owner release and final disposal;
- `aliveForever` and recycle;
- parent-child dependency edges and cycles;
- source-aware root propagation and synchronous notification transaction deduplication;
- pause token aggregation;
- React commit, StrictMode, and generation replacement;
- React Native AppState or Electron focus/visibility mapping.

Do not build application tests around internal methods such as `prepare`, hook subscription plumbing, or generation snapshots. Those methods are implementation details and are stripped from the public TypeScript declarations.

## Run tests serially

This repository configures Vitest without file parallelism:

```sh
npm test
```

The equivalent direct command is:

```sh
vitest run --no-file-parallelism
```

Serial execution keeps Runtime lifecycle timing and process-wide diagnostic counters deterministic. Individual assertions should still create and dispose their own Runtime; serial mode is not a substitute for cleanup.

Before submitting changes, run the complete project validation:

```sh
npm run check
npm audit --audit-level=low
```

## A small test ViewModel

```ts
import { describe, expect, it, vi } from 'vitest';
import { StateViewModel, ViewModelRuntime, viewModelSpec } from '@lwjlol/view_model/core';

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

const counterSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel());
```

Keep each test's Spec local unless the test is intentionally proving module-level identity. Use the explicit-type overload for normal tests; this prevents one test from accidentally relying on another test's declaration or container without giving up production identity semantics.

## Test immutable state and direct subscriptions

```ts
it('notifies only when the state reference changes', () => {
  const runtime = new ViewModelRuntime();
  const binding = runtime.createBinding();
  const spec = viewModelSpec(CounterViewModel, () => new CounterViewModel());

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

Direct `subscribe` and `subscribeState` callbacks run synchronously even while the Runtime is paused. Use a watched Binding or a mounted hook when testing pause-aware update delivery.

## Test `read` and `watch`

```ts
it('read retains without ordinary Binding updates; watch propagates', () => {
  const onUpdate = vi.fn();
  const runtime = new ViewModelRuntime();
  const binding = runtime.createBinding({ onUpdate });
  const spec = viewModelSpec(CounterViewModel, () => new CounterViewModel());

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

`read` still owns the instance. This test distinguishes notification propagation, not retention.

If using the optional listener argument of `binding.watch(spec, listener)`, remember that the public method returns the ViewModel, not an unsubscribe function. That listener remains registered until the Binding entry is removed or the Binding is disposed. Prefer the Binding's `onUpdate` for host rendering, or use `viewModel.subscribe` when an individually removable direct listener is required.

## Flush automatic disposal deliberately

Ordinary zero-owner disposal is scheduled through a microtask. Use a small helper in lifecycle tests:

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
  const spec = viewModelSpec(CounterViewModel, () => new CounterViewModel());
  const counter = binding.read(spec);

  binding.dispose();
  expect(counter.isDisposed).toBe(false);

  await flushDisposals();
  expect(counter.isDisposed).toBe(true);

  runtime.dispose();
});
```

The helper is for settling the current implementation's queued cleanup in tests. Production code should not coordinate business behavior by counting microtasks or polling `isDisposed`.

## Test unkeyed and keyed identity

```ts
it('keeps unkeyed identity private to a Binding', () => {
  const runtime = new ViewModelRuntime();
  const first = runtime.createBinding();
  const second = runtime.createBinding();
  const spec = viewModelSpec(CounterViewModel, () => new CounterViewModel());

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
it('shares explicit type and key across independent Specs', () => {
  const runtime = new ViewModelRuntime();
  const first = runtime.createBinding();
  const second = runtime.createBinding();
  const firstSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel(), {
    key: 'shared-counter',
  });
  const secondSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel(), {
    key: 'shared-counter',
  });

  try {
    expect(second.read(secondSpec)).toBe(first.read(firstSpec));
  } finally {
    first.dispose();
    second.dispose();
    runtime.dispose();
  }
});
```

The builder-only overload is a compatibility fallback. Each separately created builder-only Spec receives a private token, so equal textual keys do not make those fallback Specs share:

```ts
it('keeps independent builder-only fallback tokens isolated', () => {
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

## Test lifecycle callbacks, not constructor side effects

```ts
import { ViewModel } from '@lwjlol/view_model/core';

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
  const spec = viewModelSpec(LifecycleProbe, () => new LifecycleProbe(events));

  binding.read(spec);
  expect(events).toEqual(['create', 'bind:screen']);

  binding.dispose();
  expect(events).toEqual(['create', 'bind:screen', 'unbind:screen']);

  await flushDisposals();
  expect(events).toEqual(['create', 'bind:screen', 'unbind:screen', 'dispose', 'cleanup']);

  runtime.dispose();
});
```

This proves that cleanup is attached to activation, not construction, and that registered disposers run after `onDispose`.

Add failure tests for resources that can throw during `onCreate` or `onBind`. The failed generation should be disposed, and a later resolution should construct a new generation rather than return the failed one.

## Test pause token aggregation

```ts
it('resumes only after the final pause token is removed', () => {
  const updates = vi.fn();
  const events: LifecycleEvent[] = [];
  const runtime = new ViewModelRuntime();
  const binding = runtime.createBinding({ onUpdate: updates });
  const spec = viewModelSpec(LifecycleProbe, () => new LifecycleProbe(events));
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

Use distinct objects to represent independent sources. Repeating no-argument `pause()` uses the same default token and is idempotent; it does not create a reference count.

To test deferred notifications, add a public action that calls `notifyListeners`, invoke it several times while paused, and assert that a stable Binding callback is delivered once after the last token resumes. Do not expect direct instance subscribers to be deferred.

## Test dependency propagation

```ts
import { ViewModel, type ViewModelSpec } from '@lwjlol/view_model/core';

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
  const childSpec = viewModelSpec(ChildViewModel, () => new ChildViewModel());
  const parentSpec = viewModelSpec(ParentViewModel, () => new ParentViewModel(childSpec));

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

Write the corresponding `childRead` test and assert that an ordinary child notification does not change `parent.version` or call the root update. Both modes should still keep the child alive until the parent edge is released.

For source-aware child lifetime, create a shared keyed parent with root Bindings A and B. Resolve an unkeyed child both before and after adding B, then assert that the child receives the current root IDs in `onBind`, removes only A when A leaves, preserves the same generation while B remains, and receives one `onUnbind` only after the last direct or parent source for each logical root ID leaves. Include a direct leaf path plus two parent paths, and extend one case through multiple dependency levels.

For synchronous notification transactions, use a diamond graph and optionally let the root watch the shared leaf directly. One synchronous leaf change should notify each parent and each Binding owner/callback pair at most once. If two Bindings deliberately reuse the same callback function, each owner/callback pair should still run once; a notification scheduled in a later microtask should start a new transaction.

For complex module graphs, add an explicit cycle test and expect `ViewModelDependencyCycleError`. A cycle failure should not leave a half-created generation or acquired resource behind.

## Test `aliveForever` and recycle separately

`aliveForever` changes zero-owner behavior. Recycle ignores owner counts and permanence.

```ts
it('retains an aliveForever generation until explicit invalidation', async () => {
  const runtime = new ViewModelRuntime();
  const binding = runtime.createBinding();
  const spec = viewModelSpec(CounterViewModel, () => new CounterViewModel(), {
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

When testing unkeyed recycle, distinguish the target forms:

- `runtime.recycle(instance)` should invalidate exactly that generation;
- `runtime.recycle(unkeyedSpec)` should invalidate every matching private generation in that Runtime.

After recycle, assert that the old reference is disposed and that resolving the stable Spec yields a different instance.

## Test React adapters through commit

Use `react-test-renderer` or the host application's preferred React Native/Electron renderer test environment. Wrap mount, updates, lifecycle emissions, recycle, and unmount in `act`.

```tsx
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  ViewModelRuntime,
  ViewModelScope,
  useReadViewModel,
  useViewModelSelector,
  viewModelSpec,
  type ElectronLifecycleSource,
} from '@lwjlol/view_model/electron';

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
  const spec = viewModelSpec(CounterViewModel, () => new CounterViewModel());
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

Because this test injects a Runtime, the test owns final `runtime.dispose()`.

Useful adapter assertions include:

- two consumers in one Scope receive the same unkeyed instance;
- a nested Scope inherits the Runtime but receives another unkeyed instance;
- `useViewModel` rerenders on every ordinary notification;
- `useReadViewModel` ignores ordinary notifications but migrates after recycle;
- `useViewModelSelector` ignores unrelated state and still migrates when a new generation selects an equal value;
- a real unmount eventually unbinds and disposes;
- StrictMode effect probing does not duplicate the logical bind;
- a lifecycle source inactive at commit produces `onCreate`, then `onPause`, then bind;
- several Scope lifecycle tokens keep the shared Runtime paused until all are active.

## Test StrictMode and abandoned render behavior

Constructor counts may exceed activation counts under StrictMode, Suspense, or concurrent rendering. That is expected: construction is provisional, while `onCreate` represents committed acquisition.

Tests should assert invariants instead of assuming one constructor call:

- abandoned renders do not call `onCreate`;
- abandoned generations do not retain external resources;
- a committed generation receives one logical bind for its Scope Binding ID;
- true unmount eventually calls `onUnbind`, `onDispose`, and registered cleanups;
- a mounted hook migrates to a new generation after recycle.

If a Suspense test creates a never-resolving promise, make sure the renderer is unmounted and every injected Runtime is disposed in cleanup.

## Test platform lifecycle sources at their boundary

For React Native, a fake `AppState` should prove:

- only `'active'` maps to active;
- `'inactive'`, `'background'`, `null`, and other states map to inactive;
- cleanup calls the subscription's `remove()`.

For Electron renderer, fake window and document targets should prove:

- blur makes the source inactive;
- hidden visibility makes it inactive;
- it becomes active only when focused and visible;
- all installed event listeners are removed;
- an environment without renderer globals remains safely active.

Keep adapter tests separate from business ViewModel tests. A business module should not need a DOM or React Native bridge merely to prove its state and dependency behavior.

## Cleanup checklist

For every test:

1. unsubscribe direct listeners when their lifetime is part of the test;
2. dispose plain Bindings;
3. unmount React renderers inside `act`;
4. flush queued lifecycle cleanup when asserting automatic release;
5. dispose every Runtime created or injected by the test;
6. restore spies and global test flags in `finally` or `afterEach`.

Clean shutdown is itself evidence that dependency edges, subscriptions, timers, and native adapters do not leak.

## Related guides

- [Getting started](./getting-started.md)
- [ViewModels and state](./view-models.md)
- [Dependency injection](./dependency-injection.md)
- [Identity and lifetime](./identity-and-lifetime.md)
