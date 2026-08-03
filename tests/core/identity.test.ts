import { describe, expect, it, vi } from 'vitest';

import {
  ViewModel,
  ViewModelRuntime,
  ViewModelSpecError,
  viewModelSpec,
} from '../../src/core/index.js';

const flushDisposals = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

class LifecycleViewModel extends ViewModel {
  public creates = 0;
  public binds = 0;
  public unbinds = 0;
  public disposes = 0;

  protected override onCreate(): void {
    this.creates += 1;
  }

  protected override onBind(): void {
    this.binds += 1;
  }

  protected override onUnbind(): void {
    this.unbinds += 1;
  }

  protected override onDispose(): void {
    this.disposes += 1;
  }
}

describe('ViewModel 身份与引用生命周期', () => {
  it('unkeyed 在同一 binding 内稳定、跨 binding 私有', () => {
    const runtime = new ViewModelRuntime();
    const first = runtime.createBinding();
    const second = runtime.createBinding();
    const spec = viewModelSpec(() => new LifecycleViewModel());

    expect(first.read(spec)).toBe(first.read(spec));
    expect(second.read(spec)).not.toBe(first.read(spec));

    runtime.dispose();
  });

  it('keyed generation 跨 binding 共享，并在最后一个 owner 释放后销毁', async () => {
    const runtime = new ViewModelRuntime();
    const first = runtime.createBinding({ id: 'first' });
    const second = runtime.createBinding({ id: 'second' });
    const spec = viewModelSpec(() => new LifecycleViewModel(), { key: 'shared' });

    const viewModel = first.read(spec);
    expect(second.read(spec)).toBe(viewModel);
    expect(viewModel.binds).toBe(2);

    first.dispose();
    await flushDisposals();
    expect(viewModel.isDisposed).toBe(false);
    expect(viewModel.unbinds).toBe(1);

    second.dispose();
    expect(viewModel.isDisposed).toBe(false);
    await flushDisposals();
    expect(viewModel.isDisposed).toBe(true);
    expect(viewModel.unbinds).toBe(2);
    expect(viewModel.disposes).toBe(1);
  });

  it('重复自定义 binding id 按逻辑 source 引用计数', () => {
    const runtime = new ViewModelRuntime();
    const first = runtime.createBinding({ id: 'same-source' });
    const second = runtime.createBinding({ id: 'same-source' });
    const spec = viewModelSpec(() => new LifecycleViewModel(), { key: 'shared' });
    const viewModel = first.read(spec);

    expect(second.read(spec)).toBe(viewModel);
    expect(viewModel.binds).toBe(1);

    first.dispose();
    expect(viewModel.unbinds).toBe(0);
    expect(viewModel.isDisposed).toBe(false);

    second.dispose();
    expect(viewModel.unbinds).toBe(1);
    runtime.dispose();
  });

  it('prepare 只构造实例，第一次 acquire 才执行资源生命周期', async () => {
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding({ id: 'screen' });
    const spec = viewModelSpec(() => new LifecycleViewModel());

    const viewModel = binding.prepare(spec);
    expect(viewModel.creates).toBe(0);
    expect(viewModel.binds).toBe(0);

    const unsubscribe = binding.subscribe(spec, 'read', vi.fn());
    expect(viewModel.creates).toBe(1);
    expect(viewModel.binds).toBe(1);

    unsubscribe();
    expect(viewModel.isDisposed).toBe(false);
    binding.dispose();
    await flushDisposals();
    expect(viewModel.isDisposed).toBe(true);
  });

  it('清扫被放弃 render 留下的 provisional generation', async () => {
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const spec = viewModelSpec(() => new LifecycleViewModel());

    const abandoned = binding.prepare(spec);
    expect(abandoned.creates).toBe(0);

    await flushDisposals();

    expect(abandoned.isDisposed).toBe(true);
    expect(abandoned.disposes).toBe(0);
    expect(runtime.recycle(spec)).toBe(0);

    const committed = binding.read(spec);
    expect(committed).not.toBe(abandoned);
    expect(committed.creates).toBe(1);

    runtime.dispose();
  });

  it('aliveForever 必须有 key，零 owner 后由 recycle 显式回收', async () => {
    expect(() => viewModelSpec(() => new LifecycleViewModel(), { aliveForever: true })).toThrow(
      ViewModelSpecError,
    );

    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const spec = viewModelSpec(() => new LifecycleViewModel(), {
      key: 'application',
      aliveForever: true,
    });
    const viewModel = binding.read(spec);

    binding.dispose();
    await flushDisposals();
    expect(viewModel.isDisposed).toBe(false);
    expect(runtime.recycle(spec)).toBe(1);
    expect(viewModel.isDisposed).toBe(true);
    expect(runtime.recycle(spec)).toBe(0);
  });

  it('recycle unkeyed Spec 不会误回收同 token 的 keyed generation', () => {
    const runtime = new ViewModelRuntime();
    const first = runtime.createBinding();
    const second = runtime.createBinding();
    const baseSpec = viewModelSpec(() => new LifecycleViewModel());
    const keyedSpec = baseSpec.withKey('shared');
    const unkeyed = first.read(baseSpec);
    const keyed = second.read(keyedSpec);

    expect(runtime.recycle(baseSpec)).toBe(1);
    expect(unkeyed.isDisposed).toBe(true);
    expect(keyed.isDisposed).toBe(false);

    runtime.dispose();
  });

  it('recycle 完成旧 generation 销毁后才通知 owner 解析新实例', () => {
    const events: string[] = [];
    let sequence = 0;

    class ExclusiveViewModel extends ViewModel {
      constructor(private readonly sequence: number) {
        super();
      }

      protected override onCreate(): void {
        events.push(`create:${this.sequence}`);
      }

      protected override onDispose(): void {
        events.push(`dispose:${this.sequence}`);
      }
    }

    const runtime = new ViewModelRuntime();
    const spec = viewModelSpec(() => new ExclusiveViewModel(++sequence));
    let binding: ReturnType<ViewModelRuntime['createBinding']>;
    binding = runtime.createBinding({
      onUpdate: () => binding.read(spec),
    });

    binding.read(spec);
    expect(runtime.recycle(spec)).toBe(1);
    expect(events).toEqual(['create:1', 'dispose:1', 'create:2']);

    runtime.dispose();
  });
});
