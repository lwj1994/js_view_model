import { describe, expect, it, vi } from 'vitest';

import {
  createElectronRendererLifecycleSource,
  type ElectronRendererDocument,
  type ElectronRendererWindow,
} from '../../src/electron/lifecycle.js';

class FakeWindow implements ElectronRendererWindow {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: 'focus' | 'blur', listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: 'focus' | 'blur', listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: 'focus' | 'blur'): void {
    this.listeners.get(type)?.forEach((listener) => listener());
  }
}

class FakeDocument implements ElectronRendererDocument {
  visibilityState = 'visible';
  focused = true;
  private readonly listeners = new Set<() => void>();

  hasFocus(): boolean {
    return this.focused;
  }

  addEventListener(type: 'visibilitychange', listener: () => void): void {
    expect(type).toBe('visibilitychange');
    this.listeners.add(listener);
  }

  removeEventListener(type: 'visibilitychange', listener: () => void): void {
    expect(type).toBe('visibilitychange');
    this.listeners.delete(listener);
  }

  emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

describe('Electron renderer 生命周期适配', () => {
  it('同时依据 visibility 与 focus 判断 active', () => {
    const rendererWindow = new FakeWindow();
    const rendererDocument = new FakeDocument();
    const source = createElectronRendererLifecycleSource({
      window: rendererWindow,
      document: rendererDocument,
    });
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);

    expect(source.isActive()).toBe(true);

    rendererDocument.focused = false;
    rendererWindow.emit('blur');
    rendererDocument.visibilityState = 'hidden';
    rendererDocument.emit();
    rendererDocument.visibilityState = 'visible';
    rendererDocument.focused = true;
    rendererWindow.emit('focus');

    expect(listener.mock.calls).toEqual([[false], [false], [true]]);

    unsubscribe();
    rendererWindow.emit('blur');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('在非 renderer 环境中保持 active 且可安全订阅', () => {
    const source = createElectronRendererLifecycleSource({});
    const listener = vi.fn();

    expect(source.isActive()).toBe(true);
    expect(() => source.subscribe(listener)()).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it('只有 window 代理时也能依据 focus/blur 切换状态', () => {
    const rendererWindow = new FakeWindow();
    const source = createElectronRendererLifecycleSource({ window: rendererWindow });
    const listener = vi.fn();
    source.subscribe(listener);

    rendererWindow.emit('blur');
    rendererWindow.emit('focus');

    expect(listener.mock.calls).toEqual([[false], [true]]);
  });

  it('isActive 会重读创建 source 之后变化的 document focus', () => {
    const rendererDocument = new FakeDocument();
    const source = createElectronRendererLifecycleSource({ document: rendererDocument });

    rendererDocument.focused = false;

    expect(source.isActive()).toBe(false);
  });
});
