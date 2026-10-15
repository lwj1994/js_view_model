import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  ErrorType,
  StateViewModel,
  ViewModel,
  ViewModelRuntime,
  ViewModelSpec,
  ViewModelSpecError,
  viewModelSpec,
  type Equality,
  type ViewModelLifecycle,
} from '../../src/core/index.js';

let errors: unknown[] = [];
const runtimes: ViewModelRuntime[] = [];
const runtime = () => {
  const value = new ViewModelRuntime();
  runtimes.push(value);
  return value;
};
beforeEach(() => {
  ViewModel.reset();
  errors = [];
  ViewModel.initialize({ config: { onError: (error) => errors.push(error) } });
});
afterEach(() => {
  for (const value of runtimes.splice(0)) value.dispose();
  ViewModel.reset();
  expect(errors).toEqual([]);
});
class Item extends StateViewModel<number> {
  constructor(value = 0, equals?: Equality<number>) {
    super(value, equals);
  }
  set(value: number): boolean {
    return this.setState(value);
  }
}

function config(options: Parameters<typeof ViewModel.initialize>[0]): void {
  ViewModel.reset();
  ViewModel.initialize(options);
}

describe('Flutter API and configuration parity', () => {
  it('update notifies synchronously and returns the mutation value', () => {
    const binding = runtime().createBinding();
    const item = binding.read(viewModelSpec(Item, () => new Item()));
    const events: string[] = [];
    item.listen(() => events.push('notify'));
    expect(
      item.update(() => {
        events.push('mutation');
        return 42;
      }),
    ).toBe(42);
    events.push('returned');
    expect(events).toEqual(['mutation', 'notify', 'returned']);
  });
  it('update awaits async success and never notifies on sync/async failure', async () => {
    const item = runtime()
      .createBinding()
      .read(viewModelSpec(Item, () => new Item()));
    const notify = vi.fn();
    item.listen(notify);
    let finish!: () => void;
    const pending = item.update('save', async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return 7;
    });
    expect(notify).not.toHaveBeenCalled();
    finish();
    await expect(pending).resolves.toBe(7);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(() =>
      item.update(() => {
        throw new Error('sync');
      }),
    ).toThrow('sync');
    await expect(
      item.update(async () => {
        throw new Error('async');
      }),
    ).rejects.toThrow('async');
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it('late async completion and late state writes cannot revive a disposed generation', async () => {
    const app = runtime();
    const item = app.createBinding().read(viewModelSpec(Item, () => new Item()));
    const notify = vi.fn();
    item.listen(notify);
    let finish!: () => void;
    const pending = item.update(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    app.recycle(item);
    finish();
    await pending;
    expect(item.set(1)).toBe(false);
    item.notifyListeners();
    expect(item.state).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });
  it('exposes initial and previous state; broad notifications never replay a diff', () => {
    const binding = runtime().createBinding();
    const spec = viewModelSpec(Item, () => new Item(4));
    const item = binding.read(spec);
    expect(item.initState).toBe(4);
    expect(item.initialState).toBe(4);
    expect(item.previousState).toBeUndefined();
    const changed = vi.fn();
    binding.listenState(spec, changed);
    item.set(5);
    item.notifyListeners();
    expect(changed).toHaveBeenCalledExactlyOnceWith(4, 5);
    expect(item.previousState).toBe(4);
    expect(item.initState).toBe(4);
  });
  it('keeps nullable state values in both positional callback parameters', () => {
    class Nullable extends StateViewModel<number | null> {
      constructor() {
        super(null);
      }
      set(value: number | null) {
        this.setState(value);
      }
    }
    const binding = runtime().createBinding();
    const spec = viewModelSpec(Nullable, () => new Nullable());
    const seen: (number | null)[][] = [];
    binding.listenState(spec, (previous, current) => {
      expectTypeOf(previous).toEqualTypeOf<number | null>();
      seen.push([previous, current]);
    });
    binding.read(spec).set(2);
    binding.read(spec).set(null);
    expect(seen).toEqual([
      [null, 2],
      [2, null],
    ]);
  });
  it('applies local then global equality to state and selected reactions', () => {
    config({ config: { equals: () => true } });
    const binding = runtime().createBinding();
    const globalSpec = viewModelSpec(Item, () => new Item(), { key: 'global' });
    const localSpec = viewModelSpec(Item, () => new Item(0, Object.is), { key: 'local' });
    expect(binding.read(globalSpec).set(1)).toBe(false);
    const selectedGlobal = vi.fn();
    const selectedLocal = vi.fn();
    const direct = vi.fn();
    binding.listenStateSelect(localSpec, (value) => value, selectedGlobal);
    binding.listenStateSelect(localSpec, (value) => value, selectedLocal, Object.is);
    binding.read(localSpec).listenStateSelect((value) => value % 2, direct, Object.is);
    binding.read(localSpec).set(1);
    binding.read(localSpec).set(3);
    expect(selectedGlobal).not.toHaveBeenCalled();
    expect(selectedLocal).toHaveBeenCalledTimes(2);
    expect(direct).toHaveBeenCalledExactlyOnceWith(0, 1);
  });
  it('equality errors leave state unchanged and use the unified error sink', () => {
    const failure = new Error('equals');
    const item = runtime()
      .createBinding()
      .read(
        viewModelSpec(
          Item,
          () =>
            new Item(0, () => {
              throw failure;
            }),
        ),
      );
    expect(item.set(1)).toBe(false);
    expect(item.state).toBe(0);
    expect(item.previousState).toBeUndefined();
    expect(errors.splice(0)).toEqual([failure]);
  });
  it('preserves duplicate raw listeners and independent subscribe disposers', () => {
    const item = runtime()
      .createBinding()
      .read(viewModelSpec(Item, () => new Item()));
    const callback = vi.fn();
    item.addListener(callback);
    item.addListener(callback);
    item.removeListener(callback);
    item.notifyListeners();
    expect(callback).toHaveBeenCalledTimes(1);
    item.removeListener(callback);
    expect(item.hasListeners).toBe(false);
    const first = item.subscribe(callback);
    const second = item.subscribe(callback);
    first();
    first();
    item.notifyListeners();
    expect(callback).toHaveBeenCalledTimes(2);
    second();
    expect(item.hasListeners).toBe(false);
  });
  it('does not call listeners added in the middle of a notification', () => {
    const item = runtime()
      .createBinding()
      .read(viewModelSpec(Item, () => new Item()));
    const later = vi.fn();
    const early = item.listen(() => {
      item.listen(later);
    });
    item.notifyListeners();
    expect(later).not.toHaveBeenCalled();
    early();
    item.notifyListeners();
    expect(later).toHaveBeenCalledOnce();
  });
  it('runs constructor cleanup once when the builder throws', () => {
    const dispose = vi.fn();
    class Failed extends ViewModel {
      constructor() {
        super();
        this.addDispose(dispose);
        throw new Error('construction');
      }
    }
    const app = runtime();
    const binding = app.createBinding();
    expect(() => binding.read(viewModelSpec(Failed, () => new Failed()))).toThrow('construction');
    expect(dispose).toHaveBeenCalledOnce();
    expect(app.countInstances()).toBe(0);
    expect(app.getDiagnostics().bindings).toHaveLength(1);
  });
  it('cancels only the chosen cleanup registration and finishes after an error', () => {
    const app = runtime();
    const item = app.createBinding().read(viewModelSpec(Item, () => new Item()));
    const order: string[] = [];
    const failure = new Error('cleanup');
    item.addDispose(() => order.push('first'));
    const cancel = item.addDispose(() => order.push('cancelled'));
    cancel();
    cancel();
    item.addDispose(() => {
      order.push('last');
      throw failure;
    });
    app.recycle(item);
    app.recycle(item);
    expect(order).toEqual(['last', 'first']);
    expect(errors.splice(0)).toEqual([failure]);
  });
  it('reports listener/lifecycle/pause/dispose errors without aborting cleanup when the sink throws', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn(() => {
      throw new Error('sink');
    });
    config({ config: { onError: handler } });
    class Failed extends ViewModel {
      protected override onCreate() {
        throw new Error('create');
      }
      protected override onBind() {
        throw new Error('bind');
      }
      protected override onUnbind() {
        throw new Error('unbind');
      }
      protected override onPause() {
        throw new Error('pause');
      }
      protected override onResume() {
        throw new Error('resume');
      }
      protected override onDispose() {
        throw new Error('dispose');
      }
    }
    const app = runtime();
    const item = app.createBinding().read(viewModelSpec(Failed, () => new Failed()));
    const other = vi.fn();
    item.listen(() => {
      throw new Error('listener');
    });
    item.listen(other);
    item.notifyListeners();
    app.pause();
    app.resume();
    app.dispose();
    expect(item.isDisposed).toBe(true);
    expect(other).toHaveBeenCalledOnce();
    expect(handler.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      ErrorType.lifecycle,
      ErrorType.lifecycle,
      ErrorType.listener,
      ErrorType.pauseResume,
      ErrorType.pauseResume,
      ErrorType.lifecycle,
      ErrorType.dispose,
    ]);
    expect(log).toHaveBeenCalledTimes(7);
  });
  it('initializes once, supports removable lifecycle observers, and resets retained instances in all runtimes', () => {
    ViewModel.reset();
    const events: string[] = [];
    const observer: ViewModelLifecycle = {
      onCreate: () => {
        events.push('create');
      },
      onBind: (_vm, _info, id) => {
        events.push(`bind:${id}`);
      },
      onUnbind: (_vm, _info, id) => {
        events.push(`unbind:${id}`);
      },
      onDispose: () => {
        events.push('dispose');
      },
    };
    ViewModel.initialize({ lifecycles: [observer], config: { isLoggingEnabled: true } });
    ViewModel.initialize({ config: { isLoggingEnabled: false } });
    expect(ViewModel.config.isLoggingEnabled).toBe(true);
    const first = runtime();
    const second = runtime();
    const owner = first.createBinding({ id: 'first' });
    const spec = viewModelSpec(Item, () => new Item(), {
      key: 'retained',
      tag: 'group',
      aliveForever: true,
    });
    const a = owner.read(spec);
    const b = second.createBinding({ id: 'second' }).read(spec);
    expect(a.key).toBe('retained');
    expect(a.tag).toBe('group');
    expect(events.slice(0, 4)).toEqual(['create', 'bind:first', 'create', 'bind:second']);
    ViewModel.reset();
    expect(a.isDisposed && b.isDisposed).toBe(true);
    expect(first.countInstances()).toBe(0);
    expect(events.filter((value) => value === 'dispose')).toHaveLength(2);
    const length = events.length;
    const next = owner.read(spec);
    expect(next).not.toBe(a);
    expect(events).toHaveLength(length);
    const detached = vi.fn();
    const remove = ViewModel.addLifecycle({ onBind: detached });
    remove();
    remove();
    first.createBinding().read(spec);
    expect(detached).not.toHaveBeenCalled();
  });
  it('global reset blocks reentrant creation even in a different Runtime', () => {
    const other = runtime();
    const first = runtime();
    const results: unknown[] = [];
    class Resetting extends ViewModel {
      protected override onDispose() {
        try {
          other.createBinding().read(viewModelSpec(Item, () => new Item()));
        } catch (error) {
          results.push(error);
        }
      }
    }
    first
      .createBinding()
      .read(viewModelSpec(Resetting, () => new Resetting(), { key: 'old', aliveForever: true }));
    ViewModel.reset();
    expect(results).toHaveLength(1);
    expect(other.countInstances()).toBe(0);
  });
  it('inspects empty roots, exact source counts, dependencies and creation-order cache counts', () => {
    const app = runtime();
    const root = app.createBinding({ id: 'root' });
    expect(app.getDiagnostics().bindings.map((value) => value.id)).toEqual(['root']);
    class Parent extends ViewModel {
      child(spec: ReturnType<typeof viewModelSpec<Item>>) {
        return this.viewModelBinding.read(spec);
      }
    }
    const childSpec = viewModelSpec(Item, () => new Item(), { key: 'child', tag: 'group' });
    root.read(childSpec);
    const parent = root.read(viewModelSpec(Parent, () => new Parent()));
    parent.child(childSpec);
    const snapshot = app.getDiagnostics();
    const child = snapshot.instances.find((value) => value.key === 'child')!;
    expect(child.externalSources).toEqual([{ bindingId: 'root', count: 2 }]);
    expect(snapshot.dependencies).toHaveLength(1);
    expect(app.countInstances(Item, { tag: 'group' })).toBe(1);
    expect(app.countInstances()).toBe(2);
    root.unbind(childSpec);
    expect(
      app.getDiagnostics().instances.find((value) => value.key === 'child')!.externalSources,
    ).toEqual([{ bindingId: 'root', count: 1 }]);
  });
  it('pauses only one owner refresh while business listeners and other owners remain live', () => {
    const app = runtime();
    const firstUpdate = vi.fn();
    const secondUpdate = vi.fn();
    const business = vi.fn();
    const first = app.createBinding({ onUpdate: firstUpdate });
    const second = app.createBinding({ onUpdate: secondUpdate });
    const spec = viewModelSpec(Item, () => new Item(), { key: 'shared' });
    first.watch(spec);
    const item = second.watch(spec);
    first.listenState(spec, business);
    first.pause('route');
    first.pause('hidden');
    item.set(1);
    item.set(2);
    expect(firstUpdate).not.toHaveBeenCalled();
    expect(secondUpdate).toHaveBeenCalledTimes(2);
    expect(business).toHaveBeenCalledTimes(2);
    first.resume('route');
    expect(firstUpdate).not.toHaveBeenCalled();
    first.resume('hidden');
    expect(firstUpdate).toHaveBeenCalledOnce();
    expect(item.isPaused).toBe(false);
  });
});
