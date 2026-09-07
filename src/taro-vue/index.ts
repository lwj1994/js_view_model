import { useDidHide, useDidShow, useUnload } from '@tarojs/taro';
import { getCurrentScope, onScopeDispose } from 'vue';
import { useViewModelScope, type ViewModelVueScope } from '../vue/index.js';
import type { ViewModelRuntime } from '../core/index.js';

export * from '../vue/index.js';

export interface TaroViewModelScopeOptions {
  readonly runtime?: ViewModelRuntime;
  /** Pause an isolated page runtime on hide. Cannot be combined with an injected runtime. */
  readonly pauseOnHide?: boolean;
}

/** Call in a Taro page setup. Hidden pages retain ownership until unload. */
export function useTaroViewModelScope(options: TaroViewModelScopeOptions = {}): ViewModelVueScope {
  if (options.pauseOnHide && options.runtime) {
    throw new Error('pauseOnHide requires an isolated page runtime; omit runtime.');
  }
  const scope = useViewModelScope({
    ...(options.runtime ? { runtime: options.runtime } : {}),
    isolated: options.pauseOnHide === true,
  });
  useUnload(() => scope.dispose());
  if (options.pauseOnHide) useTaroAppLifecycle(scope.runtime);
  return scope;
}

/** Call once in app setup for a shared runtime, or in an isolated page setup. */
export function useTaroAppLifecycle(runtime: ViewModelRuntime): void {
  if (!getCurrentScope()) throw new Error('Taro lifecycle requires an active Vue effect scope.');
  const token = Symbol('taro-visibility');
  let stopped = false;
  useDidHide(() => {
    if (!stopped && !runtime.isDisposed) runtime.pause(token);
  });
  useDidShow(() => {
    if (!stopped && !runtime.isDisposed) runtime.resume(token);
  });
  onScopeDispose(() => {
    stopped = true;
    if (!runtime.isDisposed) runtime.resume(token);
  });
}
