import { describe, expect, it, vi } from 'vitest';

import {
  ViewModel,
  ViewModelBindingDisposedError,
  ViewModelRuntime,
  ViewModelRuntimeDisposedError,
  viewModelSpec,
} from '../../src/core/index.js';

const flushDisposals = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

class LifecycleViewModel extends ViewModel {
  public pauses = 0;
  public resumes = 0;
  public unbinds = 0;
  public disposes = 0;

  public change(): void {
    this.notifyListeners();
  }

  protected override onPause(): void {
    this.pauses += 1;
  }

  protected override onResume(): void {
    this.resumes += 1;
  }

  protected override onUnbind(): void {
    this.unbinds += 1;
  }

  protected override onDispose(): void {
    this.disposes += 1;
  }
}

describe('平台与资源生命周期', () => {
  it('pause token 聚合，最后一个 source resume 后补投一次通知', () => {
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const spec = viewModelSpec(() => new LifecycleViewModel());
    const update = vi.fn();
    binding.subscribe(spec, 'watch', update);
    const viewModel = binding.prepare(spec);
    const appSource = {};
    const windowSource = {};

    runtime.pause(appSource);
    runtime.pause(windowSource);
    expect(runtime.isPaused).toBe(true);
    expect(viewModel.isPaused).toBe(true);
    expect(viewModel.pauses).toBe(1);

    viewModel.change();
    viewModel.change();
    expect(update).not.toHaveBeenCalled();

    runtime.resume(appSource);
    expect(runtime.isPaused).toBe(true);
    expect(viewModel.resumes).toBe(0);
    expect(update).not.toHaveBeenCalled();

    runtime.resume(windowSource);
    expect(runtime.isPaused).toBe(false);
    expect(viewModel.isPaused).toBe(false);
    expect(viewModel.resumes).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('paused 状态下新 acquire 的实例会在 onCreate 后立即 pause', () => {
    const runtime = new ViewModelRuntime();
    runtime.pause();
    const binding = runtime.createBinding();
    const spec = viewModelSpec(() => new LifecycleViewModel());

    const viewModel = binding.read(spec);
    expect(viewModel.isPaused).toBe(true);
    expect(viewModel.pauses).toBe(1);

    runtime.resume();
    expect(viewModel.resumes).toBe(1);
    runtime.dispose();
  });

  it('resume 时不会合并复用同一 callback 的不同 Binding', () => {
    const sharedUpdate = vi.fn();
    const runtime = new ViewModelRuntime();
    const first = runtime.createBinding({ onUpdate: sharedUpdate });
    const second = runtime.createBinding({ onUpdate: sharedUpdate });
    const spec = viewModelSpec(LifecycleViewModel, () => new LifecycleViewModel(), {
      key: 'paused-shared-callback',
    });
    const viewModel = first.watch(spec);
    expect(second.watch(spec)).toBe(viewModel);
    runtime.pause();

    viewModel.change();
    expect(sharedUpdate).not.toHaveBeenCalled();
    runtime.resume();

    expect(sharedUpdate).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it('paused 期间已销毁 Binding 的排队更新不会在 resume 后投递', () => {
    const update = vi.fn();
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding({ onUpdate: update });
    const spec = viewModelSpec(() => new LifecycleViewModel());
    const viewModel = binding.watch(spec);
    runtime.pause();

    viewModel.change();
    binding.dispose();
    runtime.resume();

    expect(update).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('onCreate 失败会回滚并销毁失败 generation，下一次可重新构造', () => {
    const instances: FailingCreateViewModel[] = [];
    class FailingCreateViewModel extends ViewModel {
      public disposedCount = 0;
      protected override onCreate(): void {
        throw new Error('create failed');
      }
      protected override onDispose(): void {
        this.disposedCount += 1;
      }
    }
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const spec = viewModelSpec(() => {
      const instance = new FailingCreateViewModel();
      instances.push(instance);
      return instance;
    });

    expect(() => binding.read(spec)).toThrow('create failed');
    expect(instances).toHaveLength(1);
    expect(instances[0]?.isDisposed).toBe(true);
    expect(instances[0]?.disposedCount).toBe(1);
    expect(() => binding.read(spec)).toThrow('create failed');
    expect(instances).toHaveLength(2);
    runtime.dispose();
  });

  it('onBind 失败同样回滚 generation', () => {
    const instances: FailingBindViewModel[] = [];
    class FailingBindViewModel extends ViewModel {
      public disposedCount = 0;
      protected override onBind(): void {
        throw new Error('bind failed');
      }
      protected override onDispose(): void {
        this.disposedCount += 1;
      }
    }
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const spec = viewModelSpec(() => {
      const instance = new FailingBindViewModel();
      instances.push(instance);
      return instance;
    });

    expect(() => binding.watch(spec)).toThrow('bind failed');
    expect(instances[0]?.isDisposed).toBe(true);
    expect(instances[0]?.disposedCount).toBe(1);
    runtime.dispose();
  });

  it('binding/runtime dispose 幂等，销毁后拒绝继续解析', async () => {
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const spec = viewModelSpec(() => new LifecycleViewModel());
    const viewModel = binding.read(spec);

    binding.dispose();
    binding.dispose();
    expect(() => binding.read(spec)).toThrow(ViewModelBindingDisposedError);
    await flushDisposals();
    expect(viewModel.unbinds).toBe(1);
    expect(viewModel.disposes).toBe(1);

    runtime.dispose();
    runtime.dispose();
    expect(() => runtime.createBinding()).toThrow(ViewModelRuntimeDisposedError);
  });
});
