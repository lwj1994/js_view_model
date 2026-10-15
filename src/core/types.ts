import type { ViewModel } from './view-model.js';

export type ViewModelKey = string | number | symbol | boolean | bigint | object;
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
  readonly key?: ViewModelKey | undefined;
  readonly tag?: unknown;
  readonly aliveForever?: boolean;
  readonly debugLabel?: string;
  /** Diagnostic factory identity, never part of instance/cache identity. */
  readonly debugSource?: unknown;
}

export interface ViewModelCacheLookup {
  readonly key?: ViewModelKey | undefined;
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

/** Flutter-compatible state reaction; neither value is artificially nullable. */
export type StateChangeListener<TState> = (previous: TState, current: TState) => void;
