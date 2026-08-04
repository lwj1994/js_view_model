import { describe, expect, it, vi } from 'vitest';

import { ViewModel, ViewModelRuntime, viewModelSpec } from '../../src/core/index.js';
import {
  enqueueViewModelUpdateCallback,
  isViewModelUpdateTransactionActive,
  markViewModelParentNotified,
  runInViewModelUpdateTransaction,
} from '../../src/core/update-transaction.js';

class CounterViewModel extends ViewModel {
  public count = 0;

  public increment(): void {
    this.count += 1;
    this.notifyListeners('increment');
  }
}

describe('watch/read 与 generation 快照', () => {
  it('read 忽略普通通知，watch 响应普通通知', () => {
    const onUpdate = vi.fn();
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding({ onUpdate });
    const spec = viewModelSpec(() => new CounterViewModel());
    const viewModel = binding.read(spec);
    const readSnapshot = binding.getSnapshot(spec, 'read');

    viewModel.increment();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(binding.getSnapshot(spec, 'read')).toBe(readSnapshot);

    binding.watch(spec);
    const watchSnapshot = binding.getSnapshot(spec, 'watch');
    viewModel.increment();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(binding.getSnapshot(spec, 'watch')).not.toBe(watchSnapshot);

    runtime.dispose();
  });

  it('subscribe read 只响应 recycle，subscribe watch 同时响应普通通知', () => {
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const spec = viewModelSpec(() => new CounterViewModel());
    const readListener = vi.fn();
    const watchListener = vi.fn();
    binding.subscribe(spec, 'read', readListener);
    binding.subscribe(spec, 'watch', watchListener);
    const viewModel = binding.prepare(spec);

    viewModel.increment();
    expect(readListener).not.toHaveBeenCalled();
    expect(watchListener).toHaveBeenCalledTimes(1);

    expect(runtime.recycle(spec)).toBe(1);
    expect(readListener).toHaveBeenCalledTimes(1);
    expect(watchListener).toHaveBeenCalledTimes(2);

    runtime.dispose();
  });

  it('recycle 让 mounted binding 解析新 generation，且新实例可继续订阅', () => {
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const spec = viewModelSpec(() => new CounterViewModel());
    const oldListener = vi.fn();
    binding.subscribe(spec, 'watch', oldListener);
    const oldViewModel = binding.prepare(spec);
    const oldSnapshot = binding.getSnapshot(spec, 'read');

    expect(runtime.recycle(oldViewModel)).toBe(1);
    expect(oldViewModel.isDisposed).toBe(true);
    const nextViewModel = binding.prepare(spec);
    expect(nextViewModel).not.toBe(oldViewModel);
    expect(binding.getSnapshot(spec, 'read')).not.toBe(oldSnapshot);

    const nextListener = vi.fn();
    binding.subscribe(spec, 'watch', nextListener);
    nextViewModel.increment();
    expect(nextListener).toHaveBeenCalledTimes(1);
    expect(oldListener).toHaveBeenCalledTimes(1);

    runtime.dispose();
  });

  it('单个监听器抛错不会阻断其他直接监听器或 Binding 通知', () => {
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const spec = viewModelSpec(() => new CounterViewModel());
    const bindingListener = vi.fn();
    binding.subscribe(spec, 'watch', bindingListener);
    const viewModel = binding.prepare(spec);
    const directListener = vi.fn();
    viewModel.subscribe(() => {
      throw new Error('listener failed');
    });
    viewModel.subscribe(directListener);

    expect(() => viewModel.increment()).toThrow(AggregateError);
    expect(directListener).toHaveBeenCalledOnce();
    expect(bindingListener).toHaveBeenCalledOnce();

    runtime.dispose();
  });

  it('两个 Binding 复用同一个 onUpdate callback 时仍按 Binding identity 各投递一次', () => {
    const sharedUpdate = vi.fn();
    const runtime = new ViewModelRuntime();
    const first = runtime.createBinding({ onUpdate: sharedUpdate });
    const second = runtime.createBinding({ onUpdate: sharedUpdate });
    const spec = viewModelSpec(CounterViewModel, () => new CounterViewModel(), {
      key: 'shared-callback-counter',
    });
    const viewModel = first.watch(spec);
    expect(second.watch(spec)).toBe(viewModel);

    viewModel.increment();

    expect(sharedUpdate).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });
});

describe('同步通知 transaction', () => {
  it('从整个 notifyListeners 外层开始，并让嵌套同步 notify 共享 transaction', () => {
    class Emitter extends ViewModel {
      public emit(): void {
        this.notifyListeners();
      }
    }

    const first = new Emitter();
    const second = new Emitter();
    const parent = {};
    let parentNotifications = 0;

    first.subscribe(() => {
      expect(isViewModelUpdateTransactionActive()).toBe(true);
      if (markViewModelParentNotified(parent)) parentNotifications += 1;
      second.emit();
    });
    second.subscribe(() => {
      expect(isViewModelUpdateTransactionActive()).toBe(true);
      if (markViewModelParentNotified(parent)) parentNotifications += 1;
    });

    first.emit();

    expect(parentNotifications).toBe(1);
    expect(isViewModelUpdateTransactionActive()).toBe(false);
  });

  it('按 owner + callback pair 去重，不合并复用同一 callback 的不同 binding', () => {
    const firstBinding = {};
    const secondBinding = {};
    const sharedCallback = vi.fn();

    runInViewModelUpdateTransaction(() => {
      enqueueViewModelUpdateCallback(firstBinding, sharedCallback);
      enqueueViewModelUpdateCallback(firstBinding, sharedCallback);
      runInViewModelUpdateTransaction(() => {
        enqueueViewModelUpdateCallback(firstBinding, sharedCallback);
        enqueueViewModelUpdateCallback(secondBinding, sharedCallback);
      });

      expect(sharedCallback).not.toHaveBeenCalled();
    });

    expect(sharedCallback).toHaveBeenCalledTimes(2);
  });

  it('异步通知开启新 transaction', async () => {
    const parent = {};
    const notifications: boolean[] = [];

    runInViewModelUpdateTransaction(() => {
      notifications.push(markViewModelParentNotified(parent));
      queueMicrotask(() => {
        runInViewModelUpdateTransaction(() => {
          notifications.push(markViewModelParentNotified(parent));
        });
      });
    });
    await Promise.resolve();

    expect(notifications).toEqual([true, true]);
  });

  it('一个 transaction callback 抛错不会阻断其他 callback，并聚合错误', () => {
    const first = vi.fn(() => {
      throw new Error('first failed');
    });
    const second = vi.fn(() => {
      throw new Error('second failed');
    });

    let thrown: unknown;
    try {
      runInViewModelUpdateTransaction(() => {
        enqueueViewModelUpdateCallback({}, first);
        enqueueViewModelUpdateCallback({}, second);
      });
    } catch (error) {
      thrown = error;
    }

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toHaveLength(2);
  });
});
