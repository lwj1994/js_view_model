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
  /** 注入已有 runtime；省略时，嵌套 Scope 复用父 runtime，根 Scope 创建自己的 runtime。 */
  readonly runtime?: ViewModelRuntime | undefined;
  readonly lifecycle?: ViewModelLifecycleSource | undefined;
}

interface PendingDisposal {
  readonly binding: ViewModelReactContextValue['binding'];
  cancelled: boolean;
}

/**
 * React 公共实现层。它不会作为独立的 Web 入口导出，只由 RN / Electron 包装使用。
 */
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

      // React StrictMode 会执行 setup -> cleanup -> setup。延迟到微任务既能让第二次
      // setup 取消回收，又能保证真实卸载最终释放 binding 与根 runtime。
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
          // 嵌套 Scope 的 cleanup 顺序不应决定正确性；再让出一个微任务，确保
          // 共用该 runtime 的 child binding 都有机会先释放自己的 owner。
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
