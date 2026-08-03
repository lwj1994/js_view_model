import { createContext, useContext } from 'react';

import type { ViewModelBinding, ViewModelRuntime } from '../core/index.js';

export interface ViewModelReactContextValue {
  readonly runtime: ViewModelRuntime;
  readonly binding: ViewModelBinding;
}

export const ViewModelReactContext = createContext<ViewModelReactContextValue | null>(null);

export function useViewModelContext(): ViewModelReactContextValue {
  const value = useContext(ViewModelReactContext);

  if (value === null) {
    throw new Error('ViewModel Hook 必须在 ViewModelScope 内调用。');
  }

  return value;
}
