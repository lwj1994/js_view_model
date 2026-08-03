import { useMemo, type PropsWithChildren, type ReactElement } from 'react';
import { AppState } from 'react-native';

import type { ViewModelRuntime } from '../core/index.js';
import { InternalViewModelScope, type ViewModelLifecycleSource } from '../react/index.js';
import { createReactNativeAppStateLifecycleSource, type ReactNativeAppState } from './app-state.js';

export interface ViewModelScopeProps extends PropsWithChildren {
  readonly runtime?: ViewModelRuntime | undefined;
  /** 默认使用 react-native 的 AppState；测试或特殊宿主可以注入同结构实现。 */
  readonly appState?: ReactNativeAppState | undefined;
  /** 覆盖默认 AppState 生命周期；适合嵌套页面 Scope 接入导航 focus。 */
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
