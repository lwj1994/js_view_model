# ViewModels and State

[简体中文](./zh/view-models.md)

A ViewModel is a stateful application object managed by a `ViewModelRuntime`. It may represent UI state, but it can also represent an application session, device connection, repository coordinator, background synchronizer, Electron main-process service, or any other stateful module with an explicit lifetime.

React is not part of the base `ViewModel` contract. React Native and Electron renderer hooks are adapters over the same core notification and ownership model.

## `ViewModel`

Extend `ViewModel` when the module needs custom fields or notification behavior.

```ts
import { ViewModel, viewModelSpec } from '@lwjlol/view_model/core';

class ConnectionViewModel extends ViewModel {
  #status: 'disconnected' | 'connecting' | 'connected' = 'disconnected';

  public get status(): 'disconnected' | 'connecting' | 'connected' {
    return this.#status;
  }

  public connect(): void {
    if (this.#status !== 'disconnected') return;

    this.update('connection.connect', () => {
      this.#status = 'connecting';
    });
  }
}

export const connectionSpec = viewModelSpec(() => new ConnectionViewModel());
```

The public instance exposes:

- `version`: incremented whenever a live `notifyListeners` call starts notification delivery, even if a listener later throws;
- `isDisposed`: whether the current generation has ended;
- `isPaused`: whether its Runtime has entered the paused state;
- `subscribe(listener)`: a direct instance subscription that returns an unsubscribe function.

Notification, update and cleanup methods are public; lifecycle hooks and `assertAlive` are protected:

- `notifyListeners(action?)`;
- `update(action, mutation)`;
- `addDispose(cleanup)`;
- `assertAlive()`;
- the lifecycle callbacks described below.

### `update` notifies on successful completion

Synchronous success notifies before return; async success after completion. Failure emits no final
notification and does not roll back earlier writes. Use
`this.update('rename', () => { this.name = name; });` without a redundant notify.
Use `setState/updateState` directly for immutable state rather than wrapping them in update.

### Notification failures

Configure `ViewModel.initialize({ config: { onError } })` to report errors without interrupting
remaining listeners or cleanup. Reentrant state events are delivered in order. Business listeners
see every event; only root Binding visual refresh is coalesced.

## `StateViewModel<State>`

`StateViewModel` is the convenient choice for immutable snapshots.

```ts
import { StateViewModel, viewModelSpec } from '@lwjlol/view_model/core';

type ProfileState = Readonly<{
  displayName: string;
  saving: boolean;
}>;

class ProfileViewModel extends StateViewModel<ProfileState> {
  public constructor() {
    super({ displayName: '', saving: false });
  }

  public setDisplayName(displayName: string): boolean {
    return this.updateState((current) => ({ ...current, displayName }), 'profile.set-display-name');
  }

  public replace(state: ProfileState): boolean {
    return this.setState(state, 'profile.replace');
  }
}

export const profileSpec = viewModelSpec(() => new ProfileViewModel());
```

The protected state methods return whether the state changed:

- `setState(nextState, action?)` compares and replaces the snapshot;
- `updateState(updater, action?)` computes the next snapshot and delegates to `setState`.

Equality uses the explicit comparator, then global configuration, then `Object.is`. Mutating an object in place and passing the same reference will not notify:

```ts
// Do not do this.
const sameObject = this.state;
sameObject.items.push(item);
this.setState(sameObject); // Object.is sees the same reference.
```

Use immutable replacement instead:

```ts
this.updateState((current) => ({
  ...current,
  items: [...current.items, item],
}));
```

A subclass may pass a custom equality function to `super(initialState, equals)`. The equality function must be deterministic and should be cheap enough to run for every attempted state replacement.

### State subscriptions outside React

`subscribeState` reports both snapshots and returns an unsubscribe function:

```ts
const unsubscribe = profile.subscribeState(({ previous, current }) => {
  auditProfileChange(previous, current);
});

// Later:
unsubscribe();
```

`subscribeState` is a direct instance subscription. Runtime pause does not defer it. If a plain host needs pause-aware render scheduling, use a watched Binding with `onUpdate` instead.

## Construction must remain pure

The Spec builder and ViewModel constructor may run while React is rendering. A concurrent or Suspense render may be abandoned, and its provisional generation may be cleaned up without ever being activated.

Safe constructor work includes:

- assigning primitive values and immutable initial state;
- storing injected plain objects or Specs;
- creating in-memory collections that require no external cleanup.

Unsafe constructor work includes:

- timers;
- network, database, IPC, or device connections;
- event or native subscriptions;
- file handles;
- resolving another ViewModel through a Binding;
- dispatching application actions.

Put resource acquisition in `onCreate` and register cleanup immediately.

## Resource lifecycle

```ts
interface FeedPort {
  subscribe(listener: (items: readonly string[]) => void): () => void;
  pause(): void;
  resume(): void;
}

class FeedViewModel extends StateViewModel<readonly string[]> {
  public constructor(private readonly feed: FeedPort) {
    super([]);
  }

  protected override onCreate(): void {
    const unsubscribe = this.feed.subscribe((items) => {
      this.setState(items, 'feed.items');
    });
    this.addDispose(unsubscribe);
  }

  protected override onPause(): void {
    this.feed.pause();
  }

  protected override onResume(): void {
    this.feed.resume();
  }
}
```

`addDispose` stores a cleanup for the end of the current generation. Registered cleanups run in reverse registration order, after `onDispose`. The function returned by `addDispose` unregisters that cleanup; it does not execute the cleanup.

Register cleanup as soon as a resource is acquired. Hook failures are reported without automatic rollback; cleanup runs when the generation ends.

## Lifecycle callbacks

### `onCreate()`

Called once when the generation is first acquired by a Binding. It is the correct place to start resources that belong to the whole generation.

If the Runtime is already paused, acquisition calls `onCreate`, then `onPause`, before completing the bind.

### `onBind(bindingId)`

Called when the first owner with a logical Binding ID binds the generation. Several hooks inside one Scope use one Binding, so they do not produce one `onBind` call per hook.

Two Binding objects may deliberately use the same custom ID. In that case, `onBind` and `onUnbind` are reference-counted by that logical ID.

Use `onBind` only for work that genuinely belongs to a logical owner source. Generation-wide resources belong in `onCreate`.

### `onUnbind(bindingId)`

Called when the last owner with that logical Binding ID leaves. Removing an individual React hook listener does not necessarily unbind the Scope's Binding; the owner remains until the Binding itself is disposed or the generation is recycled.

### `onPause()` and `onResume()`

Called on active instances when the Runtime transitions between active and paused. Multiple pause sources are aggregated by token, so `onResume` runs only after the last pause reason is removed.

Pause is not disposal. The instance and dependency graph remain alive.

Pause also does not prevent methods, `setState`, `notifyListeners`, direct `subscribe`, or `subscribeState` from running. It lets the module suspend its own resources and makes the Runtime defer/coalesce Binding and React update callbacks until resume.

### Dependency changes

Watch automatically notifies the parent; no extra hook is needed. For business reactions install
`this.viewModelBinding.listen(childSpec, callback)` in `onCreate`; Binding cleanup is automatic.

### `onDispose()`

Called once when an activated generation ends. At this point disposal has already begun and `isDisposed` is true. Do not call `viewModelBinding`, `addDispose`, state mutation methods, or other APIs that require an alive instance from `onDispose`.

Use `onDispose` for final synchronous work on fields already held by the instance. Prefer registering resource cleanups earlier with `addDispose`; those cleanups run immediately after `onDispose`.

A provisional generation that was constructed but never acquired does not run `onCreate` or `onDispose`. This is another reason constructors must not acquire resources.

### Lifecycle callbacks are synchronous

The callback signatures return `void`, and the Runtime does not await promises returned accidentally by an `async` override. Start an explicitly managed task if necessary, store its cancellation mechanism, and ensure disposal can stop or invalidate it.

## Disposed generations

Recycle or final release ends a generation. Late state writes and notify are ignored; updateState does not run its updater. New subscriptions, update and dependency resolution still reject disposed generations.

Do not retain a ViewModel reference in a long-lived service and assume it will remain current. Retain a stable Spec and resolve it from the current Binding when needed, especially across explicit recycle.

Automatic release after the last owner leaves is scheduled through a microtask. Immediately after `binding.dispose()`, a non-`aliveForever` instance may not yet report `isDisposed`. `runtime.recycle(...)` and `runtime.dispose()` force disposal synchronously.

## Methods passed as callbacks

A normal JavaScript prototype method loses `this` when passed without a receiver. Use an arrow field or an explicit wrapper for UI callbacks:

```ts
public readonly submit = (): void => {
  this.updateState((state) => ({ ...state, saving: true }), 'profile.submit');
};
```

```tsx
<Button title="Submit" onPress={profile.submit} />
```

Alternatively:

```tsx
<Button title="Submit" onPress={() => profile.submit()} />
```

## Related guides

- [Getting started](./getting-started.md)
- [Dependency injection](./dependency-injection.md)
- [Identity and lifetime](./identity-and-lifetime.md)
- [Testing](./testing.md)
