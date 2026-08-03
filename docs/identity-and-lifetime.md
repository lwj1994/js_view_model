# Identity and Lifetime

[简体中文](./zh/identity-and-lifetime.md)

Instance sharing and disposal are determined by four things:

1. the `ViewModelRuntime`;
2. the Spec token;
3. the optional key;
4. the set of owner Bindings.

The Runtime is the maximum sharing boundary. The Spec token and key select an identity inside that Runtime. Bindings keep the current generation alive.

## A Spec is an identity declaration

Every new `viewModelSpec(...)` call creates a new token.

```ts
const firstSpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'primary',
});
const secondSpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'primary',
});
```

`firstSpec` and `secondSpec` do not share an instance. Their key strings match, but their tokens differ.

For a keyed identity, the cache key is conceptually:

```text
(runtime object, spec token, explicit key)
```

For an unkeyed identity, the cache key is conceptually:

```text
(runtime object, binding object, spec token, undefined)
```

This is why Specs should normally be stable module-level declarations:

```ts
export const sessionSpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'primary',
});
```

## Never create a Spec during render

This is incorrect:

```tsx
function Profile(): React.JSX.Element {
  const profile = useViewModel(viewModelSpec(() => new ProfileViewModel()));
  // ...
}
```

Every render creates a token and therefore a different identity. The Scope Binding retains acquired entries until the Binding is disposed, so this can accumulate generations and cause lifecycle churn rather than simply rebuilding one value.

Define the Spec outside render. If identity depends on business data, create and retain a stable declaration for that data instead of deriving a fresh Spec on every render.

## Unkeyed identity

```ts
const editorSpec = viewModelSpec(() => new EditorViewModel());
```

An unkeyed Spec is private to a Binding:

- repeated resolution from the same Binding returns the same current generation;
- a different Binding receives a different generation;
- sibling components in one Scope share because they use the same Scope Binding;
- a nested Scope receives a private generation because it creates another Binding;
- each parent ViewModel has a private dependency Binding, so unkeyed children are private to that parent generation.

Unkeyed identity is a good default for a page, window-local module, or private dependency subgraph.

## Keyed identity

```ts
const sessionSpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'primary-session',
});
```

Within one Runtime, Bindings resolving the same token and key share the same generation:

```ts
const runtime = new ViewModelRuntime();
const first = runtime.createBinding({ id: 'first' });
const second = runtime.createBinding({ id: 'second' });

const fromFirst = first.read(sessionSpec);
const fromSecond = second.read(sessionSpec);

console.log(fromFirst === fromSecond); // true
```

Keyed does not mean permanent. Unless `aliveForever` is enabled, the generation is scheduled for disposal after its last owner leaves.

Keys may be strings, numbers, or symbols. Prefer stable business identifiers. A new `Symbol()` is a new key, and a random or render-derived key defeats identity stability.

### `withKey`

`withKey` creates a Spec variant while preserving the original token:

```ts
const workerSpec = viewModelSpec(() => new WorkerViewModel());

const primaryWorkerSpec = workerSpec.withKey('primary');
const secondaryWorkerSpec = workerSpec.withKey('secondary');
```

Repeated `workerSpec.withKey('primary')` calls represent the same keyed identity because both token and key match. The builder is also the same; the key is not passed as a builder argument.

If construction itself needs an ID, retain a stable parameterized Spec declaration for each ID. Do not create a new uncached Spec every time a consumer asks for that ID.

## Runtime boundaries

The same Spec and key in two Runtime objects produce two instances:

```ts
const firstRuntime = new ViewModelRuntime();
const secondRuntime = new ViewModelRuntime();
const firstBinding = firstRuntime.createBinding();
const secondBinding = secondRuntime.createBinding();

const first = firstBinding.read(sessionSpec);
const second = secondBinding.read(sessionSpec);

console.log(first === second); // false

firstBinding.dispose();
secondBinding.dispose();
firstRuntime.dispose();
secondRuntime.dispose();
```

A Runtime cannot be shared across JavaScript realms. Electron main, preload, and renderer must use separate containers and communicate with serializable IPC data. Matching keys across those realms do not share object identity.

## Bindings are owners

Calling `read` or `watch` makes the Binding an owner of the resolved generation:

```ts
const binding = runtime.createBinding();
const viewModel = binding.read(spec);
```

The owner remains until one of these events:

- `binding.dispose()` releases all generations owned by that Binding;
- `runtime.recycle(...)` force-disposes a matching generation;
- `runtime.dispose()` ends the entire container.

Resolving the same generation repeatedly from one Binding does not create repeated owners. Switching an existing Binding entry from `read` to `watch` changes notification propagation, not identity.

### Binding IDs and bind callbacks

Every Binding has an ID. Defaults are unique. `onBind(bindingId)` runs when the first owner with that logical ID arrives, and `onUnbind(bindingId)` runs when the last owner with that logical ID leaves.

Custom duplicate IDs are reference-counted as one logical source even when represented by multiple Binding objects. Use stable, meaningful custom IDs only when that grouping is intentional.

## React Scope ownership

A `ViewModelScope` owns one stable Binding:

- components in the Scope resolve through that Binding;
- multiple hooks do not produce multiple `onBind` calls for the same generation and Binding ID;
- hook cleanup removes the hook subscription, not the Binding owner entry;
- Scope cleanup disposes the Binding and releases all of its entries.

Therefore, removing the last consumer component from an application-root Scope does not immediately release its ViewModel. The root Binding may still own it. Give screen-local modules an appropriate Scope/Binding boundary when release on screen unmount is required.

A root Scope with no injected Runtime creates and owns its Runtime. A nested Scope inherits the parent Runtime but creates a new Binding. A Scope receiving an explicit Runtime disposes its Binding but does not own final disposal of that Runtime.

## Dependency ownership

A managed parent receives its own dependency Binding. When the parent resolves a child through `viewModelBinding.read` or `watch`, that Binding owns the child and the Runtime records a parent-to-child edge.

The dependency edge keeps the child alive while the parent uses it. When the parent generation ends, its dependency Binding is disposed. Zero-owner, non-permanent children then become eligible for disposal.

Do not store a resolved child indefinitely. Store its Spec and resolve through a getter so a forced child recycle can yield the current generation.

## Ordinary automatic release

For a normal Spec, removing the last owner schedules disposal in a microtask. This small delay allows a release/reacquire sequence to cancel unnecessary destruction and supports React StrictMode coordination.

```ts
binding.dispose();

// The generation may still be alive here.
await Promise.resolve();
await Promise.resolve();

// It is now expected to be disposed if no owner reacquired it.
```

Do not couple production behavior to an exact number of microtasks. Tests may flush the queue before asserting final disposal; application code should respond to ownership and lifecycle, not poll `isDisposed`.

When the generation is disposed:

1. owners are unbound;
2. `onDispose` runs for an activated instance;
3. registered disposers run in reverse order;
4. the dependency Binding is disposed and exclusive zero-owner children are released;
5. surviving owners are notified that the generation changed.

The Runtime completes the old generation and its exclusive dependency tree before owners resolve a replacement. This prevents old and new generations from simultaneously holding one exclusive native or IPC resource.

## `aliveForever`

`aliveForever` prevents ordinary zero-owner release:

```ts
const telemetrySpec = viewModelSpec(() => new TelemetryViewModel(), {
  key: 'application-telemetry',
  aliveForever: true,
});
```

An `aliveForever` Spec must have an explicit key. Constructing one without a key throws `ViewModelSpecError`.

The option does not mean process-global or immortal:

- it applies only inside one Runtime;
- an abandoned render that never acquires its provisional generation is still cleaned up;
- `runtime.recycle(...)` can force-dispose it;
- `runtime.dispose()` always ends it.

Most application-lifetime modules do not need `aliveForever` when an application Binding already owns them. Use it only when the identity must survive a deliberate interval with zero owners.

## `recycle`

Recycle is forced invalidation, not ordinary release.

```ts
const recycled = runtime.recycle(sessionSpec);
```

It synchronously disposes every matching current generation in that Runtime and returns the number disposed. It ignores active owner counts and `aliveForever`.

You may target either a Spec or an instance:

```ts
runtime.recycle(viewModel); // Exactly that managed generation, if owned by this Runtime.
runtime.recycle(spec); // Every generation matching this Spec token and key.
```

This distinction is critical for unkeyed Specs. One Runtime may contain one unkeyed generation per Binding. `runtime.recycle(unkeyedSpec)` matches all of them because they share the token and the undefined key. Use `runtime.recycle(instance)` when only one private generation should be invalidated.

For a keyed Spec, recycle affects the shared generation used by every Scope, plain Binding, and parent dependency owner in that Runtime.

### What owners observe

Recycle does not mutate an old object into a new one. The old reference becomes permanently disposed.

- Mounted React hooks are notified and resolve a new generation.
- A plain Binding's `onUpdate` callback is notified and should resolve from the Spec again.
- A parent dependency getter resolves the new child generation on its next access.
- A long-lived cached instance remains stale and must not be used.

Use recycle for a real global invalidation such as logout, account replacement, or forced device disconnection. For a local change, prefer normal state updates, a different owner boundary, or a new business key.

Before recycling, ask:

- Is the identity shared across Scopes or parents?
- Does it own an exclusive dependency tree?
- Are asynchronous tasks holding the old reference?
- Do all owners accept simultaneous invalidation?

## Pause is not lifetime

Runtime pause leaves generations and owner edges intact. It invokes `onPause` on active instances and defers/coalesces Binding update delivery. Resume occurs only after the last pause token is removed.

Because pause belongs to the Runtime, every active generation in that Runtime is affected, not only those owned by the Scope that supplied a lifecycle source.

Pause does not prevent actions, state mutations, or direct instance subscriptions. A module must implement any resource suspension it requires in `onPause` and restore it in `onResume`.

## Summary table

| Declaration and owner state                | Sharing                                     | Zero-owner behavior                        |
| ------------------------------------------ | ------------------------------------------- | ------------------------------------------ |
| Unkeyed Spec                               | One generation per Binding                  | Scheduled disposal                         |
| Keyed Spec                                 | One generation per token + key in a Runtime | Scheduled disposal                         |
| Keyed `aliveForever` Spec                  | One generation per token + key in a Runtime | Retained until recycle or Runtime disposal |
| Same Spec in another Runtime               | Never shared with the first Runtime         | Managed independently                      |
| Same textual key on a different Spec token | Not shared                                  | Managed independently                      |

## Related guides

- [Getting started](./getting-started.md)
- [ViewModels and state](./view-models.md)
- [Dependency injection](./dependency-injection.md)
- [Testing](./testing.md)
