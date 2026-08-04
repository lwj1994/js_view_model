# Lifecycle, React commit, and StrictMode

[简体中文](./zh/lifecycle.md) · [Documentation index](./README.md)

> This guide describes the supported lifecycle behavior for React Native and Electron applications.

Lifecycle is managed at two related levels:

- a `ViewModelRuntime` owns generations, dependency edges, and Runtime-wide pause state;
- each `ViewModelBinding` contributes one owner relationship and releases it when the Binding is disposed.

A React `ViewModelScope` adapts a subtree to this model by creating one Binding. It is not a separate DI container unless it is also given a separate Runtime.

## Lifecycle overview

A normal React-managed generation follows this sequence:

```text
stable ViewModelSpec
  -> render calls prepare
  -> pure builder and constructor may create a provisional generation
  -> Runtime attaches the generation to its dependency Binding
  -> hook subscribe runs during commit
  -> Scope Binding acquires the generation
  -> onCreate()
  -> onPause() if the Runtime is already paused
  -> onBind(bindingId)
  -> notifications, state changes, and dependency propagation
  -> hook cleanup removes only that hook subscription
  -> Scope cleanup disposes its Binding
  -> onUnbind(bindingId)
  -> final owner leaves
  -> deferred zero-owner disposal
  -> onDispose()
  -> registered cleanup functions in reverse order
```

The sequence changes only when the generation is force-recycled or its Runtime is disposed. Those operations remove all owners and end the generation even when ordinary lifetime rules would keep it alive.

## Construction is provisional

`binding.prepare(spec)` is the render-safe planning operation used by the platform hooks. It may execute the Spec builder and the ViewModel constructor, but it does not:

- acquire a Binding owner;
- call `onCreate`;
- call `onBind`;
- establish a committed parent-to-child owner edge.

The builder and constructor must therefore be pure object construction. They may initialize in-memory fields, but they must not start:

- network requests or sockets;
- timers or background loops;
- Electron IPC subscriptions;
- React Native native-module subscriptions;
- file handles, ports, or database transactions;
- child ViewModel resolution.

Start committed resources in `onCreate` or in an action invoked after commit, then register deterministic cleanup with `addDispose`.

```ts
class ConnectionViewModel extends ViewModel {
  protected override onCreate(): void {
    const subscription = connectionEvents.subscribe(() => {
      this.notifyListeners('connection-event');
    });

    this.addDispose(() => subscription.unsubscribe());
  }
}
```

If a render creates a provisional generation but never commits it, the Runtime schedules that zero-owner generation for cleanup at the next microtask. This also applies to `aliveForever`: an abandoned render is not a legitimate permanent owner.

If React later commits after a provisional generation has already been cleaned up, the generation snapshot changes. The hook prepares again and synchronously resubscribes to the current generation rather than retaining the abandoned object.

## Render and commit are separate phases

React may replay, interrupt, or abandon render. Only the `useSyncExternalStore` subscription installed during commit acquires the Scope Binding's owner relationship.

The platform hooks use this separation as follows:

| Phase                  | Allowed behavior                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| render / snapshot read | Pure Spec preparation and pure selection from the parent ViewModel's exposed data.             |
| commit subscription    | Acquire owner, activate the generation, run `onCreate`, and run `onBind`.                      |
| effect/Scope cleanup   | Remove hook listeners; later dispose the Scope Binding when the owner boundary truly unmounts. |

A parent ViewModel's dependency getter is not render-safe. It calls `viewModelBinding.read/watch`, which performs a real acquire. Do not read such a getter from JSX, component render, or a `useViewModelSelector` selector. Let the parent expose the derived state that the UI needs.

## Scope Binding lifetime versus hook subscription lifetime

Each Scope has one stable Binding. All hooks below that Scope acquire through that same owner:

```text
ViewModelScope
└── one ViewModelBinding
    ├── useViewModel(spec) subscription
    ├── useReadViewModel(spec) lifecycle subscription
    └── useViewModelSelector(spec, selector) subscription
```

Removing one hook only removes its subscription record. It does not release the Binding's acquired ViewModel entry. The owner relationship remains until:

- the Scope Binding is disposed;
- the Runtime force-recycles the generation; or
- the Runtime itself is disposed.

This makes the Scope a stable React owner adapter and avoids destroying application modules during ordinary component churn. If a feature needs an independent owner lifetime, create an intentional Binding boundary. A nested Scope creates a new Binding, but it still shares the parent's Runtime unless a different Runtime is injected.

## StrictMode behavior

React StrictMode may run extra renders and an effect `setup -> cleanup -> setup` sequence in development. `view_model` handles this without treating the probe cleanup as a real application shutdown:

1. render preparation does not activate or bind the provisional generation;
2. the first committed hook subscription performs the acquire;
3. Scope cleanup is delayed by one microtask;
4. the matching StrictMode setup cancels that pending Binding disposal;
5. a real unmount leaves the task uncancelled and releases the Binding;
6. a Runtime owned by the root Scope is disposed one additional microtask later, allowing nested shared Bindings to release first.

The lifecycle source uses a similar cancellable microtask when it removes its pause token. This prevents a StrictMode cleanup/setup probe from producing a false `onResume -> onPause` transition while the application is actually inactive.

Application code must still be idempotent. Do not infer production instance counts from constructor calls observed in StrictMode, and ensure every external resource has a cleanup path.

## Activation and Binding callbacks

The ViewModel hooks have precise meanings:

### `onCreate()`

Runs once when the first Binding acquires a provisional generation. The object has already been attached to its generation-owned dependency Binding, so getter-based dependency resolution is available here.

If `onCreate` throws, acquisition fails and the Runtime disposes the failed generation and its dependency scope before rethrowing.

### `onBind(bindingId)`

Runs when a Binding id first becomes an owner of the generation. A keyed generation can receive several ids from React Scopes, plain Bindings, or parent dependency Bindings.

### `onUnbind(bindingId)`

Runs when that Binding id releases the generation. It does not mean the generation is about to dispose: other Bindings may still own it, or it may be retained by `aliveForever`.

### `onPause()` and `onResume()`

Run only on a Runtime transition between active and paused. Multiple pause tokens are aggregated, so adding a second token does not call `onPause` again, and removing one of several tokens does not call `onResume`.

### `onDispose()`

Runs once when the current generation permanently ends. The ViewModel is already marked disposed, so it must not resolve new dependencies or emit new state.

After `onDispose`, cleanup functions registered with `addDispose` run in reverse registration order. The Runtime attempts all cleanup paths and aggregates multiple failures in `AggregateError` instead of abandoning the remaining cleanup.

## Natural zero-owner disposal

When a Binding releases a normal generation, the Runtime first calls `onUnbind`. If no owners remain and `aliveForever` is false, disposal is queued in a microtask.

This small deferral allows an immediate reacquire of the same generation to cancel pending disposal. It does not make the instance generally long-lived: if no owner returns, the generation is removed from its cache and disposed.

Disposal of a parent generation also disposes its generation-owned dependency Binding. Every child edge owned only through that Binding is released. A keyed child or a child owned through another parent/direct Binding may continue living.

An `aliveForever` generation skips natural zero-owner disposal. It still ends on explicit recycle or Runtime disposal.

## Notifications and generation snapshots

`notifyListeners(action?)` increments a ViewModel version and synchronously enters the Runtime propagation transaction. Within one transaction, the Runtime deduplicates:

- repeated notification delivery for the same handle;
- parent dependency bubbling;
- the same queued owner callback.

`watch` snapshots include the ViewModel version. `read` snapshots include only generation/lifecycle identity. Therefore:

- `useViewModel` rerenders for ordinary notifications;
- `useReadViewModel` does not rerender for ordinary notifications;
- both hooks update after force recycle because the generation changes;
- `useViewModelSelector` suppresses equal selected values, except that a new generation still forces one resubscription update.

`ViewModel.subscribe` and `StateViewModel.subscribeState` are direct subscriptions. They are invoked by the ViewModel itself and are not automatically owned by a Binding. Keep the returned unsubscribe function and clean it up explicitly.

## Runtime-level pause tokens

Pause is a property of `ViewModelRuntime`, not of a Scope or individual ViewModel owner.

```ts
const applicationBackground = Symbol('application-background');
const rendererHidden = Symbol('renderer-hidden');

runtime.pause(applicationBackground);
runtime.pause(rendererHidden);
runtime.resume(applicationBackground); // Still paused by rendererHidden.
runtime.resume(rendererHidden); // Now the Runtime resumes.
```

The first token performs the active-to-paused transition and calls `onPause` on every activated generation. The last token removal calls `onResume` and flushes queued Binding/hook callbacks.

While paused:

- state and ViewModel actions may continue running;
- ViewModel versions continue changing;
- parent dependency propagation may continue;
- Binding-delivered owner callbacks are coalesced until resume;
- direct `subscribe`/`subscribeState` callbacks are not paused by the Runtime.

This distinction prevents background UI churn without pretending that the application graph has stopped executing.

Every lifecycle source must keep one stable token for its subscription lifetime. Cleanup removes only that source's token and cannot resume a Runtime that another source still pauses.

### A Scope lifecycle affects the whole Runtime

`ViewModelScope.lifecycle` is an adapter into `runtime.pause(token)` and `runtime.resume(token)`. A nested Scope that shares its parent's Runtime does not receive isolated pause state. If its lifecycle becomes inactive, every activated ViewModel in that Runtime is paused.

For page focus behavior, choose deliberately:

- use a separate Runtime if the entire page graph should pause independently;
- keep one application Runtime and model focus as ordinary state if only page-specific work should change;
- use a shared Runtime lifecycle source only when pausing the whole application graph is intended.

## React Native lifecycle

The React Native Scope converts `AppState` into a lifecycle source:

- `active` means active;
- `inactive`, `background`, `unknown`, and any other value mean inactive.

The root Scope's lifecycle token therefore pauses the entire root Runtime when the application leaves the foreground. React Navigation blur is not an unmount and is not included automatically.

## Electron renderer lifecycle

The Electron renderer source considers the Runtime active only when both conditions hold:

- the renderer window is focused;
- `document.visibilityState` is not `hidden`.

A blur or hidden document pauses the Runtime. It resumes only after focus and visibility are both active again. If neither `window` nor `document` is available, the default source is active and installs no listeners.

Electron main has no React lifecycle adapter. Its owner must call `runtime.pause/resume` from explicit application events when that behavior is desired.

## Force recycle

`runtime.recycle(viewModel)` ends one concrete generation. `runtime.recycle(spec)` ends every current handle in that Runtime with the Spec's resolved identity and key. Explicit-type Specs therefore share the type identity, while builder-only Specs use their compatibility token. An unkeyed Spec may recycle one private generation per Binding.

Recycle:

1. marks the generation disposed and removes it from caches;
2. calls `onUnbind` for every current owner;
3. runs `onDispose` and registered cleanup;
4. disposes the old dependency Binding and releases child edges;
5. notifies surviving owner Bindings that their handle ended;
6. lets the next stable-Spec resolution create a fresh generation.

The old generation is fully cleaned before owners resolve a new one. This prevents old and new objects from simultaneously holding the same IPC channel, native subscription, port, or other exclusive resource.

Recycle ignores ordinary ownership and `aliveForever`, so use it only for deliberate shared invalidation. Prefer a new business key when old and new generations should coexist during a transition.

## Runtime and application shutdown

`runtime.dispose()` is the final boundary operation. It:

- marks the Runtime disposed;
- clears pause state and queued resume callbacks;
- force-disposes every generation, including `aliveForever` instances;
- clears keyed caches and dependency edges;
- rejects later creation or acquisition.

For an injected Runtime, the application composition root is responsible for disposing React owner Bindings first and the Runtime last. A root Scope that created its own Runtime performs this order automatically.

In Electron main, use an explicit shutdown path:

```ts
const runtime = new ViewModelRuntime();
const binding = runtime.createBinding({ id: 'electron-main' });

app.on('before-quit', () => {
  binding.dispose();
  runtime.dispose();
});
```

Both operations are idempotent. Cleanup implementations should be idempotent as well.
