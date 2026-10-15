import type { Equality, ViewModelDispose, ViewModelKey, ViewModelType } from './types.js';
import type { ViewModel } from './view-model.js';

export enum ErrorType {
  listener = 'listener',
  lifecycle = 'lifecycle',
  dispose = 'dispose',
  pauseResume = 'pauseResume',
}

export interface ViewModelConfig {
  readonly equals?: Equality<unknown>;
  readonly isLoggingEnabled?: boolean;
  readonly onError?: (error: unknown, type: ErrorType, context: string) => void;
  readonly onWarning?: (message: string) => void;
}

export interface ViewModelInstanceInfo {
  readonly key: ViewModelKey | undefined;
  readonly tag: unknown;
  readonly aliveForever: boolean;
  readonly generation: number;
  readonly debugLabel: string;
  readonly type: ViewModelType<ViewModel> | undefined;
}

export interface ViewModelLifecycle {
  onCreate?(viewModel: ViewModel, info: ViewModelInstanceInfo): void;
  onBind?(viewModel: ViewModel, info: ViewModelInstanceInfo, bindingId: string): void;
  onUnbind?(viewModel: ViewModel, info: ViewModelInstanceInfo, bindingId: string): void;
  onDispose?(viewModel: ViewModel, info: ViewModelInstanceInfo): void;
}

export interface ViewModelInitializeOptions {
  readonly config?: ViewModelConfig;
  readonly lifecycles?: Iterable<ViewModelLifecycle>;
}

interface ConfigurationState {
  initialized: boolean;
  resetting: boolean;
  config: ViewModelConfig;
  readonly lifecycles: Set<ViewModelLifecycle>;
  readonly resets: Set<ViewModelDispose>;
  readonly resetCompletions: Set<ViewModelDispose>;
}

const CONFIGURATION = Symbol.for('view_model.Configuration.v1');
const local: ConfigurationState = {
  initialized: false,
  resetting: false,
  config: {},
  lifecycles: new Set(),
  resets: new Set(),
  resetCompletions: new Set(),
};

function sharedState(): ConfigurationState {
  const global = globalThis as Record<PropertyKey, unknown>;
  const existing = global[CONFIGURATION];
  if (existing !== undefined) return existing as ConfigurationState;
  try {
    Object.defineProperty(global, CONFIGURATION, { value: local });
  } catch {
    /* Frozen globals use a module-local fallback. */
  }
  return local;
}

/** @internal */
export function getViewModelConfig(): ViewModelConfig {
  return sharedState().config;
}

/** @internal */
export function initializeViewModels(options: ViewModelInitializeOptions = {}): void {
  const state = sharedState();
  if (state.initialized) return;
  state.initialized = true;
  state.config = Object.freeze({ ...options.config });
  for (const observer of options.lifecycles ?? []) state.lifecycles.add(observer);
}

/** @internal */
export function addViewModelLifecycle(observer: ViewModelLifecycle): ViewModelDispose {
  sharedState().lifecycles.add(observer);
  return () => removeViewModelLifecycle(observer);
}

/** @internal */
export function removeViewModelLifecycle(observer: ViewModelLifecycle): void {
  sharedState().lifecycles.delete(observer);
}

/** @internal */
export function registerViewModelReset(reset: ViewModelDispose): ViewModelDispose {
  sharedState().resets.add(reset);
  return () => sharedState().resets.delete(reset);
}

/** Force-dispose cached generations before clearing process-wide configuration. @internal */
export function isViewModelResetting(): boolean {
  return sharedState().resetting;
}

/** Deliver recovery callbacks only after every Runtime and global configuration is reset. @internal */
export function afterViewModelReset(callback: ViewModelDispose): void {
  const state = sharedState();
  if (state.resetting) state.resetCompletions.add(callback);
  else callback();
}

/** @internal */
export function resetViewModels(): void {
  const state = sharedState();
  if (state.resetting) return;
  state.resetting = true;
  try {
    for (const reset of [...state.resets]) {
      try {
        reset();
      } catch (error) {
        reportViewModelError(error, ErrorType.dispose, 'reset');
      }
    }
  } finally {
    state.resetting = false;
    state.initialized = false;
    state.config = {};
    state.lifecycles.clear();
    const completions = [...state.resetCompletions];
    state.resetCompletions.clear();
    for (const complete of completions) {
      try {
        complete();
      } catch (error) {
        reportViewModelError(error, ErrorType.listener, 'reset completion');
      }
    }
  }
}

/** Error reporting must never interrupt cleanup, ownership, or the remaining listeners. @internal */
export function reportViewModelError(error: unknown, type: ErrorType, context: string): void {
  try {
    const handler = getViewModelConfig().onError;
    if (handler !== undefined) {
      handler(error, type, context);
      return;
    }
    console.error(`[view_model:${type}] ${context}`, error);
  } catch (handlerError) {
    try {
      console.error('[view_model] Error handler failed', handlerError, error);
    } catch {
      /* Diagnostic sinks are optional. */
    }
  }
}

/** @internal */
export function warnViewModel(message: string): void {
  const config = getViewModelConfig();
  if (!config.isLoggingEnabled && config.onWarning === undefined) return;
  try {
    (config.onWarning ?? console.warn)(message);
  } catch (error) {
    reportViewModelError(error, ErrorType.listener, 'warning handler');
  }
}

/** @internal */
export function notifyViewModelLifecycle(
  event: keyof ViewModelLifecycle,
  vm: ViewModel,
  info: ViewModelInstanceInfo | undefined,
  id?: string,
): void {
  if (info === undefined) return;
  const observers = sharedState().lifecycles;
  for (const observer of [...observers]) {
    if (!observers.has(observer)) continue;
    try {
      if (event === 'onBind' || event === 'onUnbind') observer[event]?.(vm, info, id!);
      else observer[event]?.(vm, info);
    } catch (error) {
      reportViewModelError(error, ErrorType.lifecycle, `observer.${event}`);
    }
  }
}
