import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ViewModel,
  ViewModelRuntime,
  ViewModelRuntimeDisposedError,
  viewModelSpec,
} from '../../src/core/index.js';

class Item extends ViewModel {}
const spec = viewModelSpec(Item, () => new Item(), { key: 'shared' });
const runtimes: ViewModelRuntime[] = [];
const runtime = () => {
  const value = new ViewModelRuntime();
  runtimes.push(value);
  return value;
};

let unexpectedErrors: unknown[][] = [];
beforeEach(() => {
  ViewModel.reset();
  unexpectedErrors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    unexpectedErrors.push(args);
  });
});
afterEach(() => {
  for (const value of runtimes.splice(0)) value.dispose();
  ViewModel.reset();
  expect(unexpectedErrors).toEqual([]);
});

describe.each(['runtime', 'global'] as const)('%s reset notifications', (kind) => {
  const reset = (app: ViewModelRuntime) => (kind === 'runtime' ? app.reset() : ViewModel.reset());

  it('refreshes surviving roots once after all generations and pause state are cleared', () => {
    const app = runtime();
    const refresh = vi.fn(() => {
      expect(old.every((value) => value.isDisposed)).toBe(true);
      expect(app.isPaused || owner.isPaused).toBe(false);
      expect(app.countInstances()).toBe(0);
      owner.watch(spec);
      owner.watch(second);
    });
    const owner = app.createBinding({ onUpdate: refresh });
    const second = spec.withKey('second');
    const old = [owner.watch(spec), owner.watch(second)];
    const watch = vi.fn(() => owner.read(spec));
    const read = vi.fn(() => owner.read(second));
    owner.subscribe(spec, 'watch', watch);
    owner.subscribe(second, 'read', read);
    app.pause();
    owner.pause();
    old[0]!.notifyListeners();
    expect(refresh).not.toHaveBeenCalled();

    reset(app);

    expect(refresh).toHaveBeenCalledOnce();
    expect(watch).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(owner.isDisposed).toBe(false);
    expect(app.countInstances()).toBe(2);
    expect(owner.read(spec)).not.toBe(old[0]);
    app.resume();
    owner.resume();
    expect(watch).toHaveBeenCalledOnce();
  });

  it('does not deliver terminal subscriptions cancelled during another generation disposal', () => {
    const app = runtime();
    const owner = app.createBinding();
    const cancelled = vi.fn();
    const gone = vi.fn();
    const surviving = vi.fn();
    const disposedOwner = app.createBinding();
    const stop = owner.subscribe(spec, 'watch', cancelled);
    disposedOwner.subscribe(spec, 'read', gone);
    owner.subscribe(spec, 'watch', surviving);
    class Cleanup extends ViewModel {
      protected override onDispose() {
        stop();
        disposedOwner.dispose();
      }
    }
    owner.read(viewModelSpec(Cleanup, () => new Cleanup()));

    reset(app);

    expect(cancelled).not.toHaveBeenCalled();
    expect(gone).not.toHaveBeenCalled();
    expect(surviving).toHaveBeenCalledOnce();
  });

  it('waits for an outer recycle to finish when onDispose reenters reset', () => {
    const app = runtime();
    const owner = app.createBinding();
    let trigger = true;
    let disposed = false;
    class Reentrant extends ViewModel {
      protected override onDispose() {
        if (!trigger) return;
        trigger = false;
        reset(app);
        disposed = true;
      }
    }
    const source = viewModelSpec(Reentrant, () => new Reentrant());
    const events: boolean[] = [];
    const terminal = vi.fn(() => {
      events.push(disposed);
      owner.read(source);
    });
    const previous = owner.read(source);
    owner.subscribe(source, 'watch', terminal);
    app.recycle(previous);
    expect(terminal).toHaveBeenCalledOnce();
    expect(events).toEqual([true]);
    expect(owner.read(source)).not.toBe(previous);
    expect(app.countInstances()).toBe(1);
  });
});

it('global reset refreshes only after all runtimes and configuration finish resetting', () => {
  const first = runtime();
  const second = runtime();
  const firstOwner = first.createBinding();
  const secondOwner = second.createBinding();
  const firstOld = firstOwner.read(spec);
  const secondOld = secondOwner.read(spec);
  const observer = vi.fn();
  ViewModel.initialize({
    config: { isLoggingEnabled: true },
    lifecycles: [{ onCreate: observer }],
  });
  const events: unknown[] = [];
  firstOwner.subscribe(spec, 'read', () => {
    events.push([firstOld.isDisposed, secondOld.isDisposed, ViewModel.config.isLoggingEnabled]);
    events.push(firstOwner.read(spec), secondOwner.read(spec));
  });
  secondOwner.subscribe(spec, 'watch', () => events.push(secondOwner.read(spec)));

  ViewModel.reset();

  expect(events[0]).toEqual([true, true, undefined]);
  expect(events[1]).toBe(firstOwner.read(spec));
  expect(events[2]).toBe(secondOwner.read(spec));
  expect(events[3]).toBe(events[2]);
  expect(events).toHaveLength(4);
  expect(observer).not.toHaveBeenCalled();
});

it('reset keeps reentrant creation blocked during cleanup, but permits terminal callbacks', () => {
  const app = runtime();
  const owner = app.createBinding();
  const blocked: unknown[] = [];
  class Cleanup extends ViewModel {
    protected override onDispose() {
      try {
        owner.read(spec);
      } catch (error) {
        blocked.push(error);
      }
    }
  }
  const source = viewModelSpec(Cleanup, () => new Cleanup());
  const callback = vi.fn(() => owner.read(spec));
  owner.subscribe(source, 'watch', callback);
  app.reset();
  expect(blocked).toHaveLength(1);
  expect(blocked[0]).toBeInstanceOf(ViewModelRuntimeDisposedError);
  expect(callback).toHaveBeenCalledOnce();
  expect(app.countInstances()).toBe(1);
});

it('a failing terminal callback cannot prevent another owner from recovering', () => {
  const app = runtime();
  const errors = vi.fn();
  ViewModel.initialize({ config: { onError: errors } });
  app.createBinding().subscribe(spec, 'watch', () => {
    throw new Error('terminal listener');
  });
  const owner = app.createBinding();
  const recovered = vi.fn(() => owner.read(spec));
  owner.subscribe(spec, 'watch', recovered);
  app.reset();
  expect(errors).toHaveBeenCalledOnce();
  expect(recovered).toHaveBeenCalledOnce();
  expect(owner.read(spec).isDisposed).toBe(false);
});

it('a Runtime disposed later in a global reset does not deliver retained callbacks', () => {
  const first = runtime();
  const second = runtime();
  const listener = vi.fn();
  first.createBinding().subscribe(spec, 'watch', listener);
  class Cleanup extends ViewModel {
    protected override onDispose() {
      first.dispose();
    }
  }
  second.createBinding().read(viewModelSpec(Cleanup, () => new Cleanup()));
  ViewModel.reset();
  expect(first.isDisposed).toBe(true);
  expect(listener).not.toHaveBeenCalled();
});
