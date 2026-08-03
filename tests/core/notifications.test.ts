import { describe, expect, it, vi } from 'vitest';

import { ViewModel, ViewModelRuntime, viewModelSpec } from '../../src/core/index.js';

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
});
