import { useMemo, type PropsWithChildren, type ReactElement } from 'react';

import type { ViewModelRuntime } from '../core/index.js';
import { InternalViewModelScope } from '../react/index.js';
import {
  createElectronRendererLifecycleSource,
  type ElectronLifecycleSource,
} from './lifecycle.js';

export interface ViewModelScopeProps extends PropsWithChildren {
  readonly runtime?: ViewModelRuntime | undefined;
  /** Read window/document from the current Electron renderer by default. */
  readonly lifecycle?: ElectronLifecycleSource | undefined;
}

export function ViewModelScope({
  children,
  runtime,
  lifecycle: injectedLifecycle,
}: ViewModelScopeProps): ReactElement {
  const lifecycle = useMemo(
    () => injectedLifecycle ?? createElectronRendererLifecycleSource(),
    [injectedLifecycle],
  );

  return (
    <InternalViewModelScope runtime={runtime} lifecycle={lifecycle}>
      {children}
    </InternalViewModelScope>
  );
}
