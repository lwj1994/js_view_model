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

/** A ViewModel class object used as stable identity, including abstract/protected-base classes. */
export interface ViewModelType<T extends ViewModel> extends Function {
  readonly prototype: T;
}

export interface ViewModelSpecOptions {
  readonly key?: ViewModelKey;
  readonly tag?: unknown;
  readonly aliveForever?: boolean;
  readonly debugLabel?: string;
}

export interface ViewModelCacheLookup {
  readonly key?: ViewModelKey;
  readonly tag?: unknown;
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
