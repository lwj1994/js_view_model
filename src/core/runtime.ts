import {
  ViewModelBindingDisposedError,
  ViewModelDependencyCycleError,
  ViewModelRuntimeDisposedError,
  ViewModelSpecError,
} from './errors.js';
import { isViewModelSpec, ViewModelSpec } from './spec.js';
import type {
  ViewModelBindingOptions,
  ViewModelChange,
  ViewModelDispose,
  ViewModelKey,
  ViewModelListener,
  ViewModelMode,
} from './types.js';
import { isViewModel, VIEW_MODEL_INTERNAL, ViewModel } from './view-model.js';

const DEFAULT_PAUSE_TOKEN = Symbol('view_model.default_pause');

let nextBindingId = 0;
let activeBuilderDepth = 0;

interface SubscriptionRecord {
  readonly mode: ViewModelMode;
  readonly notify: ViewModelListener;
  active: boolean;
}

interface BindingEntry {
  readonly handle: InstanceHandle;
  readonly subscriptions: Set<SubscriptionRecord>;
  bubble: boolean;
  imperativeWatch: boolean;
}

interface PendingDisposal {
  cancelled: boolean;
}

interface InstanceHandle<T extends ViewModel = ViewModel> {
  readonly spec: ViewModelSpec<T>;
  readonly viewModel: T;
  readonly generation: number;
  readonly owners: Set<ViewModelBinding>;
  readonly dependencyBinding: ViewModelBinding;
  readonly unkeyedBinding: ViewModelBinding | undefined;
  version: number;
  lifecycleVersion: number;
  activated: boolean;
  disposed: boolean;
  pendingDisposal: PendingDisposal | undefined;
}

function describeHandle(handle: InstanceHandle): string {
  return `${handle.spec.debugLabel}#${handle.generation}`;
}

/**
 * A runtime is the outermost boundary for keyed instance sharing, the
 * dependency graph, and platform pause state.
 */
export class ViewModelRuntime {
  readonly #handles = new Set<InstanceHandle>();
  readonly #keyed = new Map<symbol, Map<ViewModelKey, InstanceHandle>>();
  readonly #byViewModel = new WeakMap<ViewModel, InstanceHandle>();
  readonly #edges = new Map<InstanceHandle, Set<InstanceHandle>>();
  readonly #pauseTokens = new Set<unknown>();
  readonly #pausedCallbacks = new Set<ViewModelListener>();
  #generation = 0;
  #disposed = false;
  #dispatching = false;
  #notificationQueue: InstanceHandle[] = [];
  #queuedHandles = new Set<InstanceHandle>();
  #transactionCallbacks = new Set<ViewModelListener>();
  #bubbledParents = new Set<InstanceHandle>();

  public get isDisposed(): boolean {
    return this.#disposed;
  }

  public get isPaused(): boolean {
    return this.#pauseTokens.size > 0;
  }

  public createBinding(options: ViewModelBindingOptions = {}): ViewModelBinding {
    this.#assertAlive();
    return new ViewModelBinding(this, options);
  }

  /** Aggregate app/window lifecycle sources and resume only after the last token is cleared. */
  public pause(token: unknown = DEFAULT_PAUSE_TOKEN): void {
    this.#assertAlive();
    const wasPaused = this.isPaused;
    this.#pauseTokens.add(token);
    if (wasPaused || !this.isPaused) return;

    const errors: unknown[] = [];
    for (const handle of this.#handles) {
      if (handle.activated && !handle.disposed) {
        try {
          handle.viewModel[VIEW_MODEL_INTERNAL].pause();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'ViewModel 暂停时发生错误。');
  }

  public resume(token: unknown = DEFAULT_PAUSE_TOKEN): void {
    if (this.#disposed || !this.#pauseTokens.delete(token) || this.isPaused) return;

    const errors: unknown[] = [];
    for (const handle of this.#handles) {
      if (handle.activated && !handle.disposed) {
        try {
          handle.viewModel[VIEW_MODEL_INTERNAL].resume();
        } catch (error) {
          errors.push(error);
        }
      }
    }

    const callbacks = [...this.#pausedCallbacks];
    this.#pausedCallbacks.clear();
    for (const callback of callbacks) {
      try {
        callback();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'ViewModel 恢复时发生错误。');
  }

  /**
   * Force-dispose the target generation. A Spec recycles every matching
   * identity in this runtime; an unkeyed Spec can match one per Binding.
   */
  public recycle(target: ViewModel | ViewModelSpec<ViewModel>): number {
    this.#assertAlive();
    const handles = isViewModelSpec(target)
      ? [...this.#handles].filter(
          (handle) => handle.spec.token === target.token && handle.spec.key === target.key,
        )
      : [this.#byViewModel.get(target)].filter(
          (handle): handle is InstanceHandle => handle !== undefined,
        );

    let recycled = 0;
    const errors: unknown[] = [];
    for (const handle of handles) {
      if (!handle.disposed) {
        try {
          this.#disposeHandle(handle);
        } catch (error) {
          errors.push(error);
        } finally {
          if (handle.disposed) recycled += 1;
        }
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'ViewModel recycle 时发生错误。');
    return recycled;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pauseTokens.clear();
    this.#pausedCallbacks.clear();

    const errors: unknown[] = [];
    for (const handle of [...this.#handles]) {
      try {
        this.#disposeHandle(handle);
      } catch (error) {
        errors.push(error);
      }
    }

    this.#keyed.clear();
    this.#edges.clear();
    if (errors.length > 0) {
      throw new AggregateError(errors, 'ViewModelRuntime 销毁时发生错误。');
    }
  }

  /** @internal */
  public _prepare<T extends ViewModel>(
    binding: ViewModelBinding,
    spec: ViewModelSpec<T>,
  ): InstanceHandle<T> {
    this.#assertAlive();

    if (activeBuilderDepth > 0) {
      throw new ViewModelSpecError(
        'ViewModel builder 必须保持纯净；请在 ViewModel attach 后通过 viewModelBinding getter 解析依赖。',
      );
    }

    if (
      spec.key === undefined &&
      binding._parentHandle !== undefined &&
      this.#ancestorUsesToken(binding._parentHandle, spec.token)
    ) {
      throw new ViewModelDependencyCycleError([
        describeHandle(binding._parentHandle),
        spec.debugLabel,
        describeHandle(binding._parentHandle),
      ]);
    }

    const cached =
      spec.key === undefined
        ? binding._getUnkeyed(spec.token)
        : this.#keyed.get(spec.token)?.get(spec.key);
    if (cached !== undefined && !cached.disposed) {
      return cached as InstanceHandle<T>;
    }

    activeBuilderDepth += 1;
    let viewModel: T;
    try {
      viewModel = spec.builder();
    } finally {
      activeBuilderDepth -= 1;
    }
    if (!isViewModel(viewModel)) {
      throw new ViewModelSpecError(`${spec.debugLabel} 的 builder 必须返回 ViewModel 实例。`);
    }

    const generation = ++this.#generation;
    // Create the dependency binding before attach. Application code cannot
    // access it until the builder has returned and attach has completed.
    const handle = {
      spec,
      viewModel,
      generation,
      owners: new Set<ViewModelBinding>(),
      dependencyBinding: undefined as unknown as ViewModelBinding,
      unkeyedBinding: spec.key === undefined ? binding : undefined,
      version: viewModel.version,
      lifecycleVersion: 0,
      activated: false,
      disposed: false,
      pendingDisposal: undefined,
    } satisfies InstanceHandle<T>;
    const dependencyBinding = new ViewModelBinding(
      this,
      {
        id: `view-model:${spec.debugLabel}:${generation}`,
      },
      handle,
    );
    (handle as { dependencyBinding: ViewModelBinding }).dependencyBinding = dependencyBinding;

    viewModel[VIEW_MODEL_INTERNAL].attach(dependencyBinding, (change) => {
      this.#notifyHandle(handle, change);
    });

    this.#handles.add(handle);
    this.#byViewModel.set(viewModel, handle);
    if (spec.key === undefined) {
      binding._setUnkeyed(spec.token, handle);
    } else {
      const entries = this.#keyed.get(spec.token) ?? new Map<ViewModelKey, InstanceHandle>();
      entries.set(spec.key, handle);
      this.#keyed.set(spec.token, entries);
    }

    // Suspense or concurrent scheduling can abandon a React render. Clean up
    // provisional generations that are not acquired by the current commit so
    // a long-lived Runtime cannot retain them forever. A later commit prepares
    // again and the changed snapshot triggers a synchronous rerender.
    this.#scheduleDisposal(handle, true);

    return handle;
  }

  /** @internal */
  public _acquire(binding: ViewModelBinding, handle: InstanceHandle): void {
    this.#assertAlive();
    if (handle.disposed) {
      throw new ViewModelSpecError('不能 acquire 已销毁的 ViewModel generation。');
    }
    if (handle.owners.has(binding)) return;

    const parent = binding._parentHandle;
    if (parent !== undefined) this.#link(parent, handle);

    const pending = handle.pendingDisposal;
    if (pending !== undefined) {
      pending.cancelled = true;
      handle.pendingDisposal = undefined;
    }

    handle.owners.add(binding);
    try {
      if (!handle.activated) {
        handle.viewModel[VIEW_MODEL_INTERNAL].activate();
        handle.activated = true;
        if (this.isPaused) handle.viewModel[VIEW_MODEL_INTERNAL].pause();
      }
      handle.viewModel[VIEW_MODEL_INTERNAL].bind(binding.id);
    } catch (error) {
      handle.owners.delete(binding);
      if (parent !== undefined) this.#unlink(parent, handle);
      this.#disposeHandle(handle);
      throw error;
    }
  }

  /** @internal */
  public _release(binding: ViewModelBinding, handle: InstanceHandle): void {
    if (handle.disposed || !handle.owners.delete(binding)) return;
    let unbindError: unknown;
    try {
      handle.viewModel[VIEW_MODEL_INTERNAL].unbind(binding.id);
    } catch (error) {
      unbindError = error;
    }
    const parent = binding._parentHandle;
    if (parent !== undefined) this.#unlink(parent, handle);

    if (handle.owners.size === 0 && !handle.spec.aliveForever) this.#scheduleDisposal(handle);

    if (unbindError !== undefined) throw unbindError;
  }

  /** @internal */
  public _queueCallback(callback: ViewModelListener): void {
    if (this.#disposed) return;
    if (this.#dispatching) {
      this.#transactionCallbacks.add(callback);
      return;
    }
    this.#deliver(callback);
  }

  /** @internal */
  public _bubbleDependency(parent: InstanceHandle, child: InstanceHandle): void {
    if (this.#disposed || parent.disposed || this.#bubbledParents.has(parent)) return;
    this.#bubbledParents.add(parent);
    parent.viewModel[VIEW_MODEL_INTERNAL].dependencyNotify(child.viewModel);
  }

  #notifyHandle(handle: InstanceHandle, change: ViewModelChange): void {
    if (handle.disposed) return;
    handle.version = change.version;

    if (!this.#queuedHandles.has(handle)) {
      this.#queuedHandles.add(handle);
      this.#notificationQueue.push(handle);
    }
    if (this.#dispatching) return;

    const errors: unknown[] = [];
    this.#dispatching = true;
    try {
      while (this.#notificationQueue.length > 0) {
        const current = this.#notificationQueue.shift();
        if (current === undefined || current.disposed) continue;
        this.#queuedHandles.delete(current);
        for (const owner of current.owners) {
          try {
            owner._collectNotification(current);
          } catch (error) {
            errors.push(error);
          }
        }
      }
    } finally {
      this.#dispatching = false;
      this.#notificationQueue = [];
      this.#queuedHandles.clear();
      this.#bubbledParents.clear();
      const callbacks = [...this.#transactionCallbacks];
      this.#transactionCallbacks.clear();
      for (const callback of callbacks) {
        try {
          this.#deliver(callback);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'ViewModel 通知时发生错误。');
  }

  #deliver(callback: ViewModelListener): void {
    if (this.isPaused) {
      this.#pausedCallbacks.add(callback);
    } else {
      callback();
    }
  }

  #link(parent: InstanceHandle, child: InstanceHandle): void {
    if (parent === child || this.#hasPath(child, parent)) {
      throw new ViewModelDependencyCycleError([
        describeHandle(parent),
        describeHandle(child),
        describeHandle(parent),
      ]);
    }
    const children = this.#edges.get(parent) ?? new Set<InstanceHandle>();
    children.add(child);
    this.#edges.set(parent, children);
  }

  #unlink(parent: InstanceHandle, child: InstanceHandle): void {
    const children = this.#edges.get(parent);
    children?.delete(child);
    if (children?.size === 0) this.#edges.delete(parent);
  }

  #hasPath(start: InstanceHandle, target: InstanceHandle): boolean {
    const visited = new Set<InstanceHandle>();
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || !visited.add(current)) continue;
      if (current === target) return true;
      pending.push(...(this.#edges.get(current) ?? []));
    }
    return false;
  }

  #ancestorUsesToken(start: InstanceHandle, token: symbol): boolean {
    const visited = new Set<InstanceHandle>();
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || !visited.add(current)) continue;
      if (current.spec.token === token) return true;
      for (const [parent, children] of this.#edges) {
        if (children.has(current)) pending.push(parent);
      }
    }
    return false;
  }

  #scheduleDisposal(handle: InstanceHandle, provisional = false): void {
    const current = handle.pendingDisposal;
    if (current !== undefined) current.cancelled = true;

    const pending: PendingDisposal = { cancelled: false };
    handle.pendingDisposal = pending;
    queueMicrotask(() => {
      if (
        pending.cancelled ||
        handle.pendingDisposal !== pending ||
        handle.owners.size > 0 ||
        handle.disposed ||
        (!provisional && handle.spec.aliveForever)
      ) {
        return;
      }
      this.#disposeHandle(handle);
    });
  }

  #disposeHandle(handle: InstanceHandle): void {
    if (handle.disposed) return;
    handle.disposed = true;
    handle.lifecycleVersion += 1;
    if (handle.pendingDisposal !== undefined) {
      handle.pendingDisposal.cancelled = true;
      handle.pendingDisposal = undefined;
    }

    this.#handles.delete(handle);
    this.#byViewModel.delete(handle.viewModel);
    if (handle.spec.key === undefined) {
      handle.unkeyedBinding?._deleteUnkeyed(handle.spec.token, handle);
    } else {
      const entries = this.#keyed.get(handle.spec.token);
      if (entries?.get(handle.spec.key) === handle) entries.delete(handle.spec.key);
      if (entries?.size === 0) this.#keyed.delete(handle.spec.token);
    }

    const errors: unknown[] = [];
    const owners = [...handle.owners];
    handle.owners.clear();
    for (const owner of owners) {
      try {
        handle.viewModel[VIEW_MODEL_INTERNAL].unbind(owner.id);
      } catch (error) {
        errors.push(error);
      }
    }

    // Finish the old generation and its exclusively owned dependency tree
    // before notifying owners to resolve again. This prevents a new onCreate
    // from overlapping the old onDispose on IPC, ports, or native subscriptions.
    try {
      handle.viewModel[VIEW_MODEL_INTERNAL].dispose();
    } catch (error) {
      errors.push(error);
    }

    const children = [...(this.#edges.get(handle) ?? [])];
    try {
      handle.dependencyBinding.dispose();
    } catch (error) {
      errors.push(error);
    }
    for (const child of children) {
      if (!child.disposed && child.owners.size === 0 && !child.spec.aliveForever) {
        try {
          this.#disposeHandle(child);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    this.#edges.delete(handle);
    for (const [parent, children] of this.#edges) {
      children.delete(handle);
      if (children.size === 0) this.#edges.delete(parent);
    }

    for (const owner of owners) {
      try {
        owner._handleDisposed(handle);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `${describeHandle(handle)} 销毁时发生错误。`);
    }
  }

  #assertAlive(): void {
    if (this.#disposed) {
      throw new ViewModelRuntimeDisposedError('ViewModelRuntime 已销毁。');
    }
  }
}

/** A Scope, screen, or plain host owns one stable Binding. */
export class ViewModelBinding {
  public readonly id: string;
  public readonly runtime: ViewModelRuntime;
  /** @internal */
  public readonly _parentHandle: InstanceHandle | undefined;
  readonly #onUpdate: ViewModelListener | undefined;
  readonly #unkeyed = new Map<symbol, InstanceHandle>();
  readonly #entries = new Map<InstanceHandle, BindingEntry>();
  #disposed = false;

  public constructor(runtime: ViewModelRuntime, options?: ViewModelBindingOptions);
  /** @internal */
  public constructor(
    runtime: ViewModelRuntime,
    options: ViewModelBindingOptions,
    parentHandle: InstanceHandle,
  );
  public constructor(
    runtime: ViewModelRuntime,
    options: ViewModelBindingOptions = {},
    parentHandle?: InstanceHandle,
  ) {
    this.runtime = runtime;
    this.id = options.id ?? `binding:${++nextBindingId}`;
    this.#onUpdate = options.onUpdate;
    this._parentHandle = parentHandle;
  }

  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /** Render-safe: may construct pure objects, but does not acquire, call onCreate, or call onBind. */
  /** @internal */
  public prepare<T extends ViewModel>(spec: ViewModelSpec<T>): T {
    this.#assertAlive();
    return this.runtime._prepare(this, spec).viewModel;
  }

  public read<T extends ViewModel>(spec: ViewModelSpec<T>): T {
    this.#assertAlive();
    const handle = this.runtime._prepare(this, spec);
    this.#ensureEntry(handle, false);
    return handle.viewModel;
  }

  public watch<T extends ViewModel>(spec: ViewModelSpec<T>, listener?: ViewModelListener): T {
    this.#assertAlive();
    const handle = this.runtime._prepare(this, spec);
    const entry = this.#ensureEntry(handle, true);
    entry.imperativeWatch = true;
    if (listener !== undefined) {
      entry.subscriptions.add({ mode: 'watch', notify: listener, active: true });
    }
    return handle.viewModel;
  }

  /** Commit-safe: establishes Binding ownership and registers the current hook subscription. */
  /** @internal */
  public subscribe<T extends ViewModel>(
    spec: ViewModelSpec<T>,
    mode: ViewModelMode,
    listener: ViewModelListener,
  ): ViewModelDispose {
    this.#assertAlive();
    const handle = this.runtime._prepare(this, spec);
    const entry = this.#ensureEntry(handle, mode === 'watch');
    const record: SubscriptionRecord = {
      mode,
      active: true,
      notify: () => {
        if (record.active) listener();
      },
    };
    entry.subscriptions.add(record);

    return () => {
      record.active = false;
      entry.subscriptions.delete(record);
    };
  }

  /** A watch snapshot includes the VM version; a read snapshot changes only with generation/lifecycle. */
  /** @internal */
  public getSnapshot<T extends ViewModel>(spec: ViewModelSpec<T>, mode: ViewModelMode): string {
    this.#assertAlive();
    const handle = this.runtime._prepare(this, spec);
    const version = mode === 'watch' ? handle.version : handle.lifecycleVersion;
    return `${handle.generation}:${version}`;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors: unknown[] = [];
    for (const [handle, entry] of [...this.#entries]) {
      for (const record of entry.subscriptions) record.active = false;
      entry.subscriptions.clear();
      try {
        this.runtime._release(this, handle);
      } catch (error) {
        errors.push(error);
      }
    }
    this.#entries.clear();
    this.#unkeyed.clear();
    if (errors.length > 0) {
      throw new AggregateError(errors, `ViewModelBinding ${this.id} 销毁时发生错误。`);
    }
  }

  /** @internal */
  public _getUnkeyed(token: symbol): InstanceHandle | undefined {
    return this.#unkeyed.get(token);
  }

  /** @internal */
  public _setUnkeyed(token: symbol, handle: InstanceHandle): void {
    this.#unkeyed.set(token, handle);
  }

  /** @internal */
  public _deleteUnkeyed(token: symbol, handle: InstanceHandle): void {
    if (this.#unkeyed.get(token) === handle) this.#unkeyed.delete(token);
  }

  /** @internal */
  public _collectNotification(handle: InstanceHandle): void {
    const entry = this.#entries.get(handle);
    if (entry === undefined) return;

    if (this._parentHandle !== undefined && entry.bubble) {
      this.runtime._bubbleDependency(this._parentHandle, handle);
    }

    if (entry.imperativeWatch && this.#onUpdate !== undefined) {
      this.runtime._queueCallback(this.#onUpdate);
    }
    for (const record of entry.subscriptions) {
      if (record.mode === 'watch' && record.active) {
        this.runtime._queueCallback(record.notify);
      }
    }
  }

  /** @internal */
  public _handleDisposed(handle: InstanceHandle): void {
    const entry = this.#entries.get(handle);
    if (entry === undefined) return;
    this.#entries.delete(handle);
    this._deleteUnkeyed(handle.spec.token, handle);

    if (this._parentHandle !== undefined && !this._parentHandle.disposed) {
      this.runtime._bubbleDependency(this._parentHandle, handle);
    }
    if (this.#onUpdate !== undefined) this.runtime._queueCallback(this.#onUpdate);
    for (const record of entry.subscriptions) {
      if (record.active) this.runtime._queueCallback(record.notify);
    }
  }

  #ensureEntry(handle: InstanceHandle, bubble: boolean): BindingEntry {
    this.#assertAlive();
    const existing = this.#entries.get(handle);
    if (existing !== undefined) {
      existing.bubble ||= bubble;
      return existing;
    }

    this.runtime._acquire(this, handle);
    const entry: BindingEntry = {
      handle,
      subscriptions: new Set(),
      bubble,
      imperativeWatch: false,
    };
    this.#entries.set(handle, entry);
    return entry;
  }

  #assertAlive(): void {
    if (this.#disposed) {
      throw new ViewModelBindingDisposedError(`ViewModelBinding ${this.id} 已销毁。`);
    }
  }
}
