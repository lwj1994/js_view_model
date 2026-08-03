import type { ViewModel } from './view-model.js';

export type ViewModelKey = string | number | symbol;
export type ViewModelMode = 'watch' | 'read';
export type ViewModelListener = () => void;
export type ViewModelDispose = () => void;

export interface ViewModelChange<TAction = unknown> {
  readonly action: TAction | undefined;
  readonly version: number;
}

/** A builder only constructs a pure object; resolve dependencies through getters after attach. */
export type ViewModelBuilder<T extends ViewModel> = () => T;

export interface ViewModelSpecOptions {
  readonly key?: ViewModelKey;
  readonly aliveForever?: boolean;
  readonly debugLabel?: string;
}

export interface ViewModelBindingOptions {
  readonly id?: string;
  readonly onUpdate?: ViewModelListener;
}

export interface StateChange<TState> {
  readonly current: TState;
  readonly previous: TState;
}

export type StateListener<TState> = (change: StateChange<TState>) => void;
export type Equality<T> = (left: T, right: T) => boolean;
