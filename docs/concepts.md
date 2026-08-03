# Core concepts

[简体中文](./zh/concepts.md) · [Documentation index](./README.md)

> This guide describes the current v0.1 alpha behavior. `view_model` is designed for React Native and Electron applications. It does not publish a general React Web entry point.

`view_model` combines application-level dependency injection, state propagation, and automatic lifetime management. The application object graph lives in a `ViewModelRuntime`. A React `ViewModelScope` is only an owner adapter: it connects one React subtree to a Runtime through a `ViewModelBinding`; it is not the DI container itself.

## The application object graph

A typical application has one Runtime per independently managed execution environment:

```text
Application composition root
└── ViewModelRuntime
    ├── plain ViewModelBinding (bootstrap, service, or Electron main)
    ├── React Scope Binding (application UI)
    ├── nested React Scope Binding (optional owner boundary)
    └── ViewModel generation
        └── dependency Binding
            └── child ViewModel generation
```

The Runtime is the maximum boundary for all of the following:

- keyed instance sharing;
- the managed dependency graph;
- generation numbers;
- force recycling;
- Runtime-level pause tokens;
- final disposal.

Two Runtime objects never share managed instances, even when they resolve the same Spec and key. In Electron, objects also cannot cross process boundaries: main and each renderer must use Runtime objects in their own JavaScript environments and communicate with serializable IPC messages.

## Runtime, Scope, Binding, Spec, and generation

| Concept            | Responsibility                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `ViewModelRuntime` | Owns managed instances, keyed caches, dependency edges, pause state, recycling, and final cleanup.                            |
| `ViewModelScope`   | Adapts a React subtree to a Runtime. It creates one stable Binding and supplies it to hooks.                                  |
| `ViewModelBinding` | Represents one owner. `read` and `watch` acquire instances; `dispose` releases everything acquired by that Binding.           |
| `ViewModelSpec<T>` | Declares a pure builder and the identity policy for one ViewModel family.                                                     |
| generation         | One concrete managed object created for a Spec identity. Recycling ends a generation; a later resolution creates another one. |

A root Scope without an injected Runtime creates and eventually disposes its own Runtime. A nested Scope reuses the parent Runtime by default but always creates a different Binding. An explicitly injected Runtime is owned by the caller, not by the Scope.

This distinction matters for application-level DI. A long-lived application
Binding can own an unkeyed graph for its own lifetime. Sharing one service
across separate plain/Scope/parent Bindings additionally requires the same
Runtime and an explicit key on the stable Spec. React nesting by itself does not
make a ViewModel global.

## Stable Specs are identity tokens

A Spec is not merely a factory wrapper. Every `ViewModelSpec` owns a unique runtime `token`, and identity is based on that token.

Declare Specs once at module scope:

```ts
import { ViewModel, viewModelSpec } from 'view_model/core';

class CartViewModel extends ViewModel {
  // ...
}

export const cartSpec = viewModelSpec(() => new CartViewModel(), {
  debugLabel: 'CartViewModel',
});
```

Do not create a Spec during React render:

```tsx
function CartScreen() {
  // Wrong: every render creates a new token and therefore a new identity.
  const cart = useViewModel(viewModelSpec(() => new CartViewModel()));
  return <CartView cart={cart} />;
}
```

The resolved TypeScript generic type is erased at runtime. Consequently, two independently constructed Specs do not share an instance merely because they use the same ViewModel class, builder, `debugLabel`, and key.

Identity rules are exact:

```text
unkeyed identity = one Spec token inside one Binding
keyed identity   = one Spec token + key inside one Runtime
```

`debugLabel` is diagnostic metadata and never participates in identity. `withKey(key)` creates another Spec that preserves the original token, which is useful when the same Spec family needs a keyed variant.

## Unkeyed, keyed, and aliveForever

### Unkeyed instances

An unkeyed Spec is private to the Binding that first resolves it:

- repeated resolution of the same stable Spec in one Binding returns the same generation;
- two Scope Bindings resolve isolated generations;
- a parent ViewModel's dependency Binding owns its own unkeyed generation;
- an unkeyed generation is normally disposed after its final owning Binding releases it.

This is the default for screen-local state and modules intended to be private to one parent generation.

### Keyed instances

An explicit key makes the instance shareable across Bindings in the same Runtime:

```ts
export const sessionSpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'primary-session',
  debugLabel: 'SessionViewModel',
});
```

Keyed does not mean permanent. The generation is still released after its last owner leaves unless `aliveForever` is enabled.

Use a key when the application intentionally needs one identity across UI Scopes, plain Bindings, or multiple parent modules. `ViewModelKey` is limited to `string | number | symbol`; prefer stable, business-meaningful primitive keys.

### `aliveForever`

`aliveForever` prevents ordinary zero-owner cleanup, but it does not make an instance independent of its Runtime:

```ts
export const telemetrySpec = viewModelSpec(() => new TelemetryViewModel(), {
  key: 'application-telemetry',
  aliveForever: true,
  debugLabel: 'TelemetryViewModel',
});
```

Every `aliveForever` Spec must have an explicit key. The Spec constructor rejects invalid configurations before the builder runs. An `aliveForever` generation still ends when:

- `runtime.recycle(...)` targets it;
- `runtime.dispose()` runs; or
- an abandoned render prepared it but never committed an owner.

Use this option only for intentionally retained application infrastructure. A normal keyed module is usually sufficient because owner Bindings already express its lifetime.

## Application-global and owner-local DI

For an application-global graph, create one Runtime at the composition root and pass that same Runtime to every owner that must participate:

```ts
const runtime = new ViewModelRuntime();
const bootstrapBinding = runtime.createBinding({ id: 'application-bootstrap' });

const session = bootstrapBinding.read(sessionSpec);
```

The same Runtime can be injected into the root platform Scope:

```tsx
<ViewModelScope runtime={runtime}>
  <Application />
</ViewModelScope>
```

The Scope contributes one React owner Binding. It does not replace or wrap the application DI graph. A plain Binding, a Scope Binding, and a ViewModel dependency Binding can all own the same keyed generation.

For owner-local state, leave the Spec unkeyed. Each Binding then gets an isolated generation even when all owners use the same Runtime.

## `watch` and `read`

Both operations resolve a Spec and establish lifetime ownership:

| Operation     | Creates when absent | Acquires for the Binding | React/plain owner update on ordinary notification | Observes generation disposal/recycle |
| ------------- | ------------------- | ------------------------ | ------------------------------------------------- | ------------------------------------ |
| `watch(spec)` | Yes                 | Yes                      | Yes                                               | Yes                                  |
| `read(spec)`  | Yes                 | Yes                      | No                                                | Yes                                  |

`read` never means "unmanaged" or "unbound." It is the right choice for commands and imperative collaboration when ordinary ViewModel notifications should not update the owner.

In React, use the corresponding hooks:

```tsx
const model = useViewModel(modelSpec);
const commands = useReadViewModel(modelSpec);
const title = useViewModelSelector(modelSpec, (vm) => vm.state.title);
```

`useReadViewModel` does not rerender for an ordinary `notifyListeners`, but a force recycle changes the generation snapshot and causes the hook to resolve the replacement generation.

`useViewModelSelector` subscribes to the ViewModel while returning a selected value. It uses `Object.is` by default and accepts an explicit equality function as its third argument. A new generation causes one update even when its selected value compares equal, ensuring the hook resubscribes to the correct object.

## Scope ownership is not hook ownership

React hooks subscribe during commit, but the Scope Binding is the owner. When an individual hook unmounts, its listener is removed; the Binding's ownership entry remains until the Scope itself is disposed or the generation is force-recycled.

This design gives one stable owner boundary to a React subtree and prevents transient component churn from repeatedly destroying application modules. If a feature needs a shorter independent lifetime, give it a nested Scope/Binding boundary or a separately managed plain Binding. Remember that a nested Scope sharing the same Runtime does not create a new global DI container.

## ViewModel modules and getter-based DI

Any feature, repository, coordinator, state holder, or platform capability may be modeled as a ViewModel. Parent modules resolve child modules through their generation-owned `viewModelBinding`:

```ts
const authSpec = viewModelSpec(() => new AuthViewModel(), {
  key: 'application-auth',
});

class OrdersViewModel extends ViewModel {
  private get auth(): AuthViewModel {
    return this.viewModelBinding.read(authSpec);
  }

  async refresh(): Promise<void> {
    const token = await this.auth.requireToken();
    await this.loadOrders(token);
  }

  private async loadOrders(_token: string): Promise<void> {
    // ...
  }
}
```

The getter declaration is lazy and creates nothing by itself. Once evaluated after attach:

1. the parent dependency Binding resolves the child;
2. the Runtime records a `parent generation -> child generation` edge;
3. the dependency Binding becomes a child owner;
4. the child cannot naturally dispose before the parent generation releases that Binding.

An unkeyed child is private to that parent generation's dependency Binding. A keyed child may also be owned by other parents, a Scope, or a plain Binding and can therefore outlive one parent.

Use `read` for imperative child calls. Use `watch` only when child notifications must bubble through `onDependencyNotify(child)` and then notify the parent. Synchronous propagation is transactionally deduplicated.

## Dependency access is commit-only

Spec builders and ViewModel constructors must remain pure. A ViewModel receives its dependency Binding only after construction, when the Runtime attaches the new generation. Resolve dependency getters only from committed ViewModel behavior, such as:

- actions invoked after mount/bootstrap;
- `onCreate` and later lifecycle callbacks;
- internal asynchronous workflows started after activation.

Do not resolve a dependency getter from:

- a Spec builder or ViewModel constructor;
- component render or JSX evaluation;
- a `useViewModelSelector` selector;
- another render-derived computation.

React render may be replayed or abandoned. UI code should select state already exposed by the parent rather than traversing and acquiring its child graph.

## The dependency graph must be acyclic

The Runtime rejects direct and indirect owner cycles. Unkeyed recursion is also detected through the active ancestor token lineage.

When two modules appear to require each other, prefer one of these designs:

- extract the shared capability into a third ViewModel;
- move orchestration into a higher-level coordinator;
- exchange events or ordinary function results instead of creating a reverse owner edge.

A diamond-shaped graph is valid. Shared child notifications are deduplicated within one synchronous propagation transaction.

## Generations and recycle

A generation is immutable as an object identity. There is no in-place replacement operation. After a generation is recycled, a later resolution of its stable Spec creates a new object with a new generation number and a fresh dependency Binding.

Avoid retaining ViewModel references in long-lived external fields across an operation that may recycle them. Resolve through the current Binding and stable Spec when a fresh generation may be required.

`runtime.recycle(viewModel)` targets one concrete generation. `runtime.recycle(spec)` targets every matching identity in that Runtime. For an unkeyed Spec, that can mean one generation per Binding because all of them share the same token but have private Binding-local entries.

Recycle ignores current owners and `aliveForever`. It is appropriate for deliberate application-wide invalidation such as logout or disconnect. For an independent replacement, a new business key is safer than force-recycling a shared generation.

## Design rules

- Put the application DI graph in a deliberately owned Runtime.
- Treat Scope as a React Binding adapter, not as the service container.
- Declare Specs once and preserve their tokens.
- Default to unkeyed owner-local modules; use explicit keys for intended Runtime-wide sharing.
- Use `watch` for reactive ownership and `read` for imperative ownership.
- Keep builders and constructors pure; start resources in `onCreate` and register cleanup with `addDispose`.
- Resolve child modules through parent getters after attach.
- Never use dependency getters during React render or selection.
- Use `aliveForever` and recycle only when their Runtime-wide effects are intentional.
- Do not import or document a `view_model/react` package entry point; it is intentionally not public.
