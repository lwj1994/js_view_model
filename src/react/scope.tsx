import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  type PropsWithChildren,
  type ReactElement,
} from 'react';

import { ViewModelRuntime } from '../core/index.js';
import { ViewModelReactContext, type ViewModelReactContextValue } from './context.js';
import { useRuntimeLifecycle, type ViewModelLifecycleSource } from './lifecycle.js';

export interface InternalViewModelScopeProps extends PropsWithChildren {
  /** Inject an existing runtime. Otherwise a nested Scope reuses its parent and a root Scope creates one. */
  readonly runtime?: ViewModelRuntime | undefined;
  readonly lifecycle?: ViewModelLifecycleSource | undefined;
}

interface PendingDisposal {
  readonly binding: ViewModelReactContextValue['binding'];
  cancelled: boolean;
}

/** Shared React implementation. It is wrapped by RN/Electron and is not exported as a Web entry point. */
export function InternalViewModelScope({
  children,
  runtime: injectedRuntime,
  lifecycle,
}: InternalViewModelScopeProps): ReactElement {
  const parent = useContext(ViewModelReactContext);
  const parentRuntime = parent?.runtime;
  const ownsRuntime = injectedRuntime === undefined && parentRuntime === undefined;
  const ownedRuntime = useRef<ViewModelRuntime | undefined>(undefined);
  if (ownsRuntime && ownedRuntime.current === undefined) {
    ownedRuntime.current = new ViewModelRuntime();
  }

  const runtime = injectedRuntime ?? parentRuntime ?? (ownedRuntime.current as ViewModelRuntime);
  const bindingSlot = useRef<
    | {
        readonly runtime: ViewModelRuntime;
        readonly binding: ViewModelReactContextValue['binding'];
      }
    | undefined
  >(undefined);
  if (bindingSlot.current === undefined || bindingSlot.current.runtime !== runtime) {
    bindingSlot.current = { runtime, binding: runtime.createBinding() };
  }
  const binding = bindingSlot.current.binding;
  const value = useMemo<ViewModelReactContextValue>(
    () => ({ runtime, binding }),
    [binding, runtime],
  );
  const pendingDisposal = useRef<PendingDisposal | undefined>(undefined);

  useEffect(() => {
    const pending = pendingDisposal.current;
    if (pending !== undefined && pending.binding === binding) {
      pending.cancelled = true;
      pendingDisposal.current = undefined;
    }

    return () => {
      const task: PendingDisposal = { binding, cancelled: false };
      pendingDisposal.current = task;

      // React StrictMode runs setup -> cleanup -> setup. A microtask delay lets
      // the second setup cancel disposal while a real unmount still releases
      // the binding and root runtime.
      queueMicrotask(() => {
        if (task.cancelled) {
          return;
        }

        let bindingError: unknown;
        try {
          binding.dispose();
        } catch (error) {
          bindingError = error;
        }
        if (pendingDisposal.current === task) {
          pendingDisposal.current = undefined;
        }

        if (ownsRuntime) {
          // Nested Scope cleanup order must not affect correctness. Yield one
          // more microtask so child bindings that share this runtime can release
          // their owners first.
          queueMicrotask(() => {
            const errors: unknown[] = [];
            if (bindingError !== undefined) errors.push(bindingError);
            try {
              runtime.dispose();
            } catch (error) {
              errors.push(error);
            }
            if (errors.length > 0) {
              throw new AggregateError(errors, 'ViewModelScope 销毁时发生错误。');
            }
          });
        } else if (bindingError !== undefined) {
          throw bindingError;
        }
      });
    };
  }, [binding, ownsRuntime, runtime]);

  useRuntimeLifecycle(runtime, lifecycle);

  return <ViewModelReactContext.Provider value={value}>{children}</ViewModelReactContext.Provider>;
}
