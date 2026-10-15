import { describe, expect, it, vi } from 'vitest';

import { StateViewModel, ViewModelRuntime, viewModelSpec } from '../../src/core/index.js';

interface CounterState {
  readonly count: number;
  readonly name: string;
}

class CounterStateViewModel extends StateViewModel<CounterState> {
  public constructor() {
    super({ count: 0, name: 'counter' });
  }

  public increment(): boolean {
    return this.updateState((state) => ({ ...state, count: state.count + 1 }), 'increment');
  }

  public replace(next: CounterState): boolean {
    return this.setState(next, 'replace');
  }

  public updateWith(updater: (state: CounterState) => CounterState): boolean {
    return this.updateState(updater, 'custom');
  }
}

describe('StateViewModel', () => {
  it('只在状态引用变化时广播，并提供 previous/current diff', () => {
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const spec = viewModelSpec(() => new CounterStateViewModel());
    const viewModel = binding.read(spec);
    const stateListener = vi.fn();
    const versionListener = vi.fn();
    viewModel.subscribeState(stateListener);
    viewModel.subscribe(versionListener);
    const initial = viewModel.state;

    expect(viewModel.replace(initial)).toBe(false);
    expect(stateListener).not.toHaveBeenCalled();
    expect(versionListener).not.toHaveBeenCalled();

    expect(viewModel.increment()).toBe(true);
    expect(viewModel.state).toEqual({ count: 1, name: 'counter' });
    expect(stateListener).toHaveBeenCalledWith({
      previous: initial,
      current: viewModel.state,
    });
    expect(versionListener).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('销毁后状态修改忽略，不能污染 state、调用 updater 或通知 listener', () => {
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const spec = viewModelSpec(() => new CounterStateViewModel());
    const viewModel = binding.read(spec);
    const listener = vi.fn();
    const updater = vi.fn((state: CounterState) => ({ ...state, count: state.count + 1 }));
    viewModel.subscribeState(listener);
    const stateBeforeDispose = viewModel.state;
    runtime.recycle(viewModel);

    expect(viewModel.increment()).toBe(false);
    expect(viewModel.state).toBe(stateBeforeDispose);
    expect(listener).not.toHaveBeenCalled();
    expect(viewModel.updateWith(updater)).toBe(false);
    expect(updater).not.toHaveBeenCalled();
    runtime.dispose();
  });
});
