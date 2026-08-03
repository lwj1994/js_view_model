export class ViewModelError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ViewModelDisposedError extends ViewModelError {}

export class ViewModelRuntimeDisposedError extends ViewModelDisposedError {}

export class ViewModelBindingDisposedError extends ViewModelDisposedError {}

export class ViewModelSpecError extends ViewModelError {}

export class ViewModelDependencyCycleError extends ViewModelError {
  public readonly path: readonly string[];

  public constructor(path: readonly string[]) {
    super(`检测到 ViewModel 依赖环：${path.join(' -> ')}`);
    this.path = path;
  }
}

export class UnmanagedViewModelError extends ViewModelError {}
