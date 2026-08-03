# Dependency Injection

[简体中文](./zh/dependency-injection.md)

Dependency injection in `view_model` is a core Runtime feature. It is not tied to a component tree and is not limited to UI-facing ViewModels.

An application may use the dependency graph for sessions, repositories, native bridges, device connections, coordinators, background work, or Electron main-process services. React Native and Electron renderer Scopes only adapt a React owner to the same core graph.

## The four roles

### `ViewModelSpec<T>`

A Spec is a stable declaration of how to construct a ViewModel and how to identify it. Application modules export Specs so consumers depend on declarations rather than manually constructing managed instances.

```ts
export const sessionSpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'primary-session',
  debugLabel: 'Session',
});
```

### `ViewModelRuntime`

A Runtime stores managed generations, keyed caches, dependency edges, pause state, and owner relationships. It is the maximum sharing boundary.

### `ViewModelBinding`

A Binding is an owner and resolver. Plain hosts create one with `runtime.createBinding()`. Each React Scope owns one internally.

### `ViewModel.viewModelBinding`

After a ViewModel has been built and attached, the Runtime gives it a private dependency Binding. The parent uses this Binding to resolve children. Those resolutions create explicit parent-generation to child-generation edges.

## Application-level composition without React

Create an application Runtime and root Binding when the dependency container must exist independently of UI.

```ts
import { ViewModel, ViewModelRuntime, viewModelSpec, type ViewModelSpec } from 'view_model/core';

class SessionViewModel extends ViewModel {
  public async requireAccessToken(): Promise<string> {
    return 'token';
  }
}

class SyncViewModel extends ViewModel {
  public constructor(private readonly dependency: ViewModelSpec<SessionViewModel>) {
    super();
  }

  private get session(): SessionViewModel {
    return this.viewModelBinding.read(this.dependency);
  }

  public async authorizationHeader(): Promise<string> {
    const accessToken = await this.session.requireAccessToken();
    return `Bearer ${accessToken}`;
  }
}

const sessionSpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'primary-session',
});
const syncSpec = viewModelSpec(() => new SyncViewModel(sessionSpec), {
  key: 'application-sync',
});

const runtime = new ViewModelRuntime();
const application = runtime.createBinding({ id: 'application' });

const sync = application.read(syncSpec);
const authorization = await sync.authorizationHeader();

application.dispose();
runtime.dispose();
```

Passing a Spec into a constructor is safe: a Spec is an inert declaration. Resolving the child in that constructor would not be safe. `viewModelBinding` is unavailable until the Runtime has finished the builder and attached the new instance.

The root Binding retains `SyncViewModel`. When `authorizationHeader` first accesses `session`, the parent's dependency Binding retains `SessionViewModel`. The child cannot be automatically released before that parent edge is removed.

## Getter-based child resolution

Use a getter so every access resolves the current generation:

```ts
class InboxViewModel extends ViewModel {
  public constructor(private readonly sessionDeclaration: ViewModelSpec<SessionViewModel>) {
    super();
  }

  private get session(): SessionViewModel {
    return this.viewModelBinding.read(this.sessionDeclaration);
  }

  public async authorizationHeader(): Promise<string> {
    const accessToken = await this.session.requireAccessToken();
    return `Bearer ${accessToken}`;
  }
}
```

Do not cache the resolved child in a long-lived field:

```ts
// Avoid this pattern.
#session: SessionViewModel | undefined;

private get session(): SessionViewModel {
  return (this.#session ??= this.viewModelBinding.read(sessionSpec));
}
```

An explicit recycle permanently disposes the old child generation. A getter backed by the Binding can resolve the replacement; a cached instance remains stale and throws when an action asserts that it is alive.

The Runtime already caches the current result according to the Spec identity, so application-level instance caching is unnecessary.

## `read` versus `watch` dependencies

Both modes:

- resolve or create the child;
- make the dependency Binding an owner;
- add a parent-to-child lifetime edge;
- keep the child alive until the edge is released;
- participate in cycle detection;
- let forced child disposal invalidate the parent's dependency entry.

Their ordinary-notification behavior differs:

| Parent getter                            | Child ordinary notification | Parent behavior                                                                 |
| ---------------------------------------- | --------------------------- | ------------------------------------------------------------------------------- |
| `this.viewModelBinding.read(childSpec)`  | Does not bubble             | Parent remains retained but is not notified for the child update                |
| `this.viewModelBinding.watch(childSpec)` | Bubbles                     | Runtime invokes `parent.onDependencyNotify(child)` and then notifies the parent |

Use `read` when the parent calls child actions or reads the child only during an imperative operation.

```ts
private get session(): SessionViewModel {
  return this.viewModelBinding.read(sessionSpec);
}
```

Use `watch` when changes in the child must invalidate or wake the parent:

```ts
class NetworkCoordinator extends ViewModel {
  public constructor(
    private readonly connectivityDeclaration: ViewModelSpec<ConnectivityViewModel>,
  ) {
    super();
  }

  private get connectivity(): ConnectivityViewModel {
    return this.viewModelBinding.watch(this.connectivityDeclaration);
  }

  protected override onCreate(): void {
    // Establish monitoring only after this parent has been acquired.
    void this.connectivity;
  }

  protected override onDependencyNotify(_child: ViewModel): void {
    // Reconcile generation-owned resources if needed.
    // The Runtime notifies this parent automatically after this returns.
  }
}
```

Do not call `notifyListeners` in `onDependencyNotify` merely to forward the same child event. The Runtime performs that propagation. If the callback also commits parent state with `setState`, that state commit emits its own notification.

## When dependency getters may be used

A dependency getter may be used only after the parent has been attached and acquired. Safe call sites include:

- a ViewModel action invoked after resolution;
- `onCreate`;
- `onBind`;
- `onPause` and `onResume`;
- `onDependencyNotify`;
- other internal work that is known to run after commit/acquire.

`viewModelBinding` is still technically available during `onUnbind`, but teardown code should not establish a new dependency merely because an owner is leaving. Resolve required dependencies earlier and register cleanup against generation-owned resources.

Do not use it in:

- the Spec builder;
- the ViewModel constructor;
- React render or JSX;
- a `useViewModelSelector` selector;
- any render-derived helper;
- `onDispose`.

`onDispose` begins after the ViewModel has been marked disposed, so `viewModelBinding` is no longer available. Register cleanups earlier with `addDispose`, or clean up fields already owned by the instance without resolving new dependencies.

### Why render access is forbidden

React render may be repeated, interleaved, suspended, or abandoned. Hook internals can prepare a pure parent object during render without creating an owner. A parent dependency getter calls `read` or `watch`, which acquires a child and establishes a real graph edge. That is a commit-time side effect and must not be triggered by JSX or a selector.

Expose data needed by the UI on the parent itself. Let post-commit actions or dependency notifications synchronize that parent-owned state.

## Unkeyed children are private to the parent Binding

An unkeyed identity is cached per Binding. A Scope Binding and every parent dependency Binding are different owners.

```ts
const localCacheSpec = viewModelSpec(() => new LocalCacheViewModel());
```

If two parent generations each resolve `localCacheSpec`, they receive different children because each parent owns a different dependency Binding. This is useful for private subgraphs.

Use a keyed Spec when multiple parents or Scopes in one Runtime must share the same child:

```ts
const sharedCacheSpec = viewModelSpec(() => new SharedCacheViewModel(), {
  key: 'application-cache',
});
```

The key is not sufficient by itself. The Spec token and key together form identity. Two independently created Specs with the same key do not share.

## Connecting React owners to an application container

Within one realm, a React Scope can receive an application Runtime:

```tsx
<ViewModelScope runtime={applicationRuntime}>
  <RootNavigator />
</ViewModelScope>
```

The Scope creates its own Binding. Therefore:

- it shares a keyed application Spec with a plain application Binding when token and key match;
- it receives a private instance for an unkeyed Spec;
- disposing the Scope releases only the Scope Binding;
- the code that created `applicationRuntime` remains responsible for disposing it.

Without an injected Runtime, a root Scope creates and owns one. A nested Scope inherits the parent Runtime but creates a separate Binding.

Scope is an ownership adapter, not a service locator requirement. Non-React modules should receive Specs or plain ports through ordinary module composition and resolve managed dependencies from their own ViewModel Binding.

## Runtime pause affects the whole graph

Platform Scope lifecycle is connected to `runtime.pause(token)` and `runtime.resume(token)`. Pause state belongs to the Runtime, not to one Binding.

Consequently, a nested Scope that inherits its parent's Runtime cannot use a navigation lifecycle source to pause only the nested page graph. Its inactive token pauses every active generation in that Runtime, including generations owned by parent or sibling Bindings.

For page-local behavior, either:

- model focus as ordinary state or an action consumed by that page ViewModel; or
- use a separate Runtime and manage that Runtime's disposal explicitly.

Multiple independent pause sources must use distinct stable tokens. The platform adapters do this automatically. The no-argument core `pause()` uses one shared default token and is idempotent, not reference-counted.

## Dependency cycles

The dependency graph must be acyclic. The Runtime rejects direct and indirect cycles with `ViewModelDependencyCycleError`.

```text
Orders -> Session -> Orders
```

Resolve a cycle by changing the architecture:

- extract shared behavior into a third dependency;
- move orchestration into a higher-level coordinator;
- pass immutable data or a plain function instead of a managed back-reference;
- publish an event through a deliberately one-way boundary.

Do not hide a cycle by caching instances or constructing one dependency manually. That bypasses ownership and leaves disposal order undefined.

## Runtime and realm boundaries

A Runtime is the largest sharing boundary, but it is still an in-memory JavaScript object. Sharing requires the same Runtime object in the same realm.

- Separate Runtime instances never share generations.
- Electron main, preload, and renderer are different realms.
- Separate Electron renderer processes cannot share a Runtime.
- Worker threads and other isolated JavaScript contexts cannot share managed object identity.
- A key string with the same text in another Runtime or realm does not create global sharing.

Use IPC or another explicit transport between realms. Send serializable DTOs and events, then let each realm maintain its own Runtime and ViewModels.

## Related guides

- [Getting started](./getting-started.md)
- [ViewModels and state](./view-models.md)
- [Identity and lifetime](./identity-and-lifetime.md)
- [Testing](./testing.md)
