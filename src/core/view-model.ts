import { UnmanagedViewModelError, ViewModelDisposedError } from './errors.js';
import {
  addViewModelLifecycle,
  ErrorType,
  getViewModelConfig,
  initializeViewModels,
  notifyViewModelLifecycle,
  removeViewModelLifecycle,
  reportViewModelError,
  resetViewModels,
  type ViewModelConfig,
  type ViewModelInitializeOptions,
  type ViewModelInstanceInfo,
  type ViewModelLifecycle,
} from './config.js';
import { registerConstructionRollback } from './construction.js';
import type { ViewModelBinding } from './runtime.js';
import type {
  Equality,
  StateChange,
  StateChangeListener,
  StateListener,
  ViewModelChange,
  ViewModelDispose,
  ViewModelKey,
  ViewModelListener,
} from './types.js';
import { runInViewModelUpdateTransaction } from './update-transaction.js';

const VIEW_MODEL_BRAND = Symbol.for('view_model.ViewModel.v1');
/** Cross-entry identity for ESM/CJS and platform re-exports. @internal */
export const VIEW_MODEL_INTERNAL = Symbol.for('view_model.ViewModelInternal.v2');
type RuntimeChangeListener = (change: ViewModelChange) => void;

export interface ViewModelInternal {
  readonly isDisposed: boolean;
  attach(
    binding: ViewModelBinding,
    listener: RuntimeChangeListener,
    info: ViewModelInstanceInfo,
  ): void;
  activate(): void;
  bind(bindingId: string, source: object): void;
  unbind(bindingId: string, source: object, beforeNotify?: () => void): void;
  flushUnbinds(): void;
  pause(): void;
  resume(): void;
  dependencyNotify(child: ViewModel): void;
  dispose(): void;
}

/** @internal */
export function isViewModel(value: unknown): value is ViewModel {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const candidate = value as Record<PropertyKey, unknown>;
  return candidate[VIEW_MODEL_BRAND] === true && candidate[VIEW_MODEL_INTERNAL] !== undefined;
}

/**
 * A lifecycle-owned application module. Constructors stay pure; initialize
 * resources in onCreate. A prepared React object does not acquire ownership.
 */
export abstract class ViewModel {
  readonly #listeners: ViewModelListener[] = [];
  readonly #listenerCounts = new Map<ViewModelListener, number>();
  readonly #disposers: ViewModelDispose[] = [];
  readonly #boundIds = new Map<string, Set<object>>();
  readonly #pendingUnbinds = new Map<string, object>();
  #binding: ViewModelBinding | undefined;
  #info: ViewModelInstanceInfo | undefined;
  #runtimeListener: RuntimeChangeListener | undefined;
  #version = 0;
  #active = false;
  #disposed = false;
  #paused = false;
  #action: unknown;

  public constructor() {
    Object.defineProperty(this, VIEW_MODEL_BRAND, { value: true });
    registerConstructionRollback(() => this[VIEW_MODEL_INTERNAL].dispose());
  }

  public static get config(): ViewModelConfig {
    return getViewModelConfig();
  }
  public static initialize(options: ViewModelInitializeOptions = {}): void {
    initializeViewModels(options);
  }
  public static addLifecycle(observer: ViewModelLifecycle): ViewModelDispose {
    return addViewModelLifecycle(observer);
  }
  public static removeLifecycle(observer: ViewModelLifecycle): void {
    removeViewModelLifecycle(observer);
  }
  public static reset(): void {
    resetViewModels();
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
  public get hasListeners(): boolean {
    return this.#listeners.length > 0;
  }
  public get key(): ViewModelKey | undefined {
    return this.#info?.key;
  }
  public get tag(): unknown {
    return this.#info?.tag;
  }
  public get instanceInfo(): ViewModelInstanceInfo | undefined {
    return this.#info;
  }
  /** A snapshot of lifecycle IDs; multiple owner paths with one ID are folded together. */
  public get bindingIds(): readonly string[] {
    return [...this.#boundIds.keys()];
  }

  /** Stable per-generation dependency owner; resolve children in getters after attach. */
  public get viewModelBinding(): ViewModelBinding {
    this.#assertAlive();
    if (this.#binding === undefined) {
      throw new UnmanagedViewModelError('ViewModel is not managed by a ViewModelRuntime.');
    }
    return this.#binding;
  }

  public addListener(listener: ViewModelListener): void {
    this.#assertAlive();
    this.#listeners.push(listener);
    this.#listenerCounts.set(listener, (this.#listenerCounts.get(listener) ?? 0) + 1);
  }

  /** Remove one registration, preserving other registrations of the same function. */
  public removeListener(listener: ViewModelListener): void {
    const index = this.#listeners.indexOf(listener);
    if (index < 0) return;
    this.#listeners.splice(index, 1);
    const count = this.#listenerCounts.get(listener)!;
    if (count === 1) this.#listenerCounts.delete(listener);
    else this.#listenerCounts.set(listener, count - 1);
  }

  /** Each returned disposer cancels only this registration. */
  public subscribe(listener: ViewModelListener): ViewModelDispose {
    const wrapper = () => listener();
    this.addListener(wrapper);
    return () => this.removeListener(wrapper);
  }
  public listen(onChanged: ViewModelListener): ViewModelDispose {
    return this.subscribe(onChanged);
  }

  /** Broad notification only: it never fabricates a StateViewModel state diff. */
  public notifyListeners(action?: unknown): void {
    if (this.#disposed) return;
    runInViewModelUpdateTransaction(() => {
      this.#version += 1;
      const change: ViewModelChange = { action: action ?? this.#action, version: this.#version };
      for (const listener of [...this.#listeners]) {
        if (this.#disposed) break;
        if (!this.#listenerCounts.has(listener)) continue;
        try {
          listener();
        } catch (error) {
          reportViewModelError(error, ErrorType.listener, 'notifyListeners');
        }
      }
      if (this.#disposed) return;
      try {
        this.#runtimeListener?.(change);
      } catch (error) {
        reportViewModelError(error, ErrorType.listener, 'binding notification');
      }
    });
  }

  /** Notify after successful synchronous mutation or successful async completion. */
  public update<TResult>(mutation: () => TResult): TResult;
  public update<TResult>(action: unknown, mutation: () => TResult): TResult;
  public update<TResult>(actionOrMutation: unknown, mutation?: () => TResult): TResult {
    this.#assertAlive();
    const block = mutation ?? (actionOrMutation as () => TResult);
    const action = mutation === undefined ? this.#action : actionOrMutation;
    const previous = this.#action;
    this.#action = action;
    let result: TResult;
    try {
      result = block();
    } finally {
      this.#action = previous;
    }
    if (
      result !== null &&
      result !== undefined &&
      typeof (result as unknown as PromiseLike<unknown>).then === 'function'
    ) {
      // Capture this action rather than keeping ambient mutable state across await.
      return Promise.resolve(result).then((value) => {
        if (!this.#disposed) this.notifyListeners(action);
        return value;
      }) as TResult;
    }
    if (!this.#disposed) this.notifyListeners(action);
    return result;
  }

  public addDispose(dispose: ViewModelDispose): ViewModelDispose {
    this.#assertAlive();
    const wrapper = () => dispose();
    this.#disposers.push(wrapper);
    return () => {
      const index = this.#disposers.indexOf(wrapper);
      if (index >= 0) this.#disposers.splice(index, 1);
    };
  }

  protected onCreate(): void {}
  protected onBind(_bindingId: string): void {}
  protected onUnbind(_bindingId: string): void {}
  protected onDispose(): void {}
  protected onPause(): void {}
  protected onResume(): void {}
  protected assertAlive(): void {
    this.#assertAlive();
  }

  #publishUnbind(id: string, release: object): void {
    if (this.#pendingUnbinds.get(id) !== release) return;
    this.#pendingUnbinds.delete(id);
    notifyViewModelLifecycle('onUnbind', this, this.#info, id);
    try {
      this.onUnbind(id);
    } catch (error) {
      reportViewModelError(error, ErrorType.lifecycle, 'onUnbind');
    }
  }

  /** @internal */
  public readonly [VIEW_MODEL_INTERNAL]: ViewModelInternal = (() => {
    const self = this;
    return {
      get isDisposed() {
        return self.#disposed;
      },
      attach: (binding, listener, info) => {
        this.#assertAlive();
        if (this.#binding !== undefined)
          throw new Error('A ViewModel instance cannot be managed by multiple handles.');
        this.#binding = binding;
        this.#runtimeListener = listener;
        this.#info = Object.freeze(info);
      },
      activate: () => {
        this.#assertAlive();
        if (this.#active) return;
        this.#active = true;
        notifyViewModelLifecycle('onCreate', this, this.#info);
        if (this.#disposed) return;
        try {
          this.onCreate();
        } catch (error) {
          reportViewModelError(error, ErrorType.lifecycle, 'onCreate');
        }
      },
      bind: (id, source) => {
        this.#assertAlive();
        const sources = this.#boundIds.get(id) ?? new Set<object>();
        if (sources.has(source)) return;
        sources.add(source);
        this.#boundIds.set(id, sources);
        if (sources.size !== 1) return;
        this.#pendingUnbinds.delete(id);
        notifyViewModelLifecycle('onBind', this, this.#info, id);
        if (this.#disposed || !this.#boundIds.get(id)?.has(source)) return;
        try {
          this.onBind(id);
        } catch (error) {
          reportViewModelError(error, ErrorType.lifecycle, 'onBind');
        }
      },
      unbind: (id, source, beforeNotify) => {
        if (this.#disposed) return;
        const sources = this.#boundIds.get(id);
        if (sources === undefined || !sources.delete(source)) return;
        const release = sources.size === 0 ? {} : undefined;
        if (release !== undefined) {
          this.#boundIds.delete(id);
          this.#pendingUnbinds.set(id, release);
        }
        try {
          beforeNotify?.();
        } finally {
          if (release !== undefined) this.#publishUnbind(id, release);
        }
      },
      flushUnbinds: () => {
        for (const [id, release] of [...this.#pendingUnbinds]) this.#publishUnbind(id, release);
      },
      pause: () => {
        if (this.#disposed || this.#paused) return;
        this.#paused = true;
        try {
          this.onPause();
        } catch (error) {
          reportViewModelError(error, ErrorType.pauseResume, 'onPause');
        }
      },
      resume: () => {
        if (this.#disposed || !this.#paused) return;
        this.#paused = false;
        try {
          this.onResume();
        } catch (error) {
          reportViewModelError(error, ErrorType.pauseResume, 'onResume');
        }
      },
      dependencyNotify: (child) => {
        if (!this.#disposed) this.notifyListeners({ type: 'dependency', child });
      },
      dispose: () => {
        if (this.#disposed) return;
        this[VIEW_MODEL_INTERNAL].flushUnbinds();
        this.#disposed = true;
        if (this.#active) {
          try {
            this.onDispose();
          } catch (error) {
            reportViewModelError(error, ErrorType.dispose, 'onDispose');
          }
        }
        for (const dispose of this.#disposers.splice(0).reverse()) {
          try {
            dispose();
          } catch (error) {
            reportViewModelError(error, ErrorType.dispose, 'resource cleanup');
          }
        }
        this.#boundIds.clear();
        this.#pendingUnbinds.clear();
        this.#listeners.length = 0;
        this.#listenerCounts.clear();
        this.#runtimeListener = undefined;
        if (this.#active) notifyViewModelLifecycle('onDispose', this, this.#info);
      },
    };
  })();

  #assertAlive(): void {
    if (this.#disposed) throw new ViewModelDisposedError('ViewModel has been disposed.');
  }
}

export abstract class StateViewModel<TState> extends ViewModel {
  readonly #stateListeners = new Set<StateListener<TState>>();
  readonly #equals: Equality<TState> | undefined;
  readonly #pendingStateEvents: (StateChange<TState> & { action: unknown })[] = [];
  readonly initialState: TState;
  #dispatchingStateEvents = false;
  #state: TState;
  #previousState: TState | undefined;

  protected constructor(initialState: TState, equals?: Equality<TState>) {
    super();
    this.initialState = initialState;
    this.#state = initialState;
    this.#equals = equals;
    this.addDispose(() => {
      this.#stateListeners.clear();
      this.#pendingStateEvents.length = 0;
    });
  }

  public get state(): TState {
    return this.#state;
  }
  public get initState(): TState {
    return this.initialState;
  }
  public get previousState(): TState | undefined {
    return this.#previousState;
  }

  public subscribeState(listener: StateListener<TState>): ViewModelDispose {
    this.assertAlive();
    const wrapper: StateListener<TState> = (change) => listener(change);
    this.#stateListeners.add(wrapper);
    return () => {
      this.#stateListeners.delete(wrapper);
    };
  }
  public listenState(onChanged: StateChangeListener<TState>): ViewModelDispose {
    return this.subscribeState(({ previous, current }) => onChanged(previous, current));
  }

  public listenStateSelect<TSelection>(
    selector: (state: TState) => TSelection,
    onChanged: StateChangeListener<TSelection>,
    equals?: Equality<TSelection>,
  ): ViewModelDispose {
    const compare = equals ?? getViewModelConfig().equals ?? Object.is;
    return this.subscribeState(({ current, previous }) => {
      const before = selector(previous);
      const after = selector(current);
      if (!compare(before, after)) onChanged(before, after);
    });
  }

  protected setState(nextState: TState, action?: unknown): boolean {
    if (this.isDisposed) return false;
    const previous = this.#state;
    try {
      if ((this.#equals ?? getViewModelConfig().equals ?? Object.is)(previous, nextState))
        return false;
    } catch (error) {
      this.onError(error);
      return false;
    }
    this.#previousState = previous;
    this.#state = nextState;
    this.#pendingStateEvents.push({ previous, current: nextState, action });
    if (this.#dispatchingStateEvents) return true;
    this.#dispatchingStateEvents = true;
    try {
      runInViewModelUpdateTransaction(() => {
        // A state callback may enqueue another transition. Finish this event for
        // all remaining listeners before beginning the next event.
        for (let index = 0; index < this.#pendingStateEvents.length; index += 1) {
          if (this[VIEW_MODEL_INTERNAL].isDisposed) break;
          const event = this.#pendingStateEvents[index]!;
          const change = { previous: event.previous, current: event.current };
          for (const listener of [...this.#stateListeners]) {
            if (this[VIEW_MODEL_INTERNAL].isDisposed) break;
            if (!this.#stateListeners.has(listener)) continue;
            try {
              listener(change);
            } catch (error) {
              reportViewModelError(error, ErrorType.listener, 'state listener');
            }
          }
          if (!this[VIEW_MODEL_INTERNAL].isDisposed) super.notifyListeners(event.action);
        }
      });
    } finally {
      this.#dispatchingStateEvents = false;
      this.#pendingStateEvents.length = 0;
    }
    return true;
  }

  protected updateState(updater: (current: TState) => TState, action?: unknown): boolean {
    if (this.isDisposed) return false;
    return this.setState(updater(this.#state), action);
  }
  protected onError(error: unknown): void {
    reportViewModelError(error, ErrorType.listener, 'setState');
  }
}
