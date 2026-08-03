import { UnmanagedViewModelError, ViewModelDisposedError } from './errors.js';
import type { ViewModelBinding } from './runtime.js';
import type {
  StateListener,
  ViewModelChange,
  ViewModelDispose,
  ViewModelListener,
} from './types.js';

const VIEW_MODEL_BRAND = Symbol.for('view_model.ViewModel.v1');

/**
 * ESM 与 CJS 条件入口会各自加载一份模块代码。使用全局 symbol 让两边仍能操作
 * 同一个 ViewModel 实例，同时用版本后缀隔离未来不兼容的内部协议。
 *
 * @internal
 */
export const VIEW_MODEL_INTERNAL = Symbol.for('view_model.ViewModelInternal.v1');

type RuntimeChangeListener = (change: ViewModelChange) => void;

export interface ViewModelInternal {
  attach(binding: ViewModelBinding, listener: RuntimeChangeListener): void;
  activate(): void;
  bind(bindingId: string): void;
  unbind(bindingId: string): void;
  pause(): void;
  resume(): void;
  dependencyNotify(child: ViewModel): void;
  dispose(): void;
}

/** @internal */
export function isViewModel(value: unknown): value is ViewModel {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }

  const candidate = value as Record<PropertyKey, unknown>;
  return candidate[VIEW_MODEL_BRAND] === true && candidate[VIEW_MODEL_INTERNAL] !== undefined;
}

/**
 * 所有业务 ViewModel 的基础类。
 *
 * 构造函数必须保持纯净；资源初始化放在 `onCreate`，它只会在第一次 commit acquire
 * 后执行。
 */
export abstract class ViewModel {
  readonly #listeners = new Set<ViewModelListener>();
  readonly #disposers: ViewModelDispose[] = [];
  readonly #boundIds = new Map<string, number>();
  #binding: ViewModelBinding | undefined;
  #runtimeListener: RuntimeChangeListener | undefined;
  #version = 0;
  #active = false;
  #disposed = false;
  #paused = false;
  #action: unknown;

  public constructor() {
    Object.defineProperty(this, VIEW_MODEL_BRAND, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
  }

  public get version(): number {
    return this.#version;
  }

  public get isDisposed(): boolean {
    return this.#disposed;
  }

  public get isPaused(): boolean {
    return this.#paused;
  }

  /** 当前实例稳定的父依赖 binding，可在 getter 中 read/watch 子 ViewModel。 */
  public get viewModelBinding(): ViewModelBinding {
    this.assertAlive();
    if (this.#binding === undefined) {
      throw new UnmanagedViewModelError(
        'ViewModel 尚未由 ViewModelRuntime 管理，无法访问 viewModelBinding。',
      );
    }
    return this.#binding;
  }

  /** 直接监听实例版本，主要供 selector 等细粒度适配层使用。 */
  public subscribe(listener: ViewModelListener): ViewModelDispose {
    this.#assertAlive();
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  protected notifyListeners(action?: unknown): void {
    this.#assertAlive();
    this.#version += 1;
    const change: ViewModelChange = {
      action: action ?? this.#action,
      version: this.#version,
    };

    const errors: unknown[] = [];
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.#runtimeListener?.(change);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, 'ViewModel 通知监听器时发生错误。');
  }

  /** 为一次同步修改附加调试 action；嵌套调用会恢复外层 action。 */
  protected update<TResult>(action: unknown, mutation: () => TResult): TResult {
    this.#assertAlive();
    const previous = this.#action;
    this.#action = action;
    try {
      return mutation();
    } finally {
      this.#action = previous;
    }
  }

  /** 注册随实例销毁执行的清理函数。 */
  protected addDispose(dispose: ViewModelDispose): ViewModelDispose {
    this.assertAlive();
    this.#disposers.push(dispose);
    return () => {
      const index = this.#disposers.indexOf(dispose);
      if (index >= 0) this.#disposers.splice(index, 1);
    };
  }

  protected onCreate(): void {}
  protected onBind(_bindingId: string): void {}
  protected onUnbind(_bindingId: string): void {}
  protected onDispose(): void {}
  protected onPause(): void {}
  protected onResume(): void {}
  protected onDependencyNotify(_child: ViewModel): void {}

  protected assertAlive(): void {
    this.#assertAlive();
  }

  /** @internal */
  public readonly [VIEW_MODEL_INTERNAL]: ViewModelInternal = {
    attach: (binding, listener) => {
      if (this.#binding !== undefined) {
        throw new Error('同一个 ViewModel 实例不能被多个 handle 管理。');
      }
      this.#binding = binding;
      this.#runtimeListener = listener;
    },
    activate: () => {
      this.#assertAlive();
      if (this.#active) return;
      this.#active = true;
      this.onCreate();
    },
    bind: (bindingId) => {
      this.#assertAlive();
      const count = this.#boundIds.get(bindingId) ?? 0;
      this.#boundIds.set(bindingId, count + 1);
      if (count === 0) this.onBind(bindingId);
    },
    unbind: (bindingId) => {
      const count = this.#boundIds.get(bindingId);
      if (count === undefined || this.#disposed) return;
      if (count > 1) {
        this.#boundIds.set(bindingId, count - 1);
        return;
      }
      this.#boundIds.delete(bindingId);
      this.onUnbind(bindingId);
    },
    pause: () => {
      if (this.#disposed || this.#paused) return;
      this.#paused = true;
      this.onPause();
    },
    resume: () => {
      if (this.#disposed || !this.#paused) return;
      this.#paused = false;
      this.onResume();
    },
    dependencyNotify: (child) => {
      if (this.#disposed) return;
      const errors: unknown[] = [];
      try {
        this.onDependencyNotify(child);
      } catch (error) {
        errors.push(error);
      }
      try {
        this.notifyListeners({ type: 'dependency', child });
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'ViewModel 依赖通知时发生错误。');
      }
    },
    dispose: () => {
      if (this.#disposed) return;
      const wasActive = this.#active;
      this.#disposed = true;
      const errors: unknown[] = [];

      if (wasActive) {
        try {
          this.onDispose();
        } catch (error) {
          errors.push(error);
        }
      }

      for (const dispose of this.#disposers.splice(0).reverse()) {
        try {
          dispose();
        } catch (error) {
          errors.push(error);
        }
      }

      this.#boundIds.clear();
      this.#listeners.clear();
      this.#runtimeListener = undefined;

      if (errors.length > 0) {
        throw new AggregateError(errors, 'ViewModel 销毁时发生错误。');
      }
    },
  };

  #assertAlive(): void {
    if (this.#disposed) {
      throw new ViewModelDisposedError('ViewModel 已销毁。');
    }
  }
}

export abstract class StateViewModel<TState> extends ViewModel {
  readonly #stateListeners = new Set<StateListener<TState>>();
  readonly #equals: (left: TState, right: TState) => boolean;
  #state: TState;

  protected constructor(
    initialState: TState,
    equals: (left: TState, right: TState) => boolean = Object.is,
  ) {
    super();
    this.#state = initialState;
    this.#equals = equals;
    this.addDispose(() => this.#stateListeners.clear());
  }

  public get state(): TState {
    return this.#state;
  }

  public subscribeState(listener: StateListener<TState>): ViewModelDispose {
    this.assertAlive();
    this.#stateListeners.add(listener);
    return () => {
      this.#stateListeners.delete(listener);
    };
  }

  protected setState(nextState: TState, action?: unknown): boolean {
    this.assertAlive();
    const previous = this.#state;
    if (this.#equals(previous, nextState)) return false;

    this.#state = nextState;
    const change = { current: nextState, previous };
    const errors: unknown[] = [];
    for (const listener of [...this.#stateListeners]) {
      try {
        listener(change);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.notifyListeners(action);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'StateViewModel 通知监听器时发生错误。');
    }
    return true;
  }

  protected updateState(updater: (current: TState) => TState, action?: unknown): boolean {
    this.assertAlive();
    return this.setState(updater(this.#state), action);
  }
}
