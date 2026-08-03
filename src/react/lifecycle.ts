import { useEffect, useRef } from 'react';

import type { ViewModelRuntime } from '../core/index.js';

/** Minimal platform lifecycle surface. Platform entry points map native events to active/inactive. */
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
      // A departing window/native source clears only its own pause reason and
      // must not wake other sources. Deferring resume by one microtask lets a
      // StrictMode cleanup -> setup cancel it, avoiding a false onResume/onPause
      // pair while a background app is being probed in development.
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
