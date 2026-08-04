# Identity and Lifetime

[简体中文](./zh/identity-and-lifetime.md)

Instance sharing and disposal are determined by four things:

1. the `ViewModelRuntime`;
2. the explicit ViewModel type, or a compatibility token for a builder-only Spec;
3. the effective key;
4. the set of owner Bindings.

The Runtime is the maximum sharing boundary. With the recommended explicit-type API, a ViewModel identity inside one Runtime is its explicit ViewModel type plus its effective key. An explicit key is the effective key for a keyed identity; omitting it selects a Binding-private default key. Bindings keep the current generation alive.

## Explicit ViewModel types declare identity

Pass the ViewModel class as a runtime value when declaring a Spec:

```ts
const firstSpec = viewModelSpec(SessionViewModel, () => new SessionViewModel(), {
  key: 'primary',
});
const secondSpec = viewModelSpec(SessionViewModel, () => new SessionViewModel(), {
  key: 'primary',
});
```

`firstSpec` and `secondSpec` represent the same identity inside one Runtime because their explicit ViewModel type and key match. They therefore share the current generation even though they are different Spec objects.

Only the builder that wins the first cache miss constructs that generation. Do not give Specs for the same type and key conflicting builders or lifetime options.

The winning builder must return an instance whose prototype chain includes the explicit identity type. This also permits an abstract base ViewModel with a protected constructor to serve as the shared identity.

For a keyed identity, the cache key is conceptually:

```text
(runtime object, explicit ViewModel type, explicit key)
```

For an unkeyed identity, the cache key is conceptually:

```text
(runtime object, binding object, explicit ViewModel type, binding-private default key)
```

TypeScript generic parameters are erased, so the explicit class argument is what preserves type identity at runtime. `debugLabel` is diagnostic metadata and never participates in identity.

### Builder-only compatibility fallback

The previous builder-only form remains supported:

```ts
const firstLegacySpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'primary',
});
const secondLegacySpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'primary',
});
```

Each builder-only Spec receives an independent token. These two legacy Specs do not share, even though their builders return the same class and their keys match. This fallback preserves existing code; prefer the explicit-type form for new declarations.

### Keep Specs at module scope

Stable module-level Specs avoid render-time declaration allocation and keep the builder and options for an identity consistent:

```ts
export const sessionSpec = viewModelSpec(SessionViewModel, () => new SessionViewModel(), {
  key: 'primary',
});
```

## Never create a Spec during render

This is incorrect:

```tsx
function Profile(): React.JSX.Element {
  const profile = useViewModel(viewModelSpec(ProfileViewModel, () => new ProfileViewModel()));
  // ...
}
```

The explicit type prevents this example from intentionally selecting a new identity, but every render still allocates a new Spec and builder. React may replay or abandon renders, and the builder from the first cache miss wins. The builder-only fallback is more dangerous here because every call also creates an independent token and identity.

Define the Spec outside render so construction and options stay stable. If identity depends on business data, use a stable explicit key and retain the declaration rather than deriving a fresh Spec on every render.

## Unkeyed identity

```ts
const editorSpec = viewModelSpec(EditorViewModel, () => new EditorViewModel());
```

An unkeyed Spec is private to a Binding:

- repeated resolution of the same explicit type from one Binding returns the same current generation, even through different explicit Spec objects;
- a different Binding receives a different generation;
- sibling components in one Scope share because they use the same Scope Binding;
- a nested Scope receives a private generation because it creates another Binding;
- each parent ViewModel has a private dependency Binding, so unkeyed children are private to that parent generation.

Unkeyed identity is a good default for a page, window-local module, or private dependency subgraph.

## Keyed identity

```ts
const sessionSpec = viewModelSpec(SessionViewModel, () => new SessionViewModel(), {
  key: 'primary-session',
});
```

Within one Runtime, Bindings resolving the same explicit ViewModel type and key share the same generation, including when they use independently declared explicit Specs:

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

`withKey` creates a Spec variant while preserving its explicit ViewModel type identity:

```ts
const workerSpec = viewModelSpec(WorkerViewModel, () => new WorkerViewModel());

const primaryWorkerSpec = workerSpec.withKey('primary');
const secondaryWorkerSpec = workerSpec.withKey('secondary');
```

Repeated `workerSpec.withKey('primary')` calls represent the same keyed identity because both the explicit type and key match. For a builder-only compatibility Spec, `withKey` instead preserves that Spec's fallback token. The builder is also preserved; the key is not passed as a builder argument.

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

Root ownership is source-aware: every root Binding source currently owning the parent is propagated to children that parent has resolved, and later root bind/unbind changes are mirrored to those children in real time.

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
const telemetrySpec = viewModelSpec(TelemetryViewModel, () => new TelemetryViewModel(), {
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
runtime.recycle(spec); // Every generation matching this Spec identity and effective key.
```

This distinction is critical for unkeyed Specs. One Runtime may contain one unkeyed generation per Binding. `runtime.recycle(unkeyedSpec)` matches all generations for that Spec identity across their Binding-private effective keys. Use `runtime.recycle(instance)` when only one private generation should be invalidated.

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

| Declaration and owner state                       | Sharing                                               | Zero-owner behavior                        |
| ------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| Explicit-type unkeyed Spec                        | One generation per explicit type and Binding          | Scheduled disposal                         |
| Explicit-type keyed Spec                          | One generation per explicit type + key in a Runtime   | Scheduled disposal                         |
| Explicit-type keyed `aliveForever` Spec           | One generation per explicit type + key in a Runtime   | Retained until recycle or Runtime disposal |
| Separate explicit Specs with the same type + key  | Shared within one Runtime                             | Follows the shared generation              |
| Builder-only Specs with different fallback tokens | Not shared, even when their textual keys are the same | Managed independently                      |
| The same identity in another Runtime              | Never shared with the first Runtime                   | Managed independently                      |

## Related guides

- [Getting started](./getting-started.md)
- [ViewModels and state](./view-models.md)
- [Dependency injection](./dependency-injection.md)
- [Testing](./testing.md)
