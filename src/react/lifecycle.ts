import { useEffect, useRef } from 'react';

import type { ViewModelRuntime } from '../core/index.js';

/**
 * 平台生命周期的最小结构。平台入口负责把原生事件转换成 active / inactive。
 */
export interface ViewModelLifecycleSource {
  isActive(): boolean;
  subscribe(listener: (active: boolean) => void): () => void;
}

interface PendingResume {
  readonly runtime: ViewModelRuntime;
  readonly token: object;
  cancelled: boolean;
}

export function useRuntimeLifecycle(
  runtime: ViewModelRuntime,
  source: ViewModelLifecycleSource | undefined,
): void {
  const pauseToken = useRef<object | null>(null);
  pauseToken.current ??= {};
  const pendingResume = useRef<PendingResume | undefined>(undefined);

  useEffect(() => {
    const token = pauseToken.current as object;
    const pending = pendingResume.current;
    if (pending !== undefined && pending.runtime === runtime && pending.token === token) {
      pending.cancelled = true;
      pendingResume.current = undefined;
    }

    if (source === undefined) {
      runtime.resume(token);
      return undefined;
    }

    const apply = (active: boolean): void => {
      if (active) {
        runtime.resume(token);
      } else {
        runtime.pause(token);
      }
    };

    let unsubscribe: (() => void) | undefined;
    try {
      apply(source.isActive());
      unsubscribe = source.subscribe(apply);
    } catch (installError) {
      try {
        runtime.resume(token);
      } catch (resumeError) {
        throw new AggregateError(
          [installError, resumeError],
          'ViewModel lifecycle source 安装失败。',
        );
      }
      throw installError;
    }

    return () => {
      let unsubscribeError: unknown;
      try {
        unsubscribe?.();
      } catch (error) {
        unsubscribeError = error;
      }
      // 某个窗口/原生 source 离开后只释放自己的暂停原因，不能唤醒其他 source。
      // resume 延迟一个微任务，使 StrictMode 的 cleanup -> setup 能取消这次释放，
      // 避免后台应用在开发探测期间产生一次虚假的 onResume / onPause。
      const task: PendingResume = { runtime, token, cancelled: false };
      pendingResume.current = task;
      queueMicrotask(() => {
        if (!task.cancelled) {
          runtime.resume(token);
        }
        if (pendingResume.current === task) {
          pendingResume.current = undefined;
        }
      });
      if (unsubscribeError !== undefined) throw unsubscribeError;
    };
  }, [runtime, source]);
}
