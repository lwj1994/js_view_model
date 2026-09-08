import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleMicrotask } from '../../src/shared/microtask.js';
import { ViewModel, ViewModelRuntime, viewModelSpec } from '../../src/core/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('微任务调度兼容', () => {
  it('优先使用宿主原生队列', async () => {
    const native = globalThis.queueMicrotask;
    const queue = vi.fn((callback: () => void) => native(callback));
    vi.stubGlobal('queueMicrotask', queue);
    const callback = vi.fn();
    expect(scheduleMicrotask(callback)).toBeUndefined();
    expect(queue).toHaveBeenCalledWith(callback);
    expect(callback).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('缺少原生 API 时保持 Promise 微任务与嵌套任务的顺序', async () => {
    vi.stubGlobal('queueMicrotask', undefined);
    const events: string[] = [];
    scheduleMicrotask(() => {
      events.push('first');
      scheduleMicrotask(() => events.push('nested'));
    });
    void Promise.resolve().then(() => events.push('promise'));
    scheduleMicrotask(() => events.push('second'));
    expect(events).toEqual([]);
    await Promise.resolve();
    expect(events).toEqual(['first', 'promise', 'second']);
    await Promise.resolve();
    expect(events).toEqual(['first', 'promise', 'second', 'nested']);
  });

  it('降级回调抛错时通过 timer 重新抛出原始异常，后续微任务仍执行', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.stubGlobal('queueMicrotask', undefined);
    const failure = new Error('microtask failure');
    const next = vi.fn();
    scheduleMicrotask(() => {
      throw failure;
    });
    scheduleMicrotask(next);
    await Promise.resolve();
    expect(next).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    let reported: unknown;
    try {
      vi.runAllTimers();
    } catch (error) {
      reported = error;
    }
    expect(reported).toBe(failure);
  });

  it('缺少原生 API 时重新获取取消销毁，末 owner 释放后仍自动销毁', async () => {
    vi.stubGlobal('queueMicrotask', undefined);
    class Model extends ViewModel {}
    const spec = viewModelSpec(Model, () => new Model(), { key: 'shared' });
    const runtime = new ViewModelRuntime();
    try {
      const first = runtime.createBinding();
      const vm = first.read(spec);
      first.dispose();
      expect(vm.isDisposed).toBe(false);
      const second = runtime.createBinding();
      expect(second.read(spec)).toBe(vm);
      await Promise.resolve();
      expect(vm.isDisposed).toBe(false);
      second.dispose();
      expect(vm.isDisposed).toBe(false);
      await Promise.resolve();
      expect(vm.isDisposed).toBe(true);
    } finally {
      runtime.dispose();
    }
  });

  it('自动销毁异常仍被上报，其他实例继续清理', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.stubGlobal('queueMicrotask', undefined);
    const failure = new Error('onDispose failure');
    class Failing extends ViewModel {
      protected override onDispose(): void {
        throw failure;
      }
    }
    class Model extends ViewModel {}
    const runtime = new ViewModelRuntime();
    try {
      const binding = runtime.createBinding();
      const bad = binding.read(viewModelSpec(Failing, () => new Failing()));
      const good = binding.read(viewModelSpec(Model, () => new Model()));
      binding.dispose();
      await Promise.resolve();
      expect(bad.isDisposed).toBe(true);
      expect(good.isDisposed).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      expect(() => vi.runAllTimers()).toThrow(AggregateError);
    } finally {
      runtime.dispose();
    }
  });
});
