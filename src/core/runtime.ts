import {
  snapshotViewModelOverrides,
  type ViewModelOverride,
  type ViewModelOverrideContext,
} from './overrides.js';
import { scheduleMicrotask } from '../shared/microtask.js';
import {
  ErrorType,
  isViewModelResetting,
  registerViewModelReset,
  reportViewModelError,
  warnViewModel,
  type ViewModelInstanceInfo,
} from './config.js';
import { constructViewModel, isConstructingViewModel } from './construction.js';
import {
  ViewModelBindingDisposedError,
  ViewModelDependencyCycleError,
  ViewModelRuntimeDisposedError,
  ViewModelSpecError,
} from './errors.js';
import {
  getViewModelTypeToken,
  isViewModelSpec,
  resolveViewModelSpec,
  ViewModelSpec,
} from './spec.js';
import type {
  Equality,
  StateChangeListener,
  ViewModelBindingOptions,
  ViewModelCacheLookup,
  ViewModelChange,
  ViewModelDispose,
  ViewModelKey,
  ViewModelListener,
  ViewModelMode,
  ViewModelType,
} from './types.js';
import {
  enqueueViewModelUpdateCallback,
  markViewModelBindingUpdated,
  runInViewModelUpdateTransaction,
} from './update-transaction.js';
import { isViewModel, StateViewModel, VIEW_MODEL_INTERNAL, ViewModel } from './view-model.js';

const DEFAULT_PAUSE_TOKEN = Symbol('view_model.default_pause');
let nextBindingId = 0;

interface SubscriptionRecord {
  readonly mode: ViewModelMode;
  readonly original: ViewModelListener;
  readonly notify: ViewModelListener;
  readonly imperative: boolean;
  active: boolean;
  terminal: boolean;
}

/** Identity of ONE committed owner/edge, not the reusable Binding object. */
interface BindingEntry {
  readonly binding: ViewModelBinding;
  readonly handle: InstanceHandle;
  readonly subscriptions: Set<SubscriptionRecord>;
  active: boolean;
  bubble: boolean;
  imperativeWatch: boolean;
}
interface PendingDisposal {
  cancelled: boolean;
}
export type ViewModelCacheTarget<T extends ViewModel> = ViewModelSpec<T> | ViewModelType<T>;

interface InstanceHandle<T extends ViewModel = ViewModel> {
  readonly spec: ViewModelSpec<T>;
  readonly viewModel: T;
  readonly generation: number;
  readonly owners: Map<ViewModelBinding, BindingEntry>;
  readonly externalOwnerSources: Map<ViewModelBinding, Set<BindingEntry>>;
  readonly dependencyBinding: ViewModelBinding;
  readonly unkeyedBinding: ViewModelBinding | undefined;
  version: number;
  lifecycleVersion: number;
  activated: boolean;
  everAcquired: boolean;
  disposed: boolean;
  pendingDisposal: PendingDisposal | undefined;
}

export interface ViewModelRuntimeOptions {
  readonly overrides?: Iterable<ViewModelOverride>;
  /** False freezes selection to the explicitly provided override context. */
  readonly inheritGlobalOverrides?: boolean;
}

export interface ViewModelRuntimeSnapshot {
  readonly isPaused: boolean;
  readonly instances: readonly (ViewModelInstanceInfo & {
    readonly activated: boolean;
    readonly bindingIds: readonly string[];
    readonly ownerBindingIds: readonly string[];
    readonly externalSources: readonly { bindingId: string; count: number }[];
  })[];
  readonly bindings: readonly {
    id: string;
    parentGeneration: number | undefined;
    generations: readonly number[];
  }[];
  readonly dependencies: readonly {
    parentGeneration: number;
    childGeneration: number;
    bindingId: string;
  }[];
}

function describeHandle(handle: InstanceHandle): string {
  return `${handle.spec.debugLabel}#${handle.generation}`;
}
function sameKey(left: ViewModelKey | undefined, right: ViewModelKey | undefined): boolean {
  return Object.is(left, right) || (left === 0 && right === 0);
}
function isExplicitTypeInstance<T extends ViewModel>(
  type: ViewModelType<T>,
  value: ViewModel,
): value is T {
  if (typeof type !== 'function') return false;
  const prototype: unknown = type.prototype;
  return (
    typeof prototype === 'object' &&
    prototype !== null &&
    Object.prototype.isPrototypeOf.call(prototype, value)
  );
}

/** Identity, dependency ownership, and app/window pause boundary for one JS realm. */
export class ViewModelRuntime {
  readonly #overrides: ViewModelOverrideContext;
  readonly #inheritGlobalOverrides: boolean;
  public constructor(options: ViewModelRuntimeOptions = {}) {
    this.#overrides = new Map(options.overrides);
    this.#inheritGlobalOverrides = options.inheritGlobalOverrides ?? true;
  }
  /** Async-safe isolated Runtime, disposed on success or failure. No mutable context crosses await. */
  public static async runWithOverrides<R>(
    overrides: Iterable<ViewModelOverride>,
    body: (runtime: ViewModelRuntime) => R | PromiseLike<R>,
  ): Promise<R> {
    const context = snapshotViewModelOverrides();
    for (const [source, replacement] of overrides) context.set(source, replacement);
    const runtime = new ViewModelRuntime({ overrides: context, inheritGlobalOverrides: false });
    try {
      return await body(runtime);
    } finally {
      runtime.dispose();
    }
  }
  /** Nested scopes inherit this Runtime's factory selection, but own an isolated instance cache. */
  public async runWithOverrides<R>(
    overrides: Iterable<ViewModelOverride>,
    body: (runtime: ViewModelRuntime) => R | PromiseLike<R>,
  ): Promise<R> {
    this.#assertAlive();
    const context = snapshotViewModelOverrides(this.#overrides, this.#inheritGlobalOverrides);
    for (const [source, replacement] of overrides) context.set(source, replacement);
    const runtime = new ViewModelRuntime({ overrides: context, inheritGlobalOverrides: false });
    try {
      return await body(runtime);
    } finally {
      runtime.dispose();
    }
  }
  /** @internal */
  public _resolveSpec<T extends ViewModel>(spec: ViewModelSpec<T>): ViewModelSpec<T> {
    return resolveViewModelSpec(spec, this.#overrides, this.#inheritGlobalOverrides);
  }
  readonly #handles = new Set<InstanceHandle>();
  readonly #keyed = new Map<symbol, Map<ViewModelKey, InstanceHandle>>();
  readonly #byViewModel = new WeakMap<ViewModel, InstanceHandle>();
  readonly #edges = new Map<InstanceHandle, Map<InstanceHandle, BindingEntry>>();
  readonly #bindings = new Set<ViewModelBinding>();
  readonly #pauseTokens = new Set<unknown>();
  readonly #pausedCallbacks = new Map<ViewModelBinding, Set<ViewModelListener>>();
  readonly #deliveryCallbacks = new WeakMap<
    ViewModelBinding,
    Map<ViewModelListener, ViewModelListener>
  >();
  readonly #warnedTags = new Map<symbol, Set<unknown>>();
  #unregisterReset: ViewModelDispose | undefined;
  #generation = 0;
  #revision = 0;
  #preparing = 0;
  #disposed = false;
  #resetting = false;
  #disposalDepth = 0;
  readonly #disposalNotifications: ViewModelListener[] = [];

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

  public pause(token: unknown = DEFAULT_PAUSE_TOKEN): void {
    this.#assertAlive();
    this.#unregisterReset ??= registerViewModelReset(() => this.reset());
    const wasPaused = this.isPaused;
    this.#pauseTokens.add(token);
    if (wasPaused) return;
    for (const handle of [...this.#handles]) {
      if (handle.activated && !handle.disposed && this.isPaused)
        handle.viewModel[VIEW_MODEL_INTERNAL].pause();
    }
  }

  public resume(token: unknown = DEFAULT_PAUSE_TOKEN): void {
    if (this.#disposed || !this.#pauseTokens.delete(token) || this.isPaused) return;
    runInViewModelUpdateTransaction(() => {
      for (const handle of [...this.#handles]) {
        if (handle.activated && !handle.disposed && !this.isPaused)
          handle.viewModel[VIEW_MODEL_INTERNAL].resume();
      }
      const callbacks = [...this.#pausedCallbacks].flatMap(([owner, entries]) =>
        [...entries].map((callback) => ({ callback, owner })),
      );
      this.#pausedCallbacks.clear();
      for (const { callback, owner } of callbacks) this._queueCallback(owner, callback);
    });
    this.#unregisterWhenEmpty();
  }

  /** Force-dispose a generation for ALL owners, including aliveForever instances. */
  public recycle(target: ViewModel | ViewModelSpec<ViewModel>): number {
    this.#assertAlive();
    if (isViewModelSpec(target)) target = this._resolveSpec(target);
    const resolvedTarget = target;
    const handles = isViewModelSpec(resolvedTarget)
      ? [...this.#handles].filter(
          (handle) =>
            handle.spec.token === resolvedTarget.token &&
            sameKey(handle.spec.key, resolvedTarget.key),
        )
      : [this.#byViewModel.get(resolvedTarget)].filter(
          (handle): handle is InstanceHandle => handle !== undefined,
        );
    return runInViewModelUpdateTransaction(() => {
      let count = 0;
      for (const handle of handles) {
        if (handle.disposed) continue;
        this.#disposeHandle(handle);
        count += 1;
      }
      return count;
    });
  }

  /** Non-owning cache inspection. Prefer Binding read/watch for application dependencies. */
  public maybeReadCached<T extends ViewModel>(
    target: ViewModelCacheTarget<T>,
    lookup: ViewModelCacheLookup = {},
  ): T | undefined {
    return this._findCached(target, lookup)?.viewModel;
  }
  public readCached<T extends ViewModel>(
    target: ViewModelCacheTarget<T>,
    lookup: ViewModelCacheLookup = {},
  ): T {
    const value = this.maybeReadCached(target, lookup);
    if (value === undefined)
      throw new ViewModelSpecError('No cached ViewModel matches the lookup.');
    return value;
  }
  public readCachesByTag<T extends ViewModel>(target: ViewModelCacheTarget<T>, tag: unknown): T[] {
    return this._findCachesByTag(target, tag).map((handle) => handle.viewModel);
  }

  /** Reset instances and pause state without invalidating surviving root Bindings. */
  public reset(): void {
    if (this.#disposed || this.#resetting) return;
    this.#resetting = true;
    this.#revision += 1;
    try {
      this.#disposeAll();
    } finally {
      this.#resetting = false;
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#revision += 1;
    this.#disposeAll();
    for (const binding of [...this.#bindings]) binding.dispose();
    this.#bindings.clear();
    this.#unregisterReset?.();
    this.#unregisterReset = undefined;
  }

  /** Inspect the same generation/Binding/parent-edge model used by the runtime. */
  public getDiagnostics(): ViewModelRuntimeSnapshot {
    const handles = [...this.#handles];
    return {
      isPaused: this.isPaused,
      instances: handles.map((handle) => ({
        ...handle.viewModel.instanceInfo!,
        activated: handle.activated,
        bindingIds: handle.viewModel.bindingIds,
        ownerBindingIds: [...handle.owners.keys()].map((binding) => binding.id),
        externalSources: [...handle.externalOwnerSources].map(([owner, sources]) => ({
          bindingId: owner.id,
          count: sources.size,
        })),
      })),
      bindings: [...this.#bindings]
        .filter((binding) => !binding.isDisposed)
        .map((binding) => ({
          id: binding.id,
          parentGeneration: binding._parentHandle?.generation,
          generations: handles
            .filter((handle) => handle.owners.has(binding))
            .map((handle) => handle.generation),
        })),
      dependencies: [...this.#edges].flatMap(([parent, children]) =>
        [...children].map(([child, edge]) => ({
          parentGeneration: parent.generation,
          childGeneration: child.generation,
          bindingId: edge.binding.id,
        })),
      ),
    };
  }

  public countInstances<T extends ViewModel>(
    target?: ViewModelCacheTarget<T>,
    lookup: ViewModelCacheLookup = {},
  ): number {
    this.#assertAlive();
    const token = target === undefined ? undefined : this.#cacheTargetToken(target);
    if (token === undefined && lookup.tag === undefined && lookup.key === undefined)
      return this.#handles.size;
    let count = 0;
    for (const handle of this.#handles) {
      if (token !== undefined && handle.spec.token !== token) continue;
      if (lookup.key !== undefined && !sameKey(handle.spec.key, lookup.key)) continue;
      if (lookup.tag !== undefined && !Object.is(handle.spec.tag, lookup.tag)) continue;
      count += 1;
    }
    return count;
  }

  /** @internal */
  public _registerBinding(binding: ViewModelBinding): void {
    this.#assertAlive();
    this.#bindings.add(binding);
    this.#unregisterReset ??= registerViewModelReset(() => this.reset());
  }
  /** @internal */
  public _forgetBinding(binding: ViewModelBinding): void {
    this.#bindings.delete(binding);
    this._forgetCallbacks(binding);
    this.#unregisterWhenEmpty();
  }

  /** Pure preparation. Ownership and resources are committed separately. @internal */
  public _prepare<T extends ViewModel>(
    binding: ViewModelBinding,
    spec: ViewModelSpec<T>,
  ): InstanceHandle<T> {
    this.#assertAlive();
    binding._assertAlive();
    if (isConstructingViewModel())
      throw new ViewModelSpecError(
        'ViewModel builders must be pure; resolve dependencies after attachment.',
      );
    if (!isViewModelSpec(spec)) throw new ViewModelSpecError('Expected a ViewModelSpec.');
    spec = this._resolveSpec(spec);
    if (spec.aliveForever && spec.key === undefined)
      throw new ViewModelSpecError('aliveForever ViewModels require an explicit key.');
    const parent = binding._parentHandle;
    if (parent !== undefined && (!parent.activated || parent.disposed)) {
      throw new ViewModelSpecError(
        'Resolve dependencies only from committed ViewModel actions or lifecycle callbacks.',
      );
    }
    const owned = binding._getOwned(spec);
    if (owned !== undefined) {
      binding._noteFactory(spec, owned);
      return owned as InstanceHandle<T>;
    }
    if (
      spec.key === undefined &&
      parent !== undefined &&
      this.#ancestorUsesToken(parent, spec.token)
    ) {
      throw new ViewModelDependencyCycleError([
        describeHandle(parent),
        spec.debugLabel,
        describeHandle(parent),
      ]);
    }
    const cached =
      spec.key === undefined
        ? binding._getUnkeyed(spec.token)
        : this.#keyed.get(spec.token)?.get(spec.key);
    if (cached !== undefined && !cached.disposed) {
      binding._noteFactory(spec, cached);
      return cached as InstanceHandle<T>;
    }

    this.#unregisterReset ??= registerViewModelReset(() => this.reset());
    this.#preparing += 1;
    const revision = this.#revision;
    try {
      return constructViewModel(() => {
        const viewModel = spec.builder();
        if (!isViewModel(viewModel))
          throw new ViewModelSpecError(`${spec.debugLabel} must build a ViewModel.`);
        if (spec.type !== undefined && !isExplicitTypeInstance(spec.type, viewModel)) {
          throw new ViewModelSpecError(
            `${spec.debugLabel} must build its explicit type or a subclass.`,
          );
        }
        this.#assertAlive();
        binding._assertAlive();
        if (revision !== this.#revision)
          throw new ViewModelSpecError('Runtime reset during ViewModel construction.');
        const generation = ++this.#generation;
        const handle = {
          spec,
          viewModel,
          generation,
          owners: new Map<ViewModelBinding, BindingEntry>(),
          externalOwnerSources: new Map<ViewModelBinding, Set<BindingEntry>>(),
          dependencyBinding: undefined as unknown as ViewModelBinding,
          unkeyedBinding: spec.key === undefined ? binding : undefined,
          version: viewModel.version,
          lifecycleVersion: 0,
          activated: false,
          everAcquired: false,
          disposed: false,
          pendingDisposal: undefined,
        } satisfies InstanceHandle<T>;
        const dependencyBinding = new ViewModelBinding(
          this,
          { id: `view-model:${spec.debugLabel}:${generation}` },
          handle,
        );
        (handle as { dependencyBinding: ViewModelBinding }).dependencyBinding = dependencyBinding;
        try {
          viewModel[VIEW_MODEL_INTERNAL].attach(
            dependencyBinding,
            (change) => this.#notifyHandle(handle, change),
            {
              key: spec.key,
              tag: spec.tag,
              aliveForever: spec.aliveForever,
              type: spec.type,
              debugLabel: spec.debugLabel,
              generation,
            },
          );
        } catch (error) {
          dependencyBinding.dispose();
          throw error;
        }
        this.#handles.add(handle);
        this.#byViewModel.set(viewModel, handle);
        if (spec.key === undefined) binding._setUnkeyed(spec.token, handle);
        else {
          const entries = this.#keyed.get(spec.token) ?? new Map<ViewModelKey, InstanceHandle>();
          entries.set(spec.key, handle);
          this.#keyed.set(spec.token, entries);
        }
        binding._noteFactory(spec, handle);
        this.#scheduleDisposal(handle, true);
        return handle;
      });
    } finally {
      this.#preparing -= 1;
      this.#unregisterWhenEmpty();
    }
  }

  /** Lookup by key, then tag, or newest creation when neither is provided. @internal */
  public _findCached<T extends ViewModel>(
    target: ViewModelCacheTarget<T>,
    lookup: ViewModelCacheLookup = {},
  ): InstanceHandle<T> | undefined {
    this.#assertAlive();
    const token = this.#cacheTargetToken(target);
    if (lookup.key !== undefined) {
      const keyed = this.#keyed.get(token)?.get(lookup.key);
      if (keyed !== undefined && !keyed.disposed) return keyed as InstanceHandle<T>;
      if (lookup.tag === undefined) return undefined;
    }
    let latest: InstanceHandle<T> | undefined;
    let matches = 0;
    for (const handle of this.#handles) {
      if (handle.disposed || handle.spec.token !== token) continue;
      if (lookup.tag !== undefined && !Object.is(handle.spec.tag, lookup.tag)) continue;
      latest = handle as InstanceHandle<T>;
      matches += 1;
    }
    if (lookup.tag !== undefined && matches > 1) {
      const warned = this.#warnedTags.get(token) ?? new Set<unknown>();
      if (!warned.has(lookup.tag)) {
        warned.add(lookup.tag);
        this.#warnedTags.set(token, warned);
        warnViewModel(
          'Multiple ViewModels match this tag; the newest generation is returned. Use an explicit key or a tag batch.',
        );
      }
    }
    return latest;
  }

  /** @internal */
  public _findCachesByTag<T extends ViewModel>(
    target: ViewModelCacheTarget<T>,
    tag: unknown,
  ): InstanceHandle<T>[] {
    this.#assertAlive();
    const token = this.#cacheTargetToken(target);
    return [...this.#handles]
      .filter(
        (handle) =>
          !handle.disposed && handle.spec.token === token && Object.is(handle.spec.tag, tag),
      )
      .reverse() as InstanceHandle<T>[];
  }

  /** Must run before publishing an entry or invoking any lifecycle callback. @internal */
  public _validateAttachment(binding: ViewModelBinding, handle: InstanceHandle): void {
    this.#assertAlive();
    binding._assertAlive();
    if (handle.disposed || handle.viewModel[VIEW_MODEL_INTERNAL].isDisposed)
      throw new ViewModelSpecError('Cannot acquire a disposed generation.');
    const parent = binding._parentHandle;
    if (parent !== undefined && (parent === handle || this.#hasPath(handle, parent))) {
      throw new ViewModelDependencyCycleError([
        describeHandle(parent),
        describeHandle(handle),
        describeHandle(parent),
      ]);
    }
  }

  /** Commit owner and edge ledgers before callbacks can reenter. @internal */
  public _acquire(entry: BindingEntry): void {
    const { binding, handle } = entry;
    this._validateAttachment(binding, handle);
    const parent = binding._parentHandle;
    handle.owners.set(binding, entry);
    if (parent !== undefined) {
      const children = this.#edges.get(parent) ?? new Map<InstanceHandle, BindingEntry>();
      children.set(handle, entry);
      this.#edges.set(parent, children);
    }
    if (handle.pendingDisposal !== undefined) {
      handle.pendingDisposal.cancelled = true;
      handle.pendingDisposal = undefined;
    }
    if (!handle.activated) {
      handle.activated = true;
      handle.viewModel[VIEW_MODEL_INTERNAL].activate();
      this.#requireEntry(entry);
      if (this.isPaused) handle.viewModel[VIEW_MODEL_INTERNAL].pause();
    }
    this.#requireEntry(entry);
    if (parent === undefined) this._addExternalOwnerSource(handle, binding, entry);
    else {
      handle.viewModel[VIEW_MODEL_INTERNAL].bind(binding.id, entry);
      this.#requireEntry(entry);
      for (const owner of [...parent.externalOwnerSources.keys()])
        this._addExternalOwnerSource(handle, owner, entry);
    }
    this.#requireEntry(entry);
    handle.everAcquired = true;
  }

  /** Remove only the exact registration, never a reentrant replacement. @internal */
  public _release(entry: BindingEntry): void {
    const { binding, handle } = entry;
    if (handle.disposed || handle.owners.get(binding) !== entry) return;
    handle.owners.delete(binding);
    const parent = binding._parentHandle;
    if (parent === undefined) this._removeExternalOwnerSource(handle, binding, entry);
    else {
      const children = this.#edges.get(parent);
      if (children?.get(handle) === entry) children.delete(handle);
      if (children?.size === 0) this.#edges.delete(parent);
      // Publish the dependency-owner release first. Its onUnbind may commit a
      // replacement edge; only then remove this edge's inherited root sources.
      // A replacement keeps the visible root bound throughout the handoff.
      handle.viewModel[VIEW_MODEL_INTERNAL].unbind(binding.id, entry);
      for (const [owner, sources] of [...handle.externalOwnerSources]) {
        if (sources.has(entry)) this._removeExternalOwnerSource(handle, owner, entry);
      }
    }
    if (handle.owners.size === 0) {
      handle.viewModel[VIEW_MODEL_INTERNAL].flushUnbinds();
      if (handle.owners.size === 0 && !handle.spec.aliveForever) this.#scheduleDisposal(handle);
    }
  }

  /** Failed new acquisitions must not leave retained, ownerless provisional objects. @internal */
  public _rollbackAcquisition(handle: InstanceHandle): void {
    if (!handle.disposed && !handle.everAcquired && handle.owners.size === 0)
      this.#disposeHandle(handle);
  }

  /** @internal */
  public _requestUpdate(owner: ViewModelBinding, callback: ViewModelListener): void {
    if (this.#disposed || this.#resetting || !markViewModelBindingUpdated(owner)) return;
    this.#deliver(owner, callback);
  }
  /** @internal */
  public _queueCallback(owner: ViewModelBinding, callback: ViewModelListener): void {
    if (this.#disposed || this.#resetting) return;
    const deliveries =
      this.#deliveryCallbacks.get(owner) ?? new Map<ViewModelListener, ViewModelListener>();
    let delivery = deliveries.get(callback);
    if (delivery === undefined) {
      delivery = () => this.#deliver(owner, callback);
      deliveries.set(callback, delivery);
      this.#deliveryCallbacks.set(owner, deliveries);
    }
    enqueueViewModelUpdateCallback(owner, delivery);
  }
  /** @internal */
  public _forgetCallback(owner: ViewModelBinding, callback: ViewModelListener): void {
    this.#deliveryCallbacks.get(owner)?.delete(callback);
    this.#pausedCallbacks.get(owner)?.delete(callback);
  }
  /** @internal */
  public _forgetCallbacks(owner: ViewModelBinding): void {
    this.#pausedCallbacks.delete(owner);
    this.#deliveryCallbacks.delete(owner);
  }
  /** Flush only one resumed owner; shared siblings retain their pause state. @internal */
  public _resumeBinding(owner: ViewModelBinding): void {
    if (owner.isDisposed || owner.isPaused || this.isPaused) return;
    const callbacks = [...(this.#pausedCallbacks.get(owner) ?? [])];
    this.#pausedCallbacks.delete(owner);
    runInViewModelUpdateTransaction(() => {
      for (const callback of callbacks) this._queueCallback(owner, callback);
    });
  }
  /** Every dependency event is forwarded; only root refresh requests are coalesced. @internal */
  public _bubbleDependency(parent: InstanceHandle, child: InstanceHandle): void {
    if (!this.#disposed && !this.#resetting && !parent.disposed)
      parent.viewModel[VIEW_MODEL_INTERNAL].dependencyNotify(child.viewModel);
  }

  /** @internal */
  public _addExternalOwnerSource(
    handle: InstanceHandle,
    owner: ViewModelBinding,
    source: BindingEntry,
  ): void {
    if (handle.disposed || owner.isDisposed || !this.#entryIsCurrent(source)) return;
    const parent = source.binding._parentHandle;
    if (parent !== undefined && !parent.externalOwnerSources.has(owner)) return;
    const sources = handle.externalOwnerSources.get(owner) ?? new Set<BindingEntry>();
    if (sources.has(source)) return;
    sources.add(source);
    handle.externalOwnerSources.set(owner, sources);
    handle.viewModel[VIEW_MODEL_INTERNAL].bind(owner.id, source);
    // onBind may remove the joining owner before propagation reaches descendants.
    if (
      !handle.disposed &&
      handle.externalOwnerSources.get(owner) === sources &&
      sources.has(source)
    ) {
      handle.dependencyBinding._propagateExternalOwnerAdded(owner);
    }
  }

  /** @internal */
  public _removeExternalOwnerSource(
    handle: InstanceHandle,
    owner: ViewModelBinding,
    source: BindingEntry,
  ): void {
    const sources = handle.externalOwnerSources.get(owner);
    if (sources === undefined || !sources.delete(source)) return;
    const last = sources.size === 0;
    if (last) handle.externalOwnerSources.delete(owner);
    handle.viewModel[VIEW_MODEL_INTERNAL].unbind(owner.id, source, () => {
      if (last && !handle.externalOwnerSources.has(owner))
        handle.dependencyBinding._propagateExternalOwnerRemoved(owner);
    });
  }

  #notifyHandle(handle: InstanceHandle, change: ViewModelChange): void {
    if (handle.disposed) return;
    handle.version = Math.max(handle.version, change.version);
    // Snapshot registrations, not just Binding identities, so reentrant replacement
    // cannot inherit an obsolete event or join the middle of this delivery.
    for (const [owner, entry] of [...handle.owners]) {
      if (handle.disposed) break;
      if (handle.owners.get(owner) !== entry || !entry.active) continue;
      try {
        owner._collectNotification(entry);
      } catch (error) {
        reportViewModelError(error, ErrorType.listener, 'dependency notification');
      }
    }
  }

  #entryIsCurrent(entry: BindingEntry): boolean {
    return (
      entry.active &&
      !entry.binding.isDisposed &&
      !entry.handle.disposed &&
      entry.handle.owners.get(entry.binding) === entry
    );
  }
  #requireEntry(entry: BindingEntry): void {
    this.#assertAlive();
    entry.binding._assertAlive();
    if (!this.#entryIsCurrent(entry))
      throw new ViewModelSpecError('Ownership changed during ViewModel acquisition.');
  }
  #deliver(owner: ViewModelBinding, callback: ViewModelListener): void {
    if (this.#disposed || this.#resetting || owner.isDisposed) return;
    if (this.isPaused || owner.isPaused) {
      const callbacks = this.#pausedCallbacks.get(owner) ?? new Set<ViewModelListener>();
      callbacks.add(callback);
      this.#pausedCallbacks.set(owner, callbacks);
    } else {
      try {
        callback();
      } catch (error) {
        reportViewModelError(error, ErrorType.listener, 'binding update');
      }
    }
  }
  #hasPath(start: InstanceHandle, target: InstanceHandle): boolean {
    const visited = new Set<InstanceHandle>();
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      if (current === target) return true;
      pending.push(...(this.#edges.get(current)?.keys() ?? []));
    }
    return false;
  }
  #ancestorUsesToken(start: InstanceHandle, token: symbol): boolean {
    const visited = new Set<InstanceHandle>();
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      if (current.spec.token === token) return true;
      for (const [parent, children] of this.#edges) if (children.has(current)) pending.push(parent);
    }
    return false;
  }
  #scheduleDisposal(handle: InstanceHandle, provisional = false): void {
    if (handle.disposed) return;
    if (handle.pendingDisposal !== undefined) handle.pendingDisposal.cancelled = true;
    const pending: PendingDisposal = { cancelled: false };
    handle.pendingDisposal = pending;
    scheduleMicrotask(() => {
      if (
        pending.cancelled ||
        handle.pendingDisposal !== pending ||
        handle.owners.size > 0 ||
        handle.disposed ||
        (!provisional && handle.spec.aliveForever)
      )
        return;
      runInViewModelUpdateTransaction(() => this.#disposeHandle(handle));
    });
  }

  #disposeHandle(handle: InstanceHandle): void {
    if (handle.disposed) return;
    this.#disposalDepth += 1;
    handle.disposed = true;
    handle.lifecycleVersion += 1;
    if (handle.pendingDisposal !== undefined) {
      handle.pendingDisposal.cancelled = true;
      handle.pendingDisposal = undefined;
    }
    this.#handles.delete(handle);
    this.#byViewModel.delete(handle.viewModel);
    if (handle.spec.key === undefined)
      handle.unkeyedBinding?._deleteUnkeyed(handle.spec.token, handle);
    else {
      const entries = this.#keyed.get(handle.spec.token);
      if (entries?.get(handle.spec.key) === handle) entries.delete(handle.spec.key);
      if (entries?.size === 0) this.#keyed.delete(handle.spec.token);
    }
    try {
      const owners = [...handle.owners.values()];
      handle.owners.clear();
      // Invalidate every old registration before callbacks can re-resolve the key.
      for (const entry of owners) {
        const notify = entry.binding._detachDisposedEntry(entry);
        if (notify !== undefined) this.#disposalNotifications.push(notify);
      }
      for (const [owner, sources] of [...handle.externalOwnerSources]) {
        for (const source of [...sources]) this._removeExternalOwnerSource(handle, owner, source);
      }
      for (const entry of owners) {
        if (entry.binding._parentHandle !== undefined)
          handle.viewModel[VIEW_MODEL_INTERNAL].unbind(entry.binding.id, entry);
      }
      handle.viewModel[VIEW_MODEL_INTERNAL].flushUnbinds();
      handle.viewModel[VIEW_MODEL_INTERNAL].dispose();
      const children = [...(this.#edges.get(handle)?.keys() ?? [])];
      handle.dependencyBinding.dispose();
      for (const child of children) {
        if (!child.disposed && child.owners.size === 0 && !child.spec.aliveForever)
          this.#disposeHandle(child);
      }
      this.#edges.delete(handle);
      for (const [parent, children] of this.#edges) {
        children.delete(handle);
        if (children.size === 0) this.#edges.delete(parent);
      }
    } finally {
      this.#disposalDepth -= 1;
      this.#unregisterWhenEmpty();
      if (this.#disposalDepth === 0) {
        const notifications = this.#disposalNotifications.splice(0);
        for (const notify of notifications) {
          try {
            notify();
          } catch (error) {
            reportViewModelError(error, ErrorType.listener, 'generation disposal');
          }
        }
      }
    }
  }
  #disposeAll(): void {
    this.#pauseTokens.clear();
    this.#pausedCallbacks.clear();
    runInViewModelUpdateTransaction(() => {
      for (const handle of [...this.#handles]) this.#disposeHandle(handle);
    });
    this.#keyed.clear();
    this.#edges.clear();
    this.#warnedTags.clear();
    for (const binding of this.#bindings) binding._resetPause();
  }
  #unregisterWhenEmpty(): void {
    if (
      this.#handles.size === 0 &&
      this.#preparing === 0 &&
      this.#bindings.size === 0 &&
      !this.isPaused
    ) {
      this.#unregisterReset?.();
      this.#unregisterReset = undefined;
    }
  }
  #cacheTargetToken<T extends ViewModel>(target: ViewModelCacheTarget<T>): symbol {
    return isViewModelSpec(target)
      ? target.token
      : getViewModelTypeToken(target as ViewModelType<T>);
  }
  #assertAlive(): void {
    if (this.#disposed || this.#resetting || isViewModelResetting())
      throw new ViewModelRuntimeDisposedError(
        'ViewModelRuntime has been disposed or is resetting.',
      );
  }
}

/** A lifetime owner; reads and watches persist until unbind or dispose, not a render pass. */
export class ViewModelBinding {
  public readonly id: string;
  public readonly runtime: ViewModelRuntime;
  /** @internal */
  public readonly _parentHandle: InstanceHandle | undefined;
  readonly #onUpdate: ViewModelListener | undefined;
  readonly #unkeyed = new Map<symbol, InstanceHandle>();
  readonly #entries = new Map<InstanceHandle, BindingEntry>();
  readonly #resolved = new Map<symbol, Map<ViewModelKey | undefined, BindingEntry>>();
  readonly #ownedSubscriptions = new Map<BindingEntry, Set<ViewModelDispose>>();
  readonly #pauseTokens = new Set<unknown>();
  readonly #factorySources = new WeakMap<
    InstanceHandle,
    { source: unknown; warned: Set<unknown> }
  >();
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
    runtime._registerBinding(this);
  }

  public get isDisposed(): boolean {
    return this.#disposed;
  }
  public get isPaused(): boolean {
    return this.#pauseTokens.size > 0;
  }
  /** Pause this owner's host refreshes only, without pausing shared ViewModels or business listeners. */
  public pause(token: unknown = DEFAULT_PAUSE_TOKEN): void {
    this._assertAlive();
    this.#pauseTokens.add(token);
  }
  public resume(token: unknown = DEFAULT_PAUSE_TOKEN): void {
    if (this.#disposed || !this.#pauseTokens.delete(token) || this.isPaused) return;
    this.runtime._resumeBinding(this);
  }
  /** @internal */
  public _resetPause(): void {
    this.#pauseTokens.clear();
  }
  /** Render-safe: creates pure objects only. @internal */
  public prepare<T extends ViewModel>(spec: ViewModelSpec<T>): T {
    return this.runtime._prepare(this, spec).viewModel;
  }
  public read<T extends ViewModel>(spec: ViewModelSpec<T>): T {
    const handle = this.runtime._prepare(this, spec);
    this.#ensureEntry(handle, false);
    return handle.viewModel;
  }
  public watch<T extends ViewModel>(spec: ViewModelSpec<T>, listener?: ViewModelListener): T {
    const handle = this.runtime._prepare(this, spec);
    const entry = this.#ensureEntry(handle, true, true);
    if (
      listener !== undefined &&
      ![...entry.subscriptions].some(
        (record) => record.imperative && record.original === listener && record.active,
      )
    ) {
      this.#subscribeEntry(entry, 'watch', listener, true);
    }
    return handle.viewModel;
  }
  public recycle(target: ViewModel | ViewModelSpec<ViewModel>): number {
    this._assertAlive();
    return this.runtime.recycle(target);
  }

  /** Release this Binding's registration only. Reentrant replacements are independent. */
  public unbind(target: ViewModel | ViewModelSpec<ViewModel>): number {
    this._assertAlive();
    const resolvedTarget = isViewModelSpec(target) ? this.runtime._resolveSpec(target) : target;
    const entries = [...this.#entries.values()].filter(({ handle }) =>
      isViewModelSpec(resolvedTarget)
        ? handle.spec.token === resolvedTarget.token && sameKey(handle.spec.key, resolvedTarget.key)
        : handle.viewModel === resolvedTarget,
    );
    for (const entry of entries) this.#removeEntry(entry);
    return entries.length;
  }
  public readCached<T extends ViewModel>(
    target: ViewModelCacheTarget<T>,
    lookup: ViewModelCacheLookup = {},
  ): T {
    return this.#requireCached(target, lookup, false).viewModel;
  }
  public watchCached<T extends ViewModel>(
    target: ViewModelCacheTarget<T>,
    lookup: ViewModelCacheLookup = {},
  ): T {
    return this.#requireCached(target, lookup, true).viewModel;
  }
  public maybeReadCached<T extends ViewModel>(
    target: ViewModelCacheTarget<T>,
    lookup: ViewModelCacheLookup = {},
  ): T | undefined {
    return this.#maybeCached(target, lookup, false)?.viewModel;
  }
  public maybeWatchCached<T extends ViewModel>(
    target: ViewModelCacheTarget<T>,
    lookup: ViewModelCacheLookup = {},
  ): T | undefined {
    return this.#maybeCached(target, lookup, true)?.viewModel;
  }
  public readCachesByTag<T extends ViewModel>(target: ViewModelCacheTarget<T>, tag: unknown): T[] {
    return this.#cachesByTag(target, tag, false).map((handle) => handle.viewModel);
  }
  public watchCachesByTag<T extends ViewModel>(target: ViewModelCacheTarget<T>, tag: unknown): T[] {
    return this.#cachesByTag(target, tag, true).map((handle) => handle.viewModel);
  }

  public listen<T extends ViewModel>(
    spec: ViewModelSpec<T>,
    onChanged: ViewModelListener,
  ): ViewModelDispose {
    const handle = this.runtime._prepare(this, spec);
    const entry = this.#ensureEntry(handle, false);
    return this.#trackOwnedSubscription(
      entry,
      handle.viewModel.subscribe(() => {
        if (this.#isCurrent(entry)) onChanged();
      }),
    );
  }
  public listenState<TState>(
    spec: ViewModelSpec<StateViewModel<TState>>,
    onChanged: StateChangeListener<TState>,
  ): ViewModelDispose {
    const handle = this.runtime._prepare(this, spec);
    const entry = this.#ensureEntry(handle, false);
    return this.#trackOwnedSubscription(
      entry,
      handle.viewModel.listenState((previous, current) => {
        if (this.#isCurrent(entry)) onChanged(previous, current);
      }),
    );
  }
  public listenStateSelect<TState, TSelection>(
    spec: ViewModelSpec<StateViewModel<TState>>,
    selector: (state: TState) => TSelection,
    onChanged: StateChangeListener<TSelection>,
    equals?: Equality<TSelection>,
  ): ViewModelDispose {
    const handle = this.runtime._prepare(this, spec);
    const entry = this.#ensureEntry(handle, false);
    return this.#trackOwnedSubscription(
      entry,
      handle.viewModel.listenStateSelect(
        selector,
        (previous, current) => {
          if (this.#isCurrent(entry)) onChanged(previous, current);
        },
        equals,
      ),
    );
  }

  /** Commit-time host subscription; cancellation does not implicitly release ownership. @internal */
  public subscribe<T extends ViewModel>(
    spec: ViewModelSpec<T>,
    mode: ViewModelMode,
    listener: ViewModelListener,
  ): ViewModelDispose {
    const handle = this.runtime._prepare(this, spec);
    return this.#subscribeEntry(this.#ensureEntry(handle, mode === 'watch'), mode, listener, false);
  }
  /** A read snapshot ignores ordinary VM notifications, but observes new generations. @internal */
  public getSnapshot<T extends ViewModel>(spec: ViewModelSpec<T>, mode: ViewModelMode): string {
    const handle = this.runtime._prepare(this, spec);
    return `${handle.generation}:${mode === 'watch' ? handle.version : handle.lifecycleVersion}`;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pauseTokens.clear();
    this.runtime._forgetBinding(this);
    for (const entry of [...this.#entries.values()]) this.#removeEntry(entry);
    this.#entries.clear();
    this.#resolved.clear();
    this.#unkeyed.clear();
  }

  /** Diagnostic only: never execute a later builder or stringify user-supplied keys/tags. @internal */
  public _noteFactory(spec: ViewModelSpec<ViewModel>, handle: InstanceHandle): void {
    const record = this.#factorySources.get(handle);
    if (record === undefined) {
      this.#factorySources.set(handle, { source: spec.debugSource, warned: new Set() });
      return;
    }
    if (Object.is(record.source, spec.debugSource) || record.warned.has(spec.debugSource)) return;
    record.warned.add(spec.debugSource);
    warnViewModel(
      'Different factories resolved the same ViewModel type and effective key in one Binding; the later builder is ignored.',
    );
  }
  /** @internal */
  public _getOwned<T extends ViewModel>(spec: ViewModelSpec<T>): InstanceHandle | undefined {
    const entry = this.#resolved.get(spec.token)?.get(spec.key);
    if (entry === undefined || !this.#isCurrent(entry)) return undefined;
    return entry.handle;
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
  public _collectNotification(entry: BindingEntry): void {
    if (!this.#isCurrent(entry)) return;
    if (this._parentHandle !== undefined && entry.bubble)
      this.runtime._bubbleDependency(this._parentHandle, entry.handle);
    if (!this.#isCurrent(entry)) return;
    if (entry.imperativeWatch && this.#onUpdate !== undefined)
      this.runtime._requestUpdate(this, this.#onUpdate);
    for (const record of [...entry.subscriptions]) {
      if (record.mode === 'watch' && record.active)
        this.runtime._queueCallback(this, record.notify);
    }
  }

  /** Detach now, notify only after the old generation and exclusive children finish. @internal */
  public _detachDisposedEntry(entry: BindingEntry): ViewModelListener | undefined {
    if (this.#entries.get(entry.handle) !== entry) return undefined;
    this.#deleteEntry(entry);
    this._deleteUnkeyed(entry.handle.spec.token, entry.handle);
    this.#disposeOwnedSubscriptions(entry);
    for (const record of entry.subscriptions) record.terminal = true;
    return () => {
      if (this.#disposed) return;
      if (this._parentHandle !== undefined && !this._parentHandle.disposed)
        this.runtime._bubbleDependency(this._parentHandle, entry.handle);
      if (this.#onUpdate !== undefined) this.runtime._requestUpdate(this, this.#onUpdate);
      for (const record of [...entry.subscriptions]) {
        if (record.active) this.runtime._queueCallback(this, record.notify);
      }
    };
  }
  /** @internal */
  public _propagateExternalOwnerAdded(owner: ViewModelBinding): void {
    if (this.#disposed || this._parentHandle === undefined) return;
    for (const entry of [...this.#entries.values()]) {
      if (!this._parentHandle.externalOwnerSources.has(owner)) break;
      if (this.#isCurrent(entry)) this.runtime._addExternalOwnerSource(entry.handle, owner, entry);
    }
  }
  /** @internal */
  public _propagateExternalOwnerRemoved(owner: ViewModelBinding): void {
    if (this._parentHandle === undefined) return;
    for (const entry of [...this.#entries.values()]) {
      if (this._parentHandle.externalOwnerSources.has(owner)) break;
      this.runtime._removeExternalOwnerSource(entry.handle, owner, entry);
    }
  }
  /** @internal */
  public _assertAlive(): void {
    if (this.#disposed)
      throw new ViewModelBindingDisposedError(`ViewModelBinding ${this.id} has been disposed.`);
  }

  #requireCached<T extends ViewModel>(
    target: ViewModelCacheTarget<T>,
    lookup: ViewModelCacheLookup,
    watch: boolean,
  ): InstanceHandle<T> {
    const handle = this.#maybeCached(target, lookup, watch);
    if (handle !== undefined) return handle;
    const label = isViewModelSpec(target) ? target.debugLabel : (target.name ?? 'ViewModel');
    throw new ViewModelSpecError(`No cached ${label} matches the lookup.`);
  }
  #maybeCached<T extends ViewModel>(
    target: ViewModelCacheTarget<T>,
    lookup: ViewModelCacheLookup,
    watch: boolean,
  ): InstanceHandle<T> | undefined {
    this._assertAlive();
    const handle = this.runtime._findCached(target, lookup);
    if (handle !== undefined) this.#ensureEntry(handle, watch, watch);
    return handle;
  }
  #cachesByTag<T extends ViewModel>(
    target: ViewModelCacheTarget<T>,
    tag: unknown,
    watch: boolean,
  ): InstanceHandle<T>[] {
    this._assertAlive();
    const handles = this.runtime._findCachesByTag(target, tag);
    // A failing edge must not partially bind a tag batch or upgrade existing reads.
    for (const handle of handles) this.runtime._validateAttachment(this, handle);
    const created: BindingEntry[] = [];
    const acquired: BindingEntry[] = [];
    try {
      for (const handle of handles) {
        const previous = this.#entries.get(handle);
        const entry = this.#ensureEntry(handle, false);
        if (entry !== previous) created.push(entry);
        acquired.push(entry);
      }
      for (const entry of acquired) {
        if (!this.#isCurrent(entry))
          throw new ViewModelSpecError('Ownership changed during tag-batch acquisition.');
      }
      for (const entry of acquired) {
        entry.bubble ||= watch;
        entry.imperativeWatch ||= watch;
      }
      return handles;
    } catch (error) {
      for (const entry of created.reverse()) {
        if (this.#entries.get(entry.handle) === entry) this.#removeEntry(entry);
      }
      throw error;
    }
  }
  #subscribeEntry(
    entry: BindingEntry,
    mode: ViewModelMode,
    listener: ViewModelListener,
    imperative: boolean,
  ): ViewModelDispose {
    const record: SubscriptionRecord = {
      mode,
      original: listener,
      imperative,
      active: true,
      terminal: false,
      notify: () => {
        if (!record.active) return;
        try {
          listener();
        } finally {
          if (record.terminal) {
            record.active = false;
            entry.subscriptions.delete(record);
            this.runtime._forgetCallback(this, record.notify);
          }
        }
      },
    };
    entry.subscriptions.add(record);
    return () => {
      record.active = false;
      entry.subscriptions.delete(record);
      this.runtime._forgetCallback(this, record.notify);
      if (
        !entry.imperativeWatch &&
        ![...entry.subscriptions].some((item) => item.active && item.mode === 'watch')
      )
        entry.bubble = false;
    };
  }
  #trackOwnedSubscription(
    entry: BindingEntry,
    disposeSubscription: ViewModelDispose,
  ): ViewModelDispose {
    const subscriptions = this.#ownedSubscriptions.get(entry) ?? new Set<ViewModelDispose>();
    let active = true;
    const dispose = (): void => {
      if (!active) return;
      active = false;
      try {
        disposeSubscription();
      } catch (error) {
        reportViewModelError(error, ErrorType.dispose, 'subscription cleanup');
      } finally {
        subscriptions.delete(dispose);
        if (subscriptions.size === 0 && this.#ownedSubscriptions.get(entry) === subscriptions)
          this.#ownedSubscriptions.delete(entry);
      }
    };
    subscriptions.add(dispose);
    this.#ownedSubscriptions.set(entry, subscriptions);
    if (!this.#isCurrent(entry)) dispose();
    return dispose;
  }
  #disposeOwnedSubscriptions(entry: BindingEntry): void {
    const subscriptions = this.#ownedSubscriptions.get(entry);
    this.#ownedSubscriptions.delete(entry);
    for (const dispose of [...(subscriptions ?? [])]) dispose();
  }
  #isCurrent(entry: BindingEntry): boolean {
    return (
      !this.#disposed &&
      entry.active &&
      !entry.handle.disposed &&
      this.#entries.get(entry.handle) === entry
    );
  }
  #deleteEntry(entry: BindingEntry): void {
    if (this.#entries.get(entry.handle) !== entry) return;
    this.#entries.delete(entry.handle);
    this.#factorySources.delete(entry.handle);
    entry.active = false;
    const { token, key } = entry.handle.spec;
    const resolved = this.#resolved.get(token);
    if (resolved?.get(key) === entry) resolved.delete(key);
    if (resolved?.size === 0) this.#resolved.delete(token);
  }
  #removeEntry(entry: BindingEntry): void {
    if (this.#entries.get(entry.handle) !== entry) return;
    this.#deleteEntry(entry);
    for (const record of entry.subscriptions) {
      record.active = false;
      this.runtime._forgetCallback(this, record.notify);
    }
    entry.subscriptions.clear();
    try {
      this.runtime._release(entry);
    } finally {
      this.#disposeOwnedSubscriptions(entry);
    }
  }
  #ensureEntry(handle: InstanceHandle, bubble: boolean, imperativeWatch = false): BindingEntry {
    this._assertAlive();
    const existing = this.#entries.get(handle);
    if (existing !== undefined && existing.active) {
      existing.bubble ||= bubble;
      existing.imperativeWatch ||= imperativeWatch;
      return existing;
    }
    this.runtime._validateAttachment(this, handle);
    const entry: BindingEntry = {
      binding: this,
      handle,
      subscriptions: new Set(),
      active: true,
      bubble,
      imperativeWatch,
    };
    this.#entries.set(handle, entry);
    const resolved =
      this.#resolved.get(handle.spec.token) ?? new Map<ViewModelKey | undefined, BindingEntry>();
    resolved.set(handle.spec.key, entry);
    this.#resolved.set(handle.spec.token, resolved);
    try {
      this.runtime._acquire(entry);
      return entry;
    } catch (error) {
      if (this.#entries.get(handle) === entry) this.#removeEntry(entry);
      this.runtime._rollbackAcquisition(handle);
      throw error;
    }
  }
}
