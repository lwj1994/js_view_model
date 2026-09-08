import { effectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({
  show: [] as (() => void)[],
  hide: [] as (() => void)[],
  unload: [] as (() => void)[],
}));
vi.mock('@tarojs/taro', () => ({
  useDidShow: (fn: () => void) => hooks.show.push(fn),
  useDidHide: (fn: () => void) => hooks.hide.push(fn),
  useUnload: (fn: () => void) => hooks.unload.push(fn),
}));
import {
  ViewModel,
  ViewModelRuntime,
  viewModelSpec,
  useViewModel,
  useTaroViewModelScope,
  useTaroAppLifecycle,
} from '../src/taro-vue/index.js';
class Model extends ViewModel {}
const spec = viewModelSpec(Model, () => new Model());
beforeEach(() => {
  hooks.show.length = hooks.hide.length = hooks.unload.length = 0;
});
afterEach(() => vi.unstubAllGlobals());
describe.each([true, false])('Taro Vue lifecycle (native microtask: %s)', (nativeMicrotask) => {
  beforeEach(() => {
    if (!nativeMicrotask) vi.stubGlobal('queueMicrotask', undefined);
  });
  it('retains hidden page owners and releases on unload without pausing shared runtime', async () => {
    const runtime = new ViewModelRuntime(),
      effects = effectScope();
    const owner = effects.run(() => {
      const owner = useTaroViewModelScope({ runtime });
      useViewModel(spec);
      return owner;
    })!;
    const vm = owner.binding.read(spec);
    hooks.hide.forEach((fn) => fn());
    expect(runtime.isPaused).toBe(false);
    expect(owner.isDisposed).toBe(false);
    hooks.unload.forEach((fn) => fn());
    effects.stop();
    await Promise.resolve();
    expect(owner.isDisposed).toBe(true);
    expect(vm.isDisposed).toBe(true);
    expect(runtime.isDisposed).toBe(false);
    runtime.dispose();
  });
  it('pauses only the isolated page runtime and ignores late events after unload', () => {
    const effects = effectScope();
    const owner = effects.run(() => useTaroViewModelScope({ pauseOnHide: true }))!;
    hooks.hide.forEach((fn) => fn());
    expect(owner.runtime.isPaused).toBe(true);
    hooks.show.forEach((fn) => fn());
    expect(owner.runtime.isPaused).toBe(false);
    hooks.unload.forEach((fn) => fn());
    expect(owner.runtime.isDisposed).toBe(true);
    expect(() => hooks.hide.forEach((fn) => fn())).not.toThrow();
    effects.stop();
  });
  it('aggregates application pause tokens and releases its token on cleanup', () => {
    const runtime = new ViewModelRuntime(),
      effects = effectScope();
    effects.run(() => useTaroAppLifecycle(runtime));
    runtime.pause('external');
    hooks.hide.forEach((fn) => fn());
    hooks.show.forEach((fn) => fn());
    expect(runtime.isPaused).toBe(true);
    hooks.hide.forEach((fn) => fn());
    effects.stop();
    runtime.resume('external');
    expect(runtime.isPaused).toBe(false);
    hooks.hide.forEach((fn) => fn());
    expect(runtime.isPaused).toBe(false);
    runtime.dispose();
  });
  it('rejects page hide wiring to an injected shared runtime', () => {
    const runtime = new ViewModelRuntime(),
      effects = effectScope();
    expect(() => effects.run(() => useTaroViewModelScope({ runtime, pauseOnHide: true }))).toThrow(
      'isolated',
    );
    effects.stop();
    runtime.dispose();
  });
});
