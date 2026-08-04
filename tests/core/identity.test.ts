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
  it('显式 type + key 是跨 Spec、跨 binding 的共享身份', () => {
    const runtime = new ViewModelRuntime();
    const first = runtime.createBinding();
    const second = runtime.createBinding();
    const firstBuilder = vi.fn(() => new LifecycleViewModel());
    const secondBuilder = vi.fn(() => new LifecycleViewModel());
    const firstSpec = viewModelSpec(LifecycleViewModel, firstBuilder, { key: 'shared' });
    const secondSpec = viewModelSpec(LifecycleViewModel, secondBuilder, { key: 'shared' });

    const viewModel = first.read(firstSpec);
    expect(second.read(secondSpec)).toBe(viewModel);
    expect(firstBuilder).toHaveBeenCalledOnce();
    expect(secondBuilder).not.toHaveBeenCalled();
    expect(firstSpec.type).toBe(LifecycleViewModel);
    expect(secondSpec.token).toBe(firstSpec.token);

    runtime.dispose();
  });

  it('显式 type 的 unkeyed Spec 在同一 binding 共享、跨 binding 私有', () => {
    const runtime = new ViewModelRuntime();
    const first = runtime.createBinding();
    const second = runtime.createBinding();
    const firstSpec = viewModelSpec(LifecycleViewModel, () => new LifecycleViewModel());
    const secondSpec = viewModelSpec(LifecycleViewModel, () => new LifecycleViewModel());

    expect(first.read(secondSpec)).toBe(first.read(firstSpec));
    expect(second.read(secondSpec)).not.toBe(first.read(firstSpec));

    runtime.dispose();
  });

  it('显式 type 的不同 key 不共享', () => {
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const firstSpec = viewModelSpec(LifecycleViewModel, () => new LifecycleViewModel(), {
      key: 'first',
    });
    const secondSpec = viewModelSpec(LifecycleViewModel, () => new LifecycleViewModel(), {
      key: 'second',
    });

    expect(binding.read(secondSpec)).not.toBe(binding.read(firstSpec));

    runtime.dispose();
  });

  it('显式 type 拒绝结构兼容但不是该 type 的 builder 结果', () => {
    class DeclaredViewModel extends ViewModel {}
    class WrongViewModel extends ViewModel {}

    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const spec = viewModelSpec(DeclaredViewModel, () => new WrongViewModel());

    expect(() => binding.read(spec)).toThrow(ViewModelSpecError);
    expect(runtime.recycle(spec)).toBe(0);

    runtime.dispose();
  });

  it('显式 type 支持 protected constructor 的抽象基类身份', () => {
    abstract class AbstractViewModel extends ViewModel {
      protected constructor() {
        super();
      }
    }

    class ConcreteViewModel extends AbstractViewModel {
      public constructor() {
        super();
      }
    }

    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const spec = viewModelSpec(AbstractViewModel, () => new ConcreteViewModel());

    expect(binding.read(spec)).toBeInstanceOf(ConcreteViewModel);

    runtime.dispose();
  });

  it('旧 builder-only Spec 即使 key 相同也保持独立身份', () => {
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const firstSpec = viewModelSpec(() => new LifecycleViewModel(), { key: 'shared' });
    const secondSpec = viewModelSpec(() => new LifecycleViewModel(), { key: 'shared' });

    expect(binding.read(secondSpec)).not.toBe(binding.read(firstSpec));
    expect(secondSpec.token).not.toBe(firstSpec.token);
    expect(firstSpec.type).toBeUndefined();

    runtime.dispose();
  });

  it('withKey 保留显式 type 身份', () => {
    const baseSpec = viewModelSpec(LifecycleViewModel, () => new LifecycleViewModel());
    const keyedSpec = baseSpec.withKey('shared');

    expect(keyedSpec.type).toBe(LifecycleViewModel);
    expect(keyedSpec.token).toBe(baseSpec.token);
  });

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
    expect(() =>
      viewModelSpec(LifecycleViewModel, () => new LifecycleViewModel(), { aliveForever: true }),
    ).toThrow(ViewModelSpecError);

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

  it('recycle 使用与 Map 缓存一致的 SameValueZero key 语义', () => {
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const nanSpec = viewModelSpec(LifecycleViewModel, () => new LifecycleViewModel(), { key: NaN });
    const nanViewModel = binding.read(nanSpec);

    expect(binding.read(nanSpec)).toBe(nanViewModel);
    expect(runtime.recycle(nanSpec)).toBe(1);
    expect(nanViewModel.isDisposed).toBe(true);

    const negativeZeroSpec = viewModelSpec(LifecycleViewModel, () => new LifecycleViewModel(), {
      key: -0,
    });
    const positiveZeroSpec = viewModelSpec(LifecycleViewModel, () => new LifecycleViewModel(), {
      key: 0,
    });
    const zeroViewModel = binding.read(negativeZeroSpec);

    expect(binding.read(positiveZeroSpec)).toBe(zeroViewModel);
    expect(runtime.recycle(positiveZeroSpec)).toBe(1);
    expect(zeroViewModel.isDisposed).toBe(true);

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
