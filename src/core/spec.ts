import { ViewModelRuntime } from './runtime.js';
import {
  installViewModelOverride,
  resolveViewModelOverride,
  setViewModelProxy,
  type ViewModelOverrideContext,
} from './overrides.js';
import { ViewModelSpecError } from './errors.js';
import type {
  ViewModelBuilder,
  ViewModelDispose,
  ViewModelKey,
  ViewModelSpecOptions,
  ViewModelType,
} from './types.js';
import type { ViewModel } from './view-model.js';

const VIEW_MODEL_SPEC_BRAND = Symbol.for('view_model.ViewModelSpec.v1');
const VIEW_MODEL_TYPE_TOKENS = Symbol.for('view_model.ViewModelTypeTokens.v1');

function createViewModelTypeTokenRegistry(): WeakMap<object, symbol> {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[VIEW_MODEL_TYPE_TOKENS];
  if (existing instanceof WeakMap) {
    return existing as WeakMap<object, symbol>;
  }

  const registry = new WeakMap<object, symbol>();
  try {
    Object.defineProperty(globalRecord, VIEW_MODEL_TYPE_TOKENS, {
      configurable: false,
      enumerable: false,
      value: registry,
      writable: false,
    });
  } catch {
    // A frozen global object can still use this module-local registry.
  }
  return registry;
}

const viewModelTypeTokens = createViewModelTypeTokenRegistry();

/** @internal */
export function getViewModelTypeToken<T extends ViewModel>(type: ViewModelType<T>): symbol {
  const identity = type as unknown as object;
  const existing = viewModelTypeTokens.get(identity);
  if (existing !== undefined) return existing;

  const name = (type as unknown as { readonly name?: string }).name;
  const token = Symbol(name ?? 'ViewModel');
  viewModelTypeTokens.set(identity, token);
  return token;
}

/** @internal */
export function isViewModelSpec(value: unknown): value is ViewModelSpec<ViewModel> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }

  return (value as Record<PropertyKey, unknown>)[VIEW_MODEL_SPEC_BRAND] === true;
}

export class ViewModelSpec<T extends ViewModel> {
  /** Shared per explicit class; builder-only compatibility Specs receive a private token. */
  public readonly token: symbol;
  /** Explicit class identity, when supplied; legacy builder-only Specs leave this undefined. */
  public readonly type: ViewModelType<T> | undefined;
  public readonly builder: ViewModelBuilder<T>;
  public readonly key: ViewModelKey | undefined;
  public readonly tag: unknown;
  public readonly aliveForever: boolean;
  public readonly debugLabel: string;
  public readonly debugSource: unknown;
  /** @internal */
  public _familyResolution:
    ((context?: ViewModelOverrideContext, inheritGlobal?: boolean) => ViewModelSpec<T>) | undefined;

  public constructor(builder: ViewModelBuilder<T>, options?: ViewModelSpecOptions);
  public constructor(
    type: ViewModelType<T>,
    builder: ViewModelBuilder<T>,
    options?: ViewModelSpecOptions,
  );
  /** @internal */
  public constructor(
    builder: ViewModelBuilder<T>,
    options: ViewModelSpecOptions,
    token: symbol,
    type?: ViewModelType<T>,
  );
  public constructor(
    typeOrBuilder: ViewModelType<T> | ViewModelBuilder<T>,
    builderOrOptions: ViewModelBuilder<T> | ViewModelSpecOptions = {},
    optionsOrToken?: ViewModelSpecOptions | symbol,
    internalType?: ViewModelType<T>,
  ) {
    const explicitType = typeof builderOrOptions === 'function';
    const type = explicitType ? (typeOrBuilder as ViewModelType<T>) : internalType;
    const builder = explicitType
      ? (builderOrOptions as ViewModelBuilder<T>)
      : (typeOrBuilder as ViewModelBuilder<T>);
    const options = explicitType
      ? ((optionsOrToken as ViewModelSpecOptions | undefined) ?? {})
      : (builderOrOptions as ViewModelSpecOptions);
    const typeName = (type as unknown as { readonly name?: string } | undefined)?.name;
    const token =
      typeof optionsOrToken === 'symbol'
        ? optionsOrToken
        : type === undefined
          ? Symbol(options.debugLabel ?? builder.name ?? 'ViewModel')
          : getViewModelTypeToken(type);

    if (options.aliveForever === true && options.key === undefined) {
      throw new ViewModelSpecError('aliveForever ViewModel 必须提供显式 key。');
    }

    if (options.key === null)
      throw new ViewModelSpecError('Use undefined, not null, for an unkeyed Spec.');
    this.type = type;
    this.builder = builder;
    this.token = token;
    this.key = options.key;
    this.tag = options.tag;
    this.debugSource = options.debugSource ?? this;
    this.aliveForever = options.aliveForever ?? false;
    this.debugLabel = options.debugLabel ?? typeName ?? builder.name ?? 'ViewModel';
    Object.defineProperty(this, VIEW_MODEL_SPEC_BRAND, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
  }

  /** Manual realm-wide override; restore in finally. Prefer runWithOverride for async work. */
  public overrideWith(replacement: ViewModelSpec<T>): ViewModelDispose {
    return installViewModelOverride(this, replacement);
  }
  /** Async-safe explicit Runtime scope. Resolve through the supplied Runtime, not an ambient singleton. */
  public runWithOverride<R>(
    replacement: ViewModelSpec<T>,
    body: (runtime: ViewModelRuntime) => R | PromiseLike<R>,
  ): Promise<R> {
    return ViewModelRuntime.runWithOverrides([[this, replacement]], body);
  }
  /** @deprecated Use overrideWith and its restore callback. */
  public setProxy(replacement: ViewModelSpec<T>): void {
    setViewModelProxy(this, replacement);
  }
  /** @deprecated Use the overrideWith restore callback. */
  public clearProxy(): void {
    setViewModelProxy(this);
  }

  public static arg<T extends ViewModel, A>(
    type: ViewModelType<T>,
    builder: (a: A) => T,
    options?: ViewModelArgsOptions<[A]>,
  ): ViewModelSpecFamily<T, [A]> {
    return createViewModelSpecFamily(type, builder, options);
  }
  public static arg2<T extends ViewModel, A, B>(
    type: ViewModelType<T>,
    builder: (a: A, b: B) => T,
    options?: ViewModelArgsOptions<[A, B]>,
  ): ViewModelSpecFamily<T, [A, B]> {
    return createViewModelSpecFamily(type, builder, options);
  }
  public static arg3<T extends ViewModel, A, B, C>(
    type: ViewModelType<T>,
    builder: (a: A, b: B, c: C) => T,
    options?: ViewModelArgsOptions<[A, B, C]>,
  ): ViewModelSpecFamily<T, [A, B, C]> {
    return createViewModelSpecFamily(type, builder, options);
  }
  public static arg4<T extends ViewModel, A, B, C, D>(
    type: ViewModelType<T>,
    builder: (a: A, b: B, c: C, d: D) => T,
    options?: ViewModelArgsOptions<[A, B, C, D]>,
  ): ViewModelSpecFamily<T, [A, B, C, D]> {
    return createViewModelSpecFamily(type, builder, options);
  }

  public withKey(key: ViewModelKey): ViewModelSpec<T> {
    return new ViewModelSpec(
      this.builder,
      {
        key,
        tag: this.tag,
        aliveForever: this.aliveForever,
        debugLabel: this.debugLabel,
        debugSource: this.debugSource,
      },
      this.token,
      this.type,
    );
  }
}

export function viewModelSpec<T extends ViewModel>(
  builder: ViewModelBuilder<T>,
  options?: ViewModelSpecOptions,
): ViewModelSpec<T>;
export function viewModelSpec<T extends ViewModel>(
  type: ViewModelType<T>,
  builder: ViewModelBuilder<T>,
  options?: ViewModelSpecOptions,
): ViewModelSpec<T>;
export function viewModelSpec<T extends ViewModel>(
  typeOrBuilder: ViewModelType<T> | ViewModelBuilder<T>,
  builderOrOptions?: ViewModelBuilder<T> | ViewModelSpecOptions,
  options?: ViewModelSpecOptions,
): ViewModelSpec<T> {
  if (typeof builderOrOptions === 'function') {
    return new ViewModelSpec(typeOrBuilder as ViewModelType<T>, builderOrOptions, options);
  }

  return new ViewModelSpec(typeOrBuilder as ViewModelBuilder<T>, builderOrOptions);
}

/** Arguments configure construction; only explicit type and computed key define identity. */
export interface ViewModelArgsOptions<TArgs extends unknown[]> {
  readonly key?: (...args: TArgs) => ViewModelKey | undefined;
  readonly tag?: (...args: TArgs) => unknown;
  readonly aliveForever?: (...args: TArgs) => boolean;
  readonly debugLabel?: string;
}
export interface ViewModelSpecFamily<T extends ViewModel, TArgs extends unknown[]> {
  (...args: TArgs): ViewModelSpec<T>;
  overrideWith(replacement: ViewModelSpecFamily<T, TArgs>): ViewModelDispose;
  runWithOverride<R>(
    replacement: ViewModelSpecFamily<T, TArgs>,
    body: (runtime: ViewModelRuntime) => R | PromiseLike<R>,
  ): Promise<R>;
  /** @internal */
  _buildSpec(...args: TArgs): ViewModelSpec<T>;
}
function createViewModelSpecFamily<T extends ViewModel, TArgs extends unknown[]>(
  type: ViewModelType<T>,
  builder: (...args: TArgs) => T,
  options: ViewModelArgsOptions<TArgs> = {},
): ViewModelSpecFamily<T, TArgs> {
  const build = (...args: TArgs): ViewModelSpec<T> =>
    new ViewModelSpec(type, () => builder(...args), {
      ...(options.key === undefined ? {} : { key: options.key(...args) }),
      ...(options.tag === undefined ? {} : { tag: options.tag(...args) }),
      ...(options.aliveForever === undefined
        ? {}
        : { aliveForever: options.aliveForever(...args) }),
      ...(options.debugLabel === undefined ? {} : { debugLabel: options.debugLabel }),
      debugSource: family,
    });
  const family: ViewModelSpecFamily<T, TArgs> = Object.assign(
    (...args: TArgs): ViewModelSpec<T> => {
      const spec = build(...args);
      spec._familyResolution = (context, inheritGlobal = true) => {
        const selected = resolveViewModelOverride(family, context, inheritGlobal);
        if (selected === family) return spec;
        if (typeof selected._buildSpec !== 'function')
          throw new ViewModelSpecError(
            'Argument families must be overridden with another argument family.',
          );
        return selected._buildSpec(...args);
      };
      return spec;
    },
    {
      _buildSpec: build,
      overrideWith: (replacement: ViewModelSpecFamily<T, TArgs>) =>
        installViewModelOverride(family, replacement),
      runWithOverride: <R>(
        replacement: ViewModelSpecFamily<T, TArgs>,
        body: (runtime: ViewModelRuntime) => R | PromiseLike<R>,
      ) => ViewModelRuntime.runWithOverrides([[family, replacement]], body),
    },
  );
  return family;
}

/** Resolve configuration without changing the declared type identity. @internal */
export function resolveViewModelSpec<T extends ViewModel>(
  spec: ViewModelSpec<T>,
  context?: ViewModelOverrideContext,
  inheritGlobal = true,
): ViewModelSpec<T> {
  const selected = resolveViewModelOverride(spec, context, inheritGlobal);
  if (!isViewModelSpec(selected))
    throw new ViewModelSpecError('A Spec must be overridden with another Spec.');
  const effective = selected._familyResolution?.(context, inheritGlobal) ?? selected;
  if (effective === spec) return spec;
  return new ViewModelSpec(
    effective.builder,
    {
      ...(effective.key === undefined ? {} : { key: effective.key }),
      tag: effective.tag,
      aliveForever: effective.aliveForever,
      debugLabel: spec.debugLabel,
      debugSource: spec.debugSource,
    },
    spec.token,
    spec.type,
  );
}
