# Differences from Flutter `view_model`

[简体中文](./zh/flutter-comparison.md) · [Documentation index](./README.md)

This TypeScript package shares the architectural direction of
[`lwj1994/flutter_view_model`](https://github.com/lwj1994/flutter_view_model):
functional modules can be managed ViewModels, bindings own instances,
dependencies resolve lazily through ViewModel getters, and ordinary instances
dispose automatically.

It is not an API port. TypeScript runtime identity, React scheduling, and
React Native/Electron lifecycle constraints require different contracts.

## Concept mapping

| Flutter `view_model`          | TypeScript `view_model`                  | Important difference                                                                                 |
| ----------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `class X with ViewModel`      | `class X extends ViewModel`              | TypeScript uses inheritance, not a Dart mixin.                                                       |
| `StateViewModel<T>`           | `StateViewModel<TState>`                 | Equality defaults to `Object.is`; there is no global equality configuration.                         |
| `ViewModelSpec<T>`            | `ViewModelSpec<T>` / `viewModelSpec()`   | Pass the ViewModel class explicitly because TypeScript generics do not exist at runtime.             |
| `ViewModelBinding` host mixin | `runtime.createBinding()`                | Plain hosts explicitly own and dispose a Binding.                                                    |
| Widget mixins                 | Platform `ViewModelScope` + hooks        | Scope maps React commit/unmount to one Binding owner.                                                |
| `watch(spec)`                 | `binding.watch` / `useViewModel`         | Both own; watch also propagates ordinary notifications.                                              |
| `read(spec)`                  | `binding.read` / `useReadViewModel`      | Read still owns and still reacts to generation replacement where adapters require it.                |
| Selector widgets              | `useViewModelSelector`                   | Selector receives the ViewModel; equality defaults to `Object.is`.                                   |
| `listen` / state listeners    | Binding `listen*` methods                | Binding/handle cleanup is automatic; each method also returns a manual disposer.                     |
| Cached/tag lookup             | Binding cached methods                   | Targets are an explicit class or Spec; lookup never creates a missing generation.                    |
| Keyed sharing                 | Explicit type + key                      | Separate Specs with the same explicit class and key share only inside one Runtime.                   |
| Child getter DI               | `this.viewModelBinding.read/watch(spec)` | Getter access is forbidden in builders, constructors, React render, and selectors.                   |
| Parent source propagation     | Generation-owned dependency Binding      | Current external root Binding sources are mirrored to children and counted per ownership path.       |
| Synchronous notification      | Update propagation transaction           | Binding delivery is deduplicated by owner/callback identity across one complete synchronous cascade. |
| `recycle(vm)`                 | `runtime.recycle(vmOrSpec)`              | An unkeyed Spec target can recycle several Binding-private generations.                              |
| Pause/resume providers        | Runtime pause tokens                     | Pause is Runtime-wide, not route/ticker or Scope-local.                                              |

## Prefer explicit type + key

TypeScript generic types are erased, so the package cannot recover `T` from
`ViewModelSpec<T>`. Pass the ViewModel class as an explicit runtime identity:

```ts
const first = viewModelSpec(SessionViewModel, () => new SessionViewModel(), {
  key: 'session',
});
const second = viewModelSpec(SessionViewModel, () => new SessionViewModel(), {
  key: 'session',
});

binding.read(first) === binding.read(second);
```

Explicit type without a key remains private to one Binding. Explicit type with a
key is shared by Bindings in the same Runtime. `withKey` preserves the explicit
type identity:

```ts
const userSpec = viewModelSpec(UserViewModel, () => new UserViewModel());
const adaSpec = userSpec.withKey('ada');
const graceSpec = userSpec.withKey('grace');
```

The builder-only overload remains a compatibility fallback:

```ts
const legacySpec = viewModelSpec(() => new SessionViewModel());
```

Each independently created builder-only base Spec receives a unique token, so
separate builder-only Specs do not share even when their keys match. Keep such a
Spec stable at module scope, and prefer explicit type + key for shared identity.

## Synchronous propagation keeps Flutter's transaction semantics

`notifyListeners` opens the propagation transaction outside the whole
synchronous notification cascade. Direct listeners, dependency bubbling, and
nested synchronous notifications therefore participate in the same transaction.

Binding delivery is deduplicated by the pair of Binding owner identity and
callback identity. Reaching the same callback several times through one Binding
runs it once, while two distinct Bindings that reuse the same callback each run
it once. A parent generation also bubbles at most once in that transaction.
A later microtask or Promise continuation starts a new transaction.

Each parent generation owns one stable dependency Binding. When it resolves a
child, the parent's current external root Binding sources are mirrored to that
child, and later root additions/removals are synchronized. A direct ownership
source and every parent path are counted independently: the first source for a
Binding id triggers `onBind(id)`, and `onUnbind(id)` waits until its last source
is removed. `read` establishes this lifetime edge without ordinary notification
bubbling; `watch` also bubbles child notifications.

## Cached lookup and listeners preserve ownership

Normal dependency injection should retain a Spec and call `read(spec)` or
`watch(spec)`. The cached methods are advanced lookup-only APIs for a generation
already created elsewhere. Their target may be an explicit ViewModel class or a
Spec:

- `readCached` / `watchCached` return one lookup match and throw on a miss;
- `maybeReadCached` / `maybeWatchCached` return `undefined` on a miss;
- `readCachesByTag` / `watchCachesByTag` return all matches, or an empty array.

`tag` is only a grouping label and does not participate in identity. No cached
method runs a builder. A hit still binds the generation and creates the same
parent lifetime edge as Spec-based resolution. Only the `watch` variants bubble
ordinary child notifications.

`binding.listen`, `listenState`, and `listenStateSelect` resolve through a Spec
and install side-effect listeners without broad watch propagation. They are
automatically removed when the Binding or generation handle is disposed or
recycled, and each returned disposer can remove its listener earlier. The
lower-level `viewModel.subscribe` / `subscribeState` APIs remain manually owned.

## `update` does not notify

Flutter's convenience update API may automatically publish a change. The
TypeScript method has a narrower purpose: it attaches an action value to
notifications emitted synchronously inside the mutation.

```ts
this.update('cart.add', () => {
  this.items.push(item);
  this.notifyListeners();
});
```

Omitting `notifyListeners()` changes the field silently. `StateViewModel`
actions normally use `setState` or `updateState`, which do notify when equality
reports a new snapshot.

## Scope exists because React has render and commit phases

Flutter widget mixins and this package's React Scope/hooks solve similar owner
problems through different host lifecycles. React render can be replayed or
abandoned, so builders may prepare pure objects during render while ownership,
`onCreate`, and `onBind` start only after commit.

Scope is not required for application DI. Electron main, startup code,
background services, and tests use a plain Binding from the same core Runtime.

## APIs intentionally not carried over

This TypeScript package currently has no:

- `ViewModelSpec.arg/arg2/arg3/arg4`;
- proxy/override or code-generation annotations;
- `ChangeNotifierViewModel`;
- global `initialize`, `reset`, equality, logging, or error configuration;
- DevTools protocol;
- Flutter route/ticker lifecycle providers;
- Widget mixins.

Do not emulate these with undocumented imports. Build from the currently
exported core and platform APIs, or propose an explicit library change.

## Platform boundary

The TypeScript package serves React Native and Electron only. Electron main,
preload, and renderer remain separate realms; transfer serializable DTOs and
events over IPC. The internal shared React layer is not a public Web entry and
does not imply ordinary React Web, SSR, or RSC support.
