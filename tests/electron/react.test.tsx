import { StrictMode, Suspense } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  StateViewModel,
  ViewModel,
  ViewModelRuntime,
  ViewModelScope,
  useReadViewModel,
  useViewModel,
  useViewModelRuntime,
  useViewModelSelector,
  viewModelSpec,
  type ElectronLifecycleSource,
} from '../../src/electron/index.js';

class FakeLifecycle implements ElectronLifecycleSource {
  active = true;
  private readonly listeners = new Set<(active: boolean) => void>();

  isActive(): boolean {
    return this.active;
  }

  subscribe(listener: (active: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(active: boolean): void {
    this.active = active;
    this.listeners.forEach((listener) => listener(active));
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Electron React 绑定', () => {
  let renderer: ReactTestRenderer | undefined;
  let runtimes: ViewModelRuntime[] = [];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    runtimes = [];
  });

  afterEach(async () => {
    if (renderer !== undefined) {
      await act(async () => {
        renderer?.unmount();
        await flushMicrotasks();
      });
      renderer = undefined;
    }

    runtimes.forEach((runtime) => runtime.dispose());
  });

  it('同 Scope 共享 unkeyed 实例，嵌套 Scope 默认共用 runtime 但隔离实例', async () => {
    class LocalViewModel extends ViewModel {}

    const spec = viewModelSpec(() => new LocalViewModel());
    const runtime = new ViewModelRuntime();
    runtimes.push(runtime);
    const lifecycle = new FakeLifecycle();
    const instances: Partial<Record<'first' | 'second' | 'nested', LocalViewModel>> = {};
    const resolvedRuntimes: Partial<Record<'first' | 'second' | 'nested', ViewModelRuntime>> = {};

    function Capture({ id }: { readonly id: 'first' | 'second' | 'nested' }): null {
      instances[id] = useViewModel(spec);
      resolvedRuntimes[id] = useViewModelRuntime();
      return null;
    }

    await act(async () => {
      renderer = create(
        <ViewModelScope runtime={runtime} lifecycle={lifecycle}>
          <Capture id="first" />
          <Capture id="second" />
          <ViewModelScope lifecycle={lifecycle}>
            <Capture id="nested" />
          </ViewModelScope>
        </ViewModelScope>,
      );
    });

    expect(instances.first).toBe(instances.second);
    expect(instances.nested).not.toBe(instances.first);
    expect(resolvedRuntimes).toEqual({ first: runtime, second: runtime, nested: runtime });
  });

  it('区分 watch、read 与 selector 更新语义', async () => {
    interface State {
      readonly count: number;
      readonly label: string;
    }

    class CounterViewModel extends StateViewModel<State> {
      constructor() {
        super({ count: 0, label: 'zero' });
      }

      increment(): void {
        this.updateState((state) => ({ ...state, count: state.count + 1 }));
      }

      rename(label: string): void {
        this.updateState((state) => ({ ...state, label }));
      }
    }

    const spec = viewModelSpec(() => new CounterViewModel());
    const runtime = new ViewModelRuntime();
    runtimes.push(runtime);
    const lifecycle = new FakeLifecycle();
    let counter: CounterViewModel | undefined;
    let watchRenders = 0;
    let readRenders = 0;
    let selectorRenders = 0;

    function WatchConsumer(): null {
      counter = useViewModel(spec);
      watchRenders += 1;
      return null;
    }

    function ReadConsumer(): null {
      useReadViewModel(spec);
      readRenders += 1;
      return null;
    }

    function SelectorConsumer(): null {
      useViewModelSelector(spec, (viewModel) => viewModel.state.label);
      selectorRenders += 1;
      return null;
    }

    await act(async () => {
      renderer = create(
        <ViewModelScope runtime={runtime} lifecycle={lifecycle}>
          <WatchConsumer />
          <ReadConsumer />
          <SelectorConsumer />
        </ViewModelScope>,
      );
    });

    const initialWatchRenders = watchRenders;
    const initialReadRenders = readRenders;
    const initialSelectorRenders = selectorRenders;

    act(() => counter?.increment());
    expect(watchRenders).toBe(initialWatchRenders + 1);
    expect(readRenders).toBe(initialReadRenders);
    expect(selectorRenders).toBe(initialSelectorRenders);

    act(() => counter?.rename('one'));
    expect(watchRenders).toBe(initialWatchRenders + 2);
    expect(readRenders).toBe(initialReadRenders);
    expect(selectorRenders).toBe(initialSelectorRenders + 1);
  });

  it('StrictMode 的 effect 探测不会重复 bind，并在真实卸载后 dispose', async () => {
    const events = { create: 0, bind: 0, unbind: 0, pause: 0, resume: 0, dispose: 0 };

    class LifecycleViewModel extends ViewModel {
      protected override onCreate(): void {
        events.create += 1;
      }

      protected override onBind(): void {
        events.bind += 1;
      }

      protected override onUnbind(): void {
        events.unbind += 1;
      }

      protected override onPause(): void {
        events.pause += 1;
      }

      protected override onResume(): void {
        events.resume += 1;
      }

      protected override onDispose(): void {
        events.dispose += 1;
      }
    }

    const spec = viewModelSpec(() => new LifecycleViewModel());
    const runtime = new ViewModelRuntime();
    runtimes.push(runtime);
    const lifecycle = new FakeLifecycle();
    lifecycle.active = false;

    function Consumer(): null {
      useViewModel(spec);
      return null;
    }

    await act(async () => {
      renderer = create(
        <StrictMode>
          <ViewModelScope runtime={runtime} lifecycle={lifecycle}>
            <Consumer />
          </ViewModelScope>
        </StrictMode>,
      );
    });

    expect(events.create).toBe(1);
    expect(events.bind).toBe(1);
    expect(events.unbind).toBe(0);
    expect(events.pause).toBe(1);
    expect(events.resume).toBe(0);
    expect(events.dispose).toBe(0);

    await act(async () => {
      renderer?.unmount();
      renderer = undefined;
      await flushMicrotasks();
    });

    expect(events.unbind).toBe(1);
    expect(events.dispose).toBe(1);
  });

  it('清扫 Suspense 放弃 render 中未 commit 的 provisional generation', async () => {
    const events = { constructs: 0, creates: 0, disposes: 0 };

    class ProvisionalViewModel extends ViewModel {
      constructor() {
        super();
        events.constructs += 1;
      }

      protected override onCreate(): void {
        events.creates += 1;
      }

      protected override onDispose(): void {
        events.disposes += 1;
      }
    }

    const spec = viewModelSpec(() => new ProvisionalViewModel());
    const runtime = new ViewModelRuntime();
    runtimes.push(runtime);
    const lifecycle = new FakeLifecycle();
    const never = new Promise<void>(() => undefined);

    function SuspendedConsumer(): null {
      useViewModel(spec);
      throw never;
    }

    await act(async () => {
      renderer = create(
        <ViewModelScope runtime={runtime} lifecycle={lifecycle}>
          <Suspense fallback={null}>
            <SuspendedConsumer />
          </Suspense>
        </ViewModelScope>,
      );
      await flushMicrotasks();
    });

    expect(events.constructs).toBeGreaterThan(0);
    expect(events.creates).toBe(0);
    expect(events.disposes).toBe(0);
    expect(runtime.recycle(spec)).toBe(0);
  });

  it('mounted hook 在 recycle 后切换 generation 并继续接收更新', async () => {
    class RecyclableViewModel extends StateViewModel<number> {
      constructor() {
        super(0);
      }

      increment(): void {
        this.updateState((value) => value + 1);
      }
    }

    const spec = viewModelSpec(() => new RecyclableViewModel());
    const runtime = new ViewModelRuntime();
    runtimes.push(runtime);
    const lifecycle = new FakeLifecycle();
    let current: RecyclableViewModel | undefined;
    let renders = 0;

    function Consumer(): null {
      current = useViewModel(spec);
      renders += 1;
      return null;
    }

    await act(async () => {
      renderer = create(
        <ViewModelScope runtime={runtime} lifecycle={lifecycle}>
          <Consumer />
        </ViewModelScope>,
      );
    });

    const previous = current;
    const rendersBeforeRecycle = renders;
    act(() => {
      runtime.recycle(spec);
    });

    expect(current).toBeDefined();
    expect(current).not.toBe(previous);
    expect(renders).toBeGreaterThan(rendersBeforeRecycle);

    const rendersBeforeUpdate = renders;
    act(() => current?.increment());
    expect(renders).toBe(rendersBeforeUpdate + 1);
  });

  it('selector 在新 generation 选中值相同时仍会迁移订阅', async () => {
    class SelectableViewModel extends StateViewModel<number> {
      constructor() {
        super(0);
      }

      increment(): void {
        this.updateState((value) => value + 1);
      }
    }

    const spec = viewModelSpec(() => new SelectableViewModel());
    const runtime = new ViewModelRuntime();
    runtimes.push(runtime);
    const lifecycle = new FakeLifecycle();
    let current: SelectableViewModel | undefined;
    let selected = -1;
    let selectorRenders = 0;

    function ActionConsumer(): null {
      current = useReadViewModel(spec);
      return null;
    }

    function SelectorConsumer(): null {
      selected = useViewModelSelector(spec, (viewModel) => viewModel.state);
      selectorRenders += 1;
      return null;
    }

    await act(async () => {
      renderer = create(
        <ViewModelScope runtime={runtime} lifecycle={lifecycle}>
          <ActionConsumer />
          <SelectorConsumer />
        </ViewModelScope>,
      );
    });

    const previous = current;
    const rendersBeforeRecycle = selectorRenders;
    act(() => {
      runtime.recycle(spec);
    });

    expect(current).not.toBe(previous);
    expect(selected).toBe(0);
    expect(selectorRenders).toBeGreaterThan(rendersBeforeRecycle);

    const rendersBeforeUpdate = selectorRenders;
    act(() => current?.increment());
    expect(selected).toBe(1);
    expect(selectorRenders).toBe(rendersBeforeUpdate + 1);
  });

  it('用独立 token 聚合多个窗口的 pause / resume', async () => {
    const runtime = new ViewModelRuntime();
    runtimes.push(runtime);
    const first = new FakeLifecycle();
    const second = new FakeLifecycle();

    await act(async () => {
      renderer = create(
        <ViewModelScope runtime={runtime} lifecycle={first}>
          <ViewModelScope lifecycle={second}>{null}</ViewModelScope>
        </ViewModelScope>,
      );
    });

    act(() => first.emit(false));
    expect(runtime.isPaused).toBe(true);

    act(() => second.emit(false));
    act(() => first.emit(true));
    expect(runtime.isPaused).toBe(true);

    act(() => second.emit(true));
    expect(runtime.isPaused).toBe(false);
  });

  it('lifecycle subscribe 安装失败时会回滚自己的 pause token', async () => {
    const runtime = new ViewModelRuntime();
    runtimes.push(runtime);
    const lifecycle: ElectronLifecycleSource = {
      isActive: () => false,
      subscribe: () => {
        throw new Error('subscribe failed');
      },
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(
        act(async () => {
          renderer = create(
            <ViewModelScope runtime={runtime} lifecycle={lifecycle}>
              {null}
            </ViewModelScope>,
          );
        }),
      ).rejects.toThrow('subscribe failed');
      expect(runtime.isPaused).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('lifecycle unsubscribe 抛错时仍会释放自己的 pause token', async () => {
    const runtime = new ViewModelRuntime();
    runtimes.push(runtime);
    const lifecycle: ElectronLifecycleSource = {
      isActive: () => false,
      subscribe: () => () => {
        throw new Error('unsubscribe failed');
      },
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await act(async () => {
      renderer = create(
        <ViewModelScope runtime={runtime} lifecycle={lifecycle}>
          {null}
        </ViewModelScope>,
      );
    });
    expect(runtime.isPaused).toBe(true);

    const mounted = renderer;
    renderer = undefined;
    try {
      await expect(
        act(async () => {
          mounted?.unmount();
          await flushMicrotasks();
        }),
      ).rejects.toThrow('unsubscribe failed');
      await flushMicrotasks();
      expect(runtime.isPaused).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });
});
