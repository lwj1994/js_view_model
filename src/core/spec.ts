import { ViewModelSpecError } from './errors.js';
import type {
  ViewModelBuilder,
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

    this.type = type;
    this.builder = builder;
    this.token = token;
    this.key = options.key;
    this.tag = options.tag;
    this.aliveForever = options.aliveForever ?? false;
    this.debugLabel = options.debugLabel ?? typeName ?? builder.name ?? 'ViewModel';
    Object.defineProperty(this, VIEW_MODEL_SPEC_BRAND, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
  }

  public withKey(key: ViewModelKey): ViewModelSpec<T> {
    return new ViewModelSpec(
      this.builder,
      {
        key,
        tag: this.tag,
        aliveForever: this.aliveForever,
        debugLabel: this.debugLabel,
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
