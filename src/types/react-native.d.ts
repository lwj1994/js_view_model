declare module 'react-native' {
  export type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

  export interface NativeEventSubscription {
    remove(): void;
  }

  export interface AppStateStatic {
    currentState: AppStateStatus;
    addEventListener(
      type: 'change',
      listener: (state: AppStateStatus) => void,
    ): NativeEventSubscription;
  }

  export const AppState: AppStateStatic;
}
