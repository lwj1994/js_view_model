import { ErrorType, reportViewModelError } from '../core/config.js';
import {
  ViewModelRuntime,
  type ViewModel,
  type ViewModelBinding,
  type ViewModelListener,
  type ViewModelSpec,
} from '../core/index.js';
import { scheduleMicrotask } from '../shared/microtask.js';

export * from '../core/index.js';

/** Runs a host refresh later; it must not invoke `flush` synchronously. */
export type ViewModelHarmonyScheduler = (flush: () => void) => void;

export interface ViewModelHarmonyScopeOptions {
  /** Share an existing runtime without taking ownership of its lifetime. */
  readonly runtime?: ViewModelRuntime;
  /** Diagnostic Binding id. */
  readonly id?: string;
  /**
   * Publish host-observed state here. It runs after the synchronous update
   * transaction, at most once per scheduled flush, so resolve watched Specs
   * again inside it to pick up the final state and any recycled generation.
   */
  readonly onUpdate?: ViewModelListener;
  /** Defer `onUpdate`; defaults to a microtask. */
  readonly scheduleUpdate?: ViewModelHarmonyScheduler;
}

export interface ViewModelHarmonyScope {
  readonly runtime: ViewModelRuntime;
  readonly binding: ViewModelBinding;
  readonly ownsRuntime: boolean;
  /** True once the scope, its Binding, or its runtime has been disposed. */
  readonly isDisposed: boolean;
  /** False while this scope's host refreshes are paused by `setVisible(false)`. */
  readonly isVisible: boolean;
  read<T extends ViewModel>(spec: ViewModelSpec<T>): T;
  watch<T extends ViewModel>(spec: ViewModelSpec<T>): T;
  /**
   * Pause or resume only this scope's host refreshes, e.g. from a page's
   * onPageHide/onPageShow. ViewModels, their pause hooks, business listeners,
   * and other owners on a shared runtime keep running. Pending changes are
   * delivered once on resume.
   */
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * Own one stable Binding for an ArkUI host. The host must connect onUpdate to
 * its observable state and dispose the scope when its ownership ends.
 * Calls to read/watch acquire instances immediately, so keep them out of
 * ArkUI `build()` and use stable module-level Specs.
 */
export function createViewModelHarmonyScope(
  options: ViewModelHarmonyScopeOptions = {},
): ViewModelHarmonyScope {
  const runtime = options.runtime ?? new ViewModelRuntime();
  const ownsRuntime = options.runtime === undefined;
  const onUpdate = options.onUpdate;
  const schedule = options.scheduleUpdate ?? scheduleMicrotask;
  const visibilityToken = Symbol('view_model.harmony.visibility');
  let disposed = false;
  let visible = true;
  let pending = false;
  // A flush that reached a hidden scope; replayed by setVisible(true).
  let heldWhileHidden = false;

  const isDisposed = (): boolean => disposed || binding.isDisposed || runtime.isDisposed;
  const flush = (): void => {
    if (!pending) return;
    pending = false;
    if (isDisposed()) return;
    if (!visible) {
      heldWhileHidden = true;
      return;
    }
    try {
      onUpdate?.();
    } catch (error) {
      reportViewModelError(error, ErrorType.listener, 'harmony host update');
    }
  };
  const requestUpdate = (): void => {
    // The Binding signals only the first watched event of a transaction;
    // reading here could publish an intermediate state.
    if (pending || disposed || runtime.isDisposed) return;
    pending = true;
    schedule(flush);
  };
  const binding = runtime.createBinding({
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(onUpdate === undefined ? {} : { onUpdate: requestUpdate }),
  });

  return {
    runtime,
    binding,
    ownsRuntime,
    get isDisposed() {
      return isDisposed();
    },
    get isVisible() {
      return visible;
    },
    read<T extends ViewModel>(spec: ViewModelSpec<T>): T {
      return binding.read(spec);
    },
    watch<T extends ViewModel>(spec: ViewModelSpec<T>): T {
      // A stable Binding callback avoids accumulating listeners on repeated reads.
      return binding.watch(spec);
    },
    setVisible(nextVisible) {
      if (isDisposed() || visible === nextVisible) return;
      visible = nextVisible;
      if (!visible) {
        binding.pause(visibilityToken);
        return;
      }
      binding.resume(visibilityToken);
      if (heldWhileHidden) {
        heldWhileHidden = false;
        requestUpdate();
      }
    },
    dispose() {
      if (disposed) return;
      // Stop delivery before cleanup can invoke application lifecycle callbacks.
      disposed = true;
      pending = false;
      heldWhileHidden = false;
      const errors: unknown[] = [];
      try {
        binding.dispose();
      } catch (error) {
        errors.push(error);
      }
      if (ownsRuntime) {
        try {
          runtime.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'ViewModel Harmony scope disposal failed.');
      }
    },
  };
}

export interface ViewModelHarmonyLifecycleOptions {
  /** Initial state of this source, e.g. false when attached while in the background. */
  readonly active?: boolean;
}

export interface ViewModelHarmonyLifecycle {
  readonly isActive: boolean;
  /** Report one app/window lifecycle source. */
  setActive(active: boolean): void;
  /** Remove this source's pause token without disposing the runtime. */
  dispose(): void;
}

/**
 * Connect an app/window lifecycle source (UIAbility foreground/background,
 * window focus) to a runtime. Each source owns an independent pause token;
 * all sources must be active for the runtime to resume. Use
 * `scope.setVisible` for a single page so a shared runtime keeps running.
 */
export function createViewModelHarmonyLifecycle(
  runtime: ViewModelRuntime,
  options: ViewModelHarmonyLifecycleOptions = {},
): ViewModelHarmonyLifecycle {
  const pauseToken = Symbol('view_model.harmony.lifecycle');
  let active = true;
  let disposed = false;

  const lifecycle: ViewModelHarmonyLifecycle = {
    get isActive() {
      return active;
    },
    setActive(nextActive) {
      if (disposed || runtime.isDisposed || active === nextActive) return;
      active = nextActive;
      if (active) runtime.resume(pauseToken);
      else runtime.pause(pauseToken);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!active) {
        active = true;
        // Runtime.resume is also safe after the runtime has been disposed.
        runtime.resume(pauseToken);
      }
    },
  };
  if (options.active === false) lifecycle.setActive(false);
  return lifecycle;
}
