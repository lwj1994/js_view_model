import type { ViewModelLifecycleSource } from '../react/index.js';

export interface ReactNativeAppStateSubscription {
  remove(): void;
}

/** 仅描述本库使用的 AppState 表面，方便测试与定制 RN 宿主。 */
export interface ReactNativeAppState {
  readonly currentState: string | null;
  addEventListener(
    type: 'change',
    listener: (state: string) => void,
  ): ReactNativeAppStateSubscription;
}

export function createReactNativeAppStateLifecycleSource(
  appState: ReactNativeAppState,
): ViewModelLifecycleSource {
  return {
    isActive: () => appState.currentState === 'active',
    subscribe(listener) {
      const subscription = appState.addEventListener('change', (state) => {
        listener(state === 'active');
      });

      return () => subscription.remove();
    },
  };
}
