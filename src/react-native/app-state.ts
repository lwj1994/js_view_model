import type { ViewModelLifecycleSource } from '../react/index.js';

export interface ReactNativeAppStateSubscription {
  remove(): void;
}

/** The AppState surface used by this library, kept minimal for tests and custom RN hosts. */
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
