import {
  getCurrentInstance,
  getCurrentScope,
  inject,
  onScopeDispose,
  provide,
  shallowReadonly,
  shallowRef,
  triggerRef,
  type EffectScope,
  type InjectionKey,
  type ShallowRef,
} from 'vue';
import {
  ViewModelRuntime,
  type ViewModel,
  type ViewModelBinding,
  type ViewModelSpec,
  type ViewModelMode,
} from '../core/index.js';

export * from '../core/index.js';

export interface ViewModelVueScope {
  readonly runtime: ViewModelRuntime;
  readonly binding: ViewModelBinding;
  readonly ownsRuntime: boolean;
  readonly isDisposed: boolean;
  dispose(): void;
}

export interface ViewModelVueScopeOptions {
  readonly runtime?: ViewModelRuntime;
  /** Create an independent runtime instead of inheriting the parent runtime. */
  readonly isolated?: boolean;
}

// Share context identity across ESM/CJS and the Taro re-export.
const scopeKey = Symbol.for('@lwjlol/view_model/vue/scope') as InjectionKey<ViewModelVueScope>;
const localScopes = new WeakMap<EffectScope, ViewModelVueScope>();

function activeScope(): EffectScope {
  const scope = getCurrentScope();
  if (!scope) throw new Error('ViewModel composables require an active Vue effect scope.');
  return scope;
}

function inheritedScope(): ViewModelVueScope | undefined {
  return getCurrentInstance() ? inject(scopeKey, undefined) : undefined;
}

/** Call synchronously in setup; descendants inherit the runtime, not its ownership. */
export function useViewModelScope(options: ViewModelVueScopeOptions = {}): ViewModelVueScope {
  const effectScope = activeScope();
  if (localScopes.has(effectScope))
    throw new Error('A Vue effect scope already has a ViewModel scope.');
  const parent = inheritedScope();
  const supplied = options.runtime ?? (options.isolated ? undefined : parent?.runtime);
  const runtime = supplied ?? new ViewModelRuntime();
  const binding = runtime.createBinding();
  let disposed = false;
  const scope: ViewModelVueScope = {
    runtime,
    binding,
    ownsRuntime: supplied === undefined,
    get isDisposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        binding.dispose();
      } finally {
        if (scope.ownsRuntime) runtime.dispose();
      }
    },
  };
  localScopes.set(effectScope, scope);
  onScopeDispose(() => scope.dispose());
  if (getCurrentInstance()) provide(scopeKey, scope);
  return scope;
}

function resolveScope(explicit?: ViewModelVueScope): ViewModelVueScope {
  const effectScope = activeScope();
  // Each consuming component owns a Binding, even when it inherits a runtime.
  const scope = explicit ?? localScopes.get(effectScope) ?? useViewModelScope();
  if (scope.isDisposed) throw new Error('The ViewModel Vue scope has been disposed.');
  return scope;
}

export function useViewModelRuntime(): ViewModelRuntime {
  return resolveScope().runtime;
}
export function useViewModelBinding(): ViewModelBinding {
  return resolveScope().binding;
}

function useSelection<T extends ViewModel, S>(
  spec: ViewModelSpec<T>,
  mode: ViewModelMode,
  select: (vm: T) => S,
  equals: (previous: S, next: S) => boolean,
  explicit?: ViewModelVueScope,
): Readonly<ShallowRef<S>> {
  const scope = resolveScope(explicit);
  const binding = scope.binding;
  let vm = binding.read(spec);
  const value = shallowRef(select(vm)) as ShallowRef<S>;
  let stopped = false;
  let unsubscribe = () => {};
  const update = () => {
    if (stopped || scope.isDisposed || scope.runtime.isDisposed) return;
    const nextVm = binding.read(spec);
    if (vm !== nextVm) {
      unsubscribe();
      vm = nextVm;
      unsubscribe = binding.subscribe(spec, mode, update);
    }
    const next = select(vm);
    if (!equals(value.value, next)) {
      if (Object.is(value.value, next)) triggerRef(value);
      else value.value = next;
    }
  };
  unsubscribe = binding.subscribe(spec, mode, update);
  onScopeDispose(() => {
    stopped = true;
    unsubscribe();
  });
  // Keep class instances raw while preventing replacement of the public ref.
  return shallowReadonly(value);
}

export function useViewModel<T extends ViewModel>(
  spec: ViewModelSpec<T>,
  scope?: ViewModelVueScope,
): Readonly<ShallowRef<T>> {
  return useSelection(
    spec,
    'watch',
    (vm) => vm,
    () => false,
    scope,
  );
}

export function useReadViewModel<T extends ViewModel>(
  spec: ViewModelSpec<T>,
  scope?: ViewModelVueScope,
): Readonly<ShallowRef<T>> {
  return useSelection(spec, 'read', (vm) => vm, Object.is, scope);
}

export function useViewModelSelector<T extends ViewModel, S>(
  spec: ViewModelSpec<T>,
  selector: (vm: T) => S,
  equals: (previous: S, next: S) => boolean = Object.is,
  scope?: ViewModelVueScope,
): Readonly<ShallowRef<S>> {
  return useSelection(spec, 'watch', selector, equals, scope);
}
