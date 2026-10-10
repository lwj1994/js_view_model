import { describe, expect, it, vi } from 'vitest';

import {
  ViewModel,
  ViewModelRuntime,
  createViewModelHarmonyLifecycle,
  createViewModelHarmonyScope,
  viewModelSpec,
} from '../src/harmony/index.js';

class CounterViewModel extends ViewModel {
  public count = 0;
  public pauses = 0;
  public resumes = 0;

  public increment(): void {
    this.count += 1;
    this.notifyListeners();
  }

  protected override onPause(): void {
    this.pauses += 1;
  }

  protected override onResume(): void {
    this.resumes += 1;
  }
}

const counterSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel());
const sharedCounterSpec = counterSpec.withKey('shared-counter');

describe('Harmony host scope', () => {
  it('delivers watch updates once per scope while read ignores ordinary changes', () => {
    const runtime = new ViewModelRuntime();
    const onReadUpdate = vi.fn();
    const onWatchUpdate = vi.fn();
    const reader = createViewModelHarmonyScope({ runtime, onUpdate: onReadUpdate });
    const watcher = createViewModelHarmonyScope({ runtime, onUpdate: onWatchUpdate });
    const viewModel = reader.read(sharedCounterSpec);

    expect(watcher.watch(sharedCounterSpec)).toBe(viewModel);
    expect(watcher.watch(sharedCounterSpec)).toBe(viewModel);
    expect(watcher.watch(sharedCounterSpec)).toBe(viewModel);
    viewModel.increment();

    expect(onReadUpdate).not.toHaveBeenCalled();
    expect(onWatchUpdate).toHaveBeenCalledOnce();

    reader.dispose();
    watcher.dispose();
    runtime.dispose();
  });

  it('keeps unkeyed instances private and shares keyed instances across stable Bindings', async () => {
    const runtime = new ViewModelRuntime();
    const first = createViewModelHarmonyScope({ runtime });
    const second = createViewModelHarmonyScope({ runtime });
    const firstPrivate = first.read(counterSpec);
    const secondPrivate = second.read(counterSpec);
    const shared = first.read(sharedCounterSpec);

    expect(first.binding).not.toBe(second.binding);
    expect(first.read(counterSpec)).toBe(firstPrivate);
    expect(secondPrivate).not.toBe(firstPrivate);
    expect(second.read(sharedCounterSpec)).toBe(shared);

    first.dispose();
    await Promise.resolve();

    expect(firstPrivate.isDisposed).toBe(true);
    expect(secondPrivate.isDisposed).toBe(false);
    expect(shared.isDisposed).toBe(false);
    expect(runtime.isDisposed).toBe(false);

    second.dispose();
    runtime.dispose();
  });

  it('deduplicates host delivery when a child also updates a watched parent', () => {
    class ParentViewModel extends ViewModel {
      public get child(): CounterViewModel {
        return this.viewModelBinding.watch(sharedCounterSpec);
      }

      public incrementChild(): void {
        this.child.increment();
      }
    }

    const parentSpec = viewModelSpec(ParentViewModel, () => new ParentViewModel());
    const onUpdate = vi.fn();
    const scope = createViewModelHarmonyScope({ onUpdate });
    const parent = scope.watch(parentSpec);
    const child = scope.watch(sharedCounterSpec);

    parent.incrementChild();

    expect(child.count).toBe(1);
    expect(parent.version).toBe(1);
    expect(onUpdate).toHaveBeenCalledOnce();
    scope.dispose();
  });

  it.each(['watch', 'read'] as const)(
    'lets a %s host resolve a replacement generation from onUpdate',
    (mode) => {
      let current: CounterViewModel | undefined;
      const onUpdate = vi.fn(() => {
        current = scope[mode](counterSpec);
      });
      const scope = createViewModelHarmonyScope({ onUpdate });
      const previous = scope[mode](counterSpec);
      current = previous;

      expect(scope.runtime.recycle(previous)).toBe(1);

      expect(previous.isDisposed).toBe(true);
      expect(current).not.toBe(previous);
      expect(current).toBe(scope[mode](counterSpec));
      expect(onUpdate).toHaveBeenCalledOnce();

      current?.increment();

      expect(current?.count).toBe(1);
      expect(onUpdate).toHaveBeenCalledTimes(mode === 'watch' ? 2 : 1);
      scope.dispose();
    },
  );

  it('stops queued updates on disposal while other scopes keep the shared runtime alive', () => {
    const runtime = new ViewModelRuntime();
    const firstUpdate = vi.fn();
    const secondUpdate = vi.fn();
    const first = createViewModelHarmonyScope({ runtime, onUpdate: firstUpdate });
    const second = createViewModelHarmonyScope({ runtime, onUpdate: secondUpdate });
    const lifecycle = createViewModelHarmonyLifecycle(runtime);
    const viewModel = first.watch(sharedCounterSpec);
    second.watch(sharedCounterSpec);

    lifecycle.setActive(false);
    viewModel.increment();
    expect(firstUpdate).not.toHaveBeenCalled();
    expect(secondUpdate).not.toHaveBeenCalled();

    first.dispose();
    first.dispose();
    lifecycle.setActive(true);

    expect(first.isDisposed).toBe(true);
    expect(first.binding.isDisposed).toBe(true);
    expect(first.ownsRuntime).toBe(false);
    expect(runtime.isDisposed).toBe(false);
    expect(viewModel.isDisposed).toBe(false);
    expect(firstUpdate).not.toHaveBeenCalled();
    expect(secondUpdate).toHaveBeenCalledOnce();

    viewModel.increment();

    expect(firstUpdate).not.toHaveBeenCalled();
    expect(secondUpdate).toHaveBeenCalledTimes(2);
    expect(() => first.watch(sharedCounterSpec)).toThrow();
    lifecycle.dispose();
    second.dispose();
    runtime.dispose();
  });

  it('disposes an owned runtime and accepts hosts without an update callback', () => {
    const scope = createViewModelHarmonyScope();
    const viewModel = scope.watch(counterSpec);

    viewModel.increment();
    expect(scope.ownsRuntime).toBe(true);
    expect(scope.isDisposed).toBe(false);

    scope.dispose();
    scope.dispose();

    expect(scope.isDisposed).toBe(true);
    expect(scope.runtime.isDisposed).toBe(true);
    expect(scope.binding.isDisposed).toBe(true);
    expect(viewModel.isDisposed).toBe(true);
  });

  it('finishes owned cleanup even when unbind and disposal callbacks throw', () => {
    class FailingViewModel extends ViewModel {
      protected override onUnbind(): void {
        throw new Error('unbind failed');
      }

      protected override onDispose(): void {
        throw new Error('dispose failed');
      }
    }

    const spec = viewModelSpec(FailingViewModel, () => new FailingViewModel());
    const onUpdate = vi.fn();
    const scope = createViewModelHarmonyScope({ onUpdate });
    const viewModel = scope.watch(spec);

    expect(() => scope.dispose()).toThrow(AggregateError);
    expect(scope.isDisposed).toBe(true);
    expect(scope.runtime.isDisposed).toBe(true);
    expect(scope.binding.isDisposed).toBe(true);
    expect(viewModel.isDisposed).toBe(true);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(() => scope.dispose()).not.toThrow();
  });
});

describe('Harmony app/window lifecycle', () => {
  it('aggregates independent pause tokens and removes only the disposed source', () => {
    const runtime = new ViewModelRuntime();
    const onUpdate = vi.fn();
    const scope = createViewModelHarmonyScope({ runtime, onUpdate });
    const viewModel = scope.watch(counterSpec);
    const app = createViewModelHarmonyLifecycle(runtime);
    const window = createViewModelHarmonyLifecycle(runtime);

    app.setActive(false);
    app.setActive(false);
    window.setActive(false);
    viewModel.increment();
    viewModel.increment();

    expect(runtime.isPaused).toBe(true);
    expect(viewModel.pauses).toBe(1);
    expect(onUpdate).not.toHaveBeenCalled();

    app.setActive(true);
    expect(runtime.isPaused).toBe(true);
    expect(viewModel.resumes).toBe(0);

    app.setActive(false);
    app.dispose();
    app.dispose();
    expect(runtime.isPaused).toBe(true);

    window.setActive(true);
    window.setActive(true);

    expect(runtime.isPaused).toBe(false);
    expect(viewModel.resumes).toBe(1);
    expect(onUpdate).toHaveBeenCalledOnce();

    window.setActive(false);
    window.dispose();
    window.setActive(false);
    app.setActive(false);

    expect(runtime.isPaused).toBe(false);
    expect(viewModel.pauses).toBe(2);
    expect(viewModel.resumes).toBe(2);
    expect(runtime.isDisposed).toBe(false);
    scope.dispose();
    runtime.dispose();
  });

  it('can be detached after the shared runtime has already been disposed', () => {
    const runtime = new ViewModelRuntime();
    const scope = createViewModelHarmonyScope({ runtime });
    const lifecycle = createViewModelHarmonyLifecycle(runtime);
    scope.watch(counterSpec);
    lifecycle.setActive(false);
    runtime.dispose();

    expect(scope.isDisposed).toBe(true);
    expect(() => {
      lifecycle.setActive(true);
      lifecycle.setActive(false);
      lifecycle.dispose();
      lifecycle.dispose();
      scope.dispose();
      const lateLifecycle = createViewModelHarmonyLifecycle(runtime);
      lateLifecycle.setActive(false);
      lateLifecycle.dispose();
    }).not.toThrow();
  });
});
