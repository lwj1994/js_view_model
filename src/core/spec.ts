import { ViewModelSpecError } from './errors.js';
import type { ViewModelBuilder, ViewModelKey, ViewModelSpecOptions } from './types.js';
import type { ViewModel } from './view-model.js';

const VIEW_MODEL_SPEC_BRAND = Symbol.for('view_model.ViewModelSpec.v1');

/** @internal */
export function isViewModelSpec(value: unknown): value is ViewModelSpec<ViewModel> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }

  return (value as Record<PropertyKey, unknown>)[VIEW_MODEL_SPEC_BRAND] === true;
}

export class ViewModelSpec<T extends ViewModel> {
  /** 同一个 token 与 key 共同构成跨 binding 的缓存身份。 */
  public readonly token: symbol;
  public readonly builder: ViewModelBuilder<T>;
  public readonly key: ViewModelKey | undefined;
  public readonly aliveForever: boolean;
  public readonly debugLabel: string;

  public constructor(builder: ViewModelBuilder<T>, options?: ViewModelSpecOptions);
  /** @internal */
  public constructor(builder: ViewModelBuilder<T>, options: ViewModelSpecOptions, token: symbol);
  public constructor(
    builder: ViewModelBuilder<T>,
    options: ViewModelSpecOptions = {},
    token: symbol = Symbol(options.debugLabel ?? builder.name ?? 'ViewModel'),
  ) {
    if (options.aliveForever === true && options.key === undefined) {
      throw new ViewModelSpecError('aliveForever ViewModel 必须提供显式 key。');
    }

    this.builder = builder;
    this.token = token;
    this.key = options.key;
    this.aliveForever = options.aliveForever ?? false;
    this.debugLabel = options.debugLabel ?? builder.name ?? 'ViewModel';
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
        aliveForever: this.aliveForever,
        debugLabel: this.debugLabel,
      },
      this.token,
    );
  }
}

export function viewModelSpec<T extends ViewModel>(
  builder: ViewModelBuilder<T>,
  options?: ViewModelSpecOptions,
): ViewModelSpec<T> {
  return new ViewModelSpec(builder, options);
}
