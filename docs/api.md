# API Reference

[简体中文](./zh/api.md) · [Flutter migration](./flutter-comparison.md)

The alignment additions are unreleased. See the migration guide before upgrading from npm 0.3.1.

## Package entries

`@lwjlol/view_model` and `/core` export the framework-independent API.
`/react-native`, `/electron`, `/vue`, and `/taro-vue` re-export core and add their optional host adapters.
There is no public `/react` entry and no Web/SSR/RSC contract. Underscore-prefixed and `@internal`
members are implementation details, even when visible in source.

## `ViewModel`

Extend the class. Constructors/builders must be pure; acquire resources in protected `onCreate`.
The public properties are `version`, `isDisposed`, `isPaused`, `hasListeners`, `key`, `tag`,
`instanceInfo`, a snapshot `bindingIds`, and the stable generation-owned `viewModelBinding`.
`instanceInfo` is undefined before managed attachment. `viewModelBinding` throws for unmanaged
or disposed instances; use getters to resolve dependencies after commit, never during rendering.

### Mutations and listeners

```ts
vm.notifyListeners('refresh');
vm.update(() => {
  /* mutate fields */
});
vm.update('action', () => {
  /* mutate fields */
});
await vm.update('async action', async () => {
  /* await work, then mutate */
});
const unsubscribe = vm.listen(() => {
  /* business reaction */
});
const unsubscribeAlias = vm.subscribe(() => {
  /* direct subscription */
});
vm.addListener(callback);
vm.removeListener(callback);
const cancelCleanup = vm.addDispose(cleanup);
```

`update` returns the block's value; a Promise settles after the final notification. Synchronous
success notifies before returning, asynchronous success after completion. A failed block does not
emit its final notification, but is not a rollback of earlier writes. Do not add a redundant notify
inside the block. Nested calls restore the surrounding synchronous action context.

`notifyListeners` increments the version and delivers direct listeners synchronously. Removed
listeners are skipped; listeners added during delivery wait for a later event. Raw `addListener`
allows duplicates and `removeListener` removes one. Each `subscribe/listen` disposer independently
removes its own registration. A diamond forwards each dependency event; one complete synchronous
cascade coalesces root Binding refresh requests. Host subscriptions sample the final snapshot at
transaction end; direct business listeners see every event. A later async event starts a new transaction.

`addDispose` registers reverse-order cleanup after `onDispose`. Its return value only cancels that
registration. Notification, lifecycle and cleanup exceptions are safely reported through configuration;
remaining listeners and cleanup continue. Disposed notifications are ignored. New subscriptions,
`addDispose`, dependency resolution and `update` reject disposed instances.

### Lifecycle hooks

```ts
protected onCreate(): void;
protected onBind(bindingId: string): void;
protected onUnbind(bindingId: string): void;
protected onDispose(): void;
protected onPause(): void;
protected onResume(): void;
protected assertAlive(): void;
```

There is no `onDependencyNotify` hook. `watch` automatically forwards a child's event; use a
Binding-owned `listen` for business logic. Sources are counted by exact owner registration:
first source binds a logical id, last source unbinds it. Callback reentry cannot remove replacement
registrations. `onCreate/onBind` failures are reported, not an automatic acquisition rollback;
if a hook actually removes its owner, acquisition rejects the obsolete registration.
Hooks are synchronous; the Runtime does not await an accidentally async hook.

## Configuration and lifecycle observers

```ts
ViewModel.initialize({
  config: {
    equals: Object.is,
    isLoggingEnabled: false,
    onError: (error, type, context) => {
      reportError(error, type, context);
    },
    onWarning: (message) => {
      recordWarning(message);
    },
  },
  lifecycles: [observer],
});
const remove = ViewModel.addLifecycle(observer);
ViewModel.removeLifecycle(observer);
const config = ViewModel.config;
ViewModel.reset();
```

Initialization is once per JS realm until reset. Observers implement optional
`onCreate(vm, info)`, `onBind(vm, info, id)`, `onUnbind(vm, info, id)`, `onDispose(vm, info)`.
`ViewModelInstanceInfo` contains key, tag, aliveForever, generation, debugLabel and explicit type.
`ErrorType` is `listener | lifecycle | dispose | pauseResume`. The default sink logs to console;
an error in the custom sink cannot interrupt ownership or cleanup. Logging is opt-in for factory/tag
ambiguity warnings; it does not silence error reporting.

`ViewModel.reset()` destroys all registered Runtime generations, including retained ones, clears pause
state and configuration/observers, and preserves reusable root Bindings. `runtime.reset()` only resets
that Runtime and preserves configuration. Reset refuses reentrant creation. Manual overrides still
require their restore functions. ESM/CJS entries share configuration and reset within the same realm.

## `StateViewModel<TState>`

```ts
protected constructor(initialState: TState, equals?: Equality<TState>);
protected setState(next: TState, action?: unknown): boolean;
protected updateState(updater: (state: TState) => TState, action?: unknown): boolean;
protected onError(error: unknown): void;
```

`state`, `initialState`/`initState`, and `previousState` expose snapshots. Previous state is undefined
until the first successful replacement. Equality precedence is explicit constructor comparator,
`ViewModel.config.equals`, then `Object.is`; immutable replacement is recommended. Equality failure
leaves state unchanged and invokes `onError` (default: configured error reporting). After disposal,
state methods return false without evaluating the updater.

```ts
const stop1 = vm.listenState((previous, current) => {
  /* real state transition */
});
const stop2 = vm.listenStateSelect(selector, (previous, current) => {}, Object.is);
const stop3 = vm.subscribeState(({ previous, current }) => {
  /* legacy object payload */
});
```

`StateChangeListener<T>` is `(previous: T, current: T) => void`; T can itself be nullable.
`StateListener<T>` retains the `StateChange<T>` object used by `subscribeState`.
Reentrant state events are FIFO: every listener finishes the earlier event before seeing the nested
one. The stored state changes immediately; use callback arguments to inspect that event's snapshots.
Ordinary `notifyListeners` never replays a state diff. Selection equality also uses explicit/global/
`Object.is`. Direct subscriptions are manually owned and are not paused by visual pause tokens.

## `ViewModelSpec<T>` and families

```ts
const spec = viewModelSpec(CounterViewModel, () => new CounterViewModel(), {
  key: 'counter',
  tag: 'counters',
  aliveForever: false,
  debugLabel: 'counter',
  debugSource: stableFactoryIdentity,
});
const alternativeSyntax = new ViewModelSpec(CounterViewModel, () => new CounterViewModel());
const keyed = spec.withKey('another-counter');
const byId = ViewModelSpec.arg(UserViewModel, (id: string) => new UserViewModel(id), {
  key: (id) => id,
  tag: () => 'users',
  aliveForever: () => false,
});
const concrete = byId('ada');
```

`arg2/arg3/arg4` accept correspondingly typed builder arguments and options functions.
Explicit class + effective key defines cache identity within a Runtime; unkeyed is private to a Binding.
Arguments, tag, debugLabel and debugSource do not define identity. Later builders cannot replace a hit.
`debugSource` distinguishes declarations only for ambiguity diagnostics. Families share one source identity.
Keys allow string, number, symbol, boolean, bigint or object; object keys use reference identity,
`undefined` means unkeyed, and `null` is rejected. Retained (`aliveForever`) requires an explicit key.

The builder-only overload still exists, but each base Spec has a private token. Prefer explicit classes.
`withKey` preserves class/token and options, but is a separate concrete declaration for override purposes.

### Overrides

```ts
const restore = spec.overrideWith(replacementSpec);
try {
  binding.read(spec);
} finally {
  restore();
}
await spec.runWithOverride(replacementSpec, async (runtime) => {
  const binding = runtime.createBinding();
  await prepareFixture();
  binding.read(spec);
});
await ViewModelRuntime.runWithOverrides([[spec, replacementSpec]], async (runtime) => {});
await parentRuntime.runWithOverrides([[spec, replacementSpec]], async (runtime) => {});
```

Families support the same override helpers with matching argument types. Manual overrides are realm-wide,
stacked, idempotently restorable and safe to restore out of order. `setProxy/clearProxy` remain deprecated
compatibility aliases for a fallback replacement. Cycles are rejected before construction.
The original class identity is retained while the replacement supplies builder/key/tag/lifetime.
Existing generations are not replaced. Scoped helpers create, supply and finally dispose an isolated
Runtime; they snapshot inherited overrides and do not install ambient async context. Always use the
supplied Runtime, including after await. See [migration boundaries](./flutter-comparison.md).

## `ViewModelRuntime`

`new ViewModelRuntime({ overrides?, inheritGlobalOverrides? })` defines one cache/graph and pause boundary.
Overrides are an iterable of `[source, replacement]` pairs; by default global overrides are also visible.
A manually created Runtime must be disposed by its owner.

| Member                              | Contract                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `createBinding({ id?, onUpdate? })` | Stable lifetime owner; `onUpdate` is a refresh request, not every business event |
| `isDisposed`, `isPaused`            | Runtime state                                                                    |
| `pause(token?)`, `resume(token?)`   | Aggregate app/window reasons; VM hooks only on boundary transitions              |
| `recycle(vmOrSpec): number`         | Force-dispose matching generations for every owner, including retained           |
| `reset()`                           | Clear generations and pause without ending reusable root Bindings                |
| `dispose()`                         | Permanently end this Runtime; subsequent resolution fails                        |
| `maybeReadCached(target, lookup?)`  | Non-owning lookup, undefined on miss; never constructs                           |
| `readCached(target, lookup?)`       | Non-owning lookup, throws on miss                                                |
| `readCachesByTag(target, tag)`      | Non-owning newest-first matches                                                  |
| `countInstances(target?, lookup?)`  | Count current generations, optionally by type/key/tag                            |
| `getDiagnostics()`                  | Snapshot of instance metadata, owners, source counts and dependency edges        |

A Spec recycle target resolves its effective override identity; unkeyed Specs may match one generation
per Binding. Disposal removes cache entries before callbacks and finishes exclusive children before
replacement refresh. A Runtime lookup does **not** bind or keep an instance alive. Use Binding lookup
for owned dependencies. A Spec passed as a cached target supplies its type/token only; key/tag must be
specified in `lookup`. Key lookup wins; only a missing key falls back to tag. Without either, return the
latest-created instance, not the most recently read one. Tags use identity comparison without coercion.

## `ViewModelBinding`

`id`, `runtime`, `isDisposed`, `isPaused` describe the owner. Both `read(spec)` and `watch(spec, listener?)`
acquire lifetime ownership; only watch forwards ordinary changes. Read-to-watch upgrades take effect
without recreating the instance. Reads never silently downgrade a watch. Parent dependencies and ownership
persist until explicit unbind, recycle or disposal, not until the next render/build.

`watch(spec, listener)` callbacks and `onUpdate` are visual refresh callbacks, coalesced per transaction
and deferred by visual pause. For every business event use `listen`, not the optional watch callback.

```ts
const stop = binding.listen(spec, () => {});
const stopState = binding.listenState(stateSpec, (previous, current) => {});
const stopSelect = binding.listenStateSelect(
  stateSpec,
  selector,
  (previous, current) => {},
  Object.is,
);
binding.unbind(vmOrSpec);
binding.recycle(vmOrSpec);
binding.pause();
binding.resume();
binding.dispose();
```

`listen*` acquires a read owner, has no implicit broad watch, and runs without visual pause suppression.
Its registration is removed by the returned disposer or when the exact owner entry/generation ends.
`unbind` releases only this Binding's registration, not other owners; `recycle` is Runtime-wide.
Local `pause/resume` delays only this Binding's visual delivery, not VM pause hooks or other owners.
Natural final-owner release is microtask-deferred; forced recycle/reset/dispose are synchronous.

### Owned cache lookup

`readCached/watchCached(target, lookup?)`, `maybeReadCached/maybeWatchCached(target, lookup?)`, and
`readCachesByTag/watchCachesByTag(target, tag)` never run builders. Hits **do** acquire ownership and
parent edges. Only watch variants forward ordinary changes. Maybe returns undefined only for misses,
not for cycle/ownership errors. Batches preflight the entire graph, acquire before upgrading watches,
and roll back only newly created exact registrations on failure; reentrant replacements survive.

### Adapter methods

`prepare(spec)` constructs a pure provisional object without owner hooks. `subscribe(spec, mode, listener)`
acquires at commit; cancelling removes that subscription but retains the Binding's owner.
`getSnapshot(spec, mode)` combines generation identity with version (watch) or lifecycle (read).
Ordinary application code should use read/watch or the platform adapters, not these host internals.

## React hooks

Both platform entry points export the same hook API.

The Scope is the owner boundary: all hooks below one Scope share its Binding. A hook subscription can unmount independently, but its ViewModel ownership remains until that Scope Binding releases the generation or the Scope is disposed. React render may only prepare a provisional object; commit performs ownership and lifecycle acquisition.

### `useViewModel(spec): T`

Acquires the current Scope Binding during commit and rerenders for ordinary notifications and generation replacement.

### `useReadViewModel(spec): T`

Acquires and retains the generation without rerendering for ordinary notifications. Generation disposal/recycle still changes its snapshot.

### `useViewModelSelector(spec, selector, equals?): Selection`

Subscribes to ViewModel notifications but returns only the selected value. The default equality is `Object.is`.

The selector receives the ViewModel, not only `StateViewModel.state`, so it can select any pure exposed field. It must not mutate, subscribe, perform I/O, or resolve child dependencies.

### `useViewModelRuntime(): ViewModelRuntime`

Returns the current platform Scope Runtime. Intended for infrastructure and advanced integrations.

### `useViewModelBinding(): ViewModelBinding`

Returns the current Scope Binding. Do not call imperative Binding resolution during render.

### Hook types

```ts
type ViewModelSelector<T extends ViewModel, Selection> = (viewModel: T) => Selection;

type ViewModelEquality<Selection> = (previous: Selection, next: Selection) => boolean;
```

## React Native API

`@lwjlol/view_model/react-native` re-exports all core symbols and adds the following.

### `ViewModelScope`

```ts
interface ViewModelScopeProps extends PropsWithChildren {
  readonly runtime?: ViewModelRuntime;
  readonly appState?: ReactNativeAppState;
  readonly lifecycle?: ViewModelLifecycleSource;
}
```

- without an injected/parent Runtime, the Scope creates and owns one;
- a nested Scope reuses its parent Runtime by default and creates a new Binding;
- `appState` defaults to React Native `AppState`;
- an explicit `lifecycle` replaces the AppState lifecycle for that Scope;
- lifecycle pause affects the entire selected Runtime.

### `createReactNativeAppStateLifecycleSource(appState)`

Converts the minimal React Native AppState interface into a `ViewModelLifecycleSource`. Only `currentState === 'active'` is active; every other value is inactive.

### React Native lifecycle types

```ts
interface ReactNativeAppStateSubscription {
  remove(): void;
}

interface ReactNativeAppState {
  readonly currentState: string | null;
  addEventListener(
    type: 'change',
    listener: (state: string) => void,
  ): ReactNativeAppStateSubscription;
}

interface ViewModelLifecycleSource {
  isActive(): boolean;
  subscribe(listener: (active: boolean) => void): () => void;
}
```

## Electron renderer API

`@lwjlol/view_model/electron` re-exports all core symbols and adds the following.

### `ViewModelScope`

```ts
interface ViewModelScopeProps extends PropsWithChildren {
  readonly runtime?: ViewModelRuntime;
  readonly lifecycle?: ElectronLifecycleSource;
}
```

The default lifecycle is created from the current renderer `window` and `document`. An injected Runtime remains caller-owned.

### `createElectronRendererLifecycleSource(target?)`

Creates a focus-and-visibility lifecycle source. It reports active only when the window is focused and the document is not hidden.

```ts
interface ElectronRendererLifecycleTarget {
  readonly window?: ElectronRendererWindow;
  readonly document?: ElectronRendererDocument;
}
```

The minimal window surface supports `focus`/`blur` listener installation and removal. The minimal document surface supports `visibilityState`, optional `hasFocus()`, and `visibilitychange` listeners.

### `ElectronLifecycleSource`

Extends the internal platform lifecycle contract:

```ts
interface ElectronLifecycleSource {
  isActive(): boolean;
  subscribe(listener: (active: boolean) => void): () => void;
}
```

## Vue and Taro

Vue exposes reactive refs around raw ViewModels. Taro reuses that bridge with page lifecycle handling;
see the [Vue/Taro guide](./vue-taro.md).

## Exported errors

`ViewModelError`, `ViewModelDisposedError`, `UnmanagedViewModelError`, `ViewModelRuntimeDisposedError`,
`ViewModelBindingDisposedError`, `ViewModelDependencyCycleError`, and `ViewModelSpecError` represent
synchronous validation failures. Notification/lifecycle/cleanup errors use `config.onError`.
See the [Flutter comparison](./flutter-comparison.md) for runtime-specific boundaries.
