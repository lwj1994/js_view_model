import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ViewModelRuntime } from '../../src/core/index.js';
import { InternalViewModelScope } from '../../src/react/index.js';
import {
  createReactNativeAppStateLifecycleSource,
  type ReactNativeAppState,
} from '../../src/react-native/app-state.js';

class FakeAppState implements ReactNativeAppState {
  currentState: string | null = 'active';
  private listener: ((state: string) => void) | undefined;
  readonly remove = vi.fn(() => {
    this.listener = undefined;
  });

  addEventListener(type: 'change', listener: (state: string) => void) {
    expect(type).toBe('change');
    this.listener = listener;
    return { remove: this.remove };
  }

  emit(state: string): void {
    this.currentState = state;
    this.listener?.(state);
  }
}

describe('React Native AppState 适配', () => {
  it('只把 active 视为前台，并在取消订阅时 remove', () => {
    const appState = new FakeAppState();
    const source = createReactNativeAppStateLifecycleSource(appState);
    const listener = vi.fn();

    expect(source.isActive()).toBe(true);
    const unsubscribe = source.subscribe(listener);

    appState.emit('inactive');
    appState.emit('background');
    appState.emit('active');

    expect(listener.mock.calls).toEqual([[false], [false], [true]]);
    unsubscribe();
    expect(appState.remove).toHaveBeenCalledOnce();
  });

  it('在 Scope commit 后把 AppState 转换成 runtime pause / resume', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const appState = new FakeAppState();
    appState.currentState = 'background';
    const source = createReactNativeAppStateLifecycleSource(appState);
    const runtime = new ViewModelRuntime();
    const pause = vi.spyOn(runtime, 'pause');
    const resume = vi.spyOn(runtime, 'resume');
    let renderer: ReturnType<typeof create> | undefined;

    await act(async () => {
      renderer = create(
        createElement(InternalViewModelScope, { runtime, lifecycle: source }, null),
      );
    });

    expect(pause).toHaveBeenCalledOnce();
    const token = pause.mock.calls[0]?.[0];
    expect(token).toBeTypeOf('object');

    act(() => appState.emit('active'));
    expect(resume).toHaveBeenCalledWith(token);

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
    runtime.dispose();
  });
});
