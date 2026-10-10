import {
  ViewModelRuntime,
  type ViewModel,
  type ViewModelBinding,
  type ViewModelListener,
  type ViewModelSpec,
} from '../core/index.js';

export * from '../core/index.js';

export interface ViewModelHarmonyScopeOptions {
  /** Share an existing runtime without taking ownership of its lifetime. */
  readonly runtime?: ViewModelRuntime;
  /** Update host-observed state here, resolving watched Specs again after recycle. */
  readonly onUpdate?: ViewModelListener;
}

export interface ViewModelHarmonyScope {
  readonly runtime: ViewModelRuntime;
  readonly binding: ViewModelBinding;
  readonly ownsRuntime: boolean;
  /** True once the scope, its Binding, or its runtime has been disposed. */
  readonly isDisposed: boolean;
  read<T extends ViewModel>(spec: ViewModelSpec<T>): T;
  watch<T extends ViewModel>(spec: ViewModelSpec<T>): T;
  dispose(): void;
}

/**
 * Own one stable Binding for an ArkUI host. The host must connect onUpdate to
 * its observable state and dispose the scope when its ownership ends.
 * Calls to read/watch acquire instances immediately, so keep them outside
 * speculative UI rendering and use stable Specs.
 */
export function createViewModelHarmonyScope(
  options: ViewModelHarmonyScopeOptions = {},
): ViewModelHarmonyScope {
  const runtime = options.runtime ?? new ViewModelRuntime();
  const ownsRuntime = options.runtime === undefined;
  const onUpdate = options.onUpdate;
  let disposed = false;
  const binding = runtime.createBinding({
    onUpdate: () => {
      if (!disposed && !runtime.isDisposed) onUpdate?.();
    },
  });

  return {
    runtime,
    binding,
    ownsRuntime,
    get isDisposed() {
      return disposed || binding.isDisposed || runtime.isDisposed;
    },
    read<T extends ViewModel>(spec: ViewModelSpec<T>): T {
      return binding.read(spec);
    },
    watch<T extends ViewModel>(spec: ViewModelSpec<T>): T {
      // A stable Binding callback avoids accumulating listeners on repeated reads.
      return binding.watch(spec);
    },
    dispose() {
      if (disposed) return;
      // Stop delivery before cleanup can invoke application lifecycle callbacks.
      disposed = true;
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

export interface ViewModelHarmonyLifecycle {
  /** Report one app/window lifecycle source; it starts active. */
  setActive(active: boolean): void;
  /** Remove this source's pause token without disposing the runtime. */
  dispose(): void;
}

/**
 * Connect an app/window lifecycle source to a runtime. Each source owns an
 * independent pause token; all sources must be active for updates to resume.
 * Component visibility should not pause a runtime shared with other pages.
 */
export function createViewModelHarmonyLifecycle(
  runtime: ViewModelRuntime,
): ViewModelHarmonyLifecycle {
  const pauseToken = Symbol('view_model.harmony.lifecycle');
  let active = true;
  let disposed = false;

  return {
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
}
