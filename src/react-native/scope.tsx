import { useMemo, type PropsWithChildren, type ReactElement } from 'react';
import { AppState } from 'react-native';

import type { ViewModelRuntime } from '../core/index.js';
import { InternalViewModelScope, type ViewModelLifecycleSource } from '../react/index.js';
import { createReactNativeAppStateLifecycleSource, type ReactNativeAppState } from './app-state.js';

export interface ViewModelScopeProps extends PropsWithChildren {
  readonly runtime?: ViewModelRuntime | undefined;
  /** Use React Native AppState by default; tests and custom hosts may inject this minimal shape. */
  readonly appState?: ReactNativeAppState | undefined;
  /**
   * Override the AppState lifecycle. Lifecycle is Runtime-wide, so connect
   * navigation focus only to an independent Runtime or for intentional whole-Runtime pause.
   */
  readonly lifecycle?: ViewModelLifecycleSource | undefined;
}

export function ViewModelScope({
  children,
  runtime,
  appState = AppState,
  lifecycle: injectedLifecycle,
}: ViewModelScopeProps): ReactElement {
  const appStateLifecycle = useMemo(
    () => createReactNativeAppStateLifecycleSource(appState),
    [appState],
  );
  const lifecycle = injectedLifecycle ?? appStateLifecycle;

  return (
    <InternalViewModelScope runtime={runtime} lifecycle={lifecycle}>
      {children}
    </InternalViewModelScope>
  );
}
