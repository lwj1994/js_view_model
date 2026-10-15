# Flutter alignment and migration

[简体中文](./zh/flutter-comparison.md) · [Documentation index](./README.md)

The shared-core contract is aligned to `flutter_view_model` **1.2.1**, pinned to
[`c5e57d8`](https://github.com/lwj1994/flutter_view_model/tree/c5e57d8cb28922497901cf2b9ffb082221771ad3).
This includes PR #82 and the subsequent ownership and reentrant-state fixes, not just API names.
The changes below are **unreleased**; npm `0.3.1` does not contain them.

## Shared-core coverage

| Flutter contract                                        | JavaScript implementation                                                                                  | Regression evidence                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Type + effective key; unkeyed per Binding               | Explicit class token, object/primitive keys, O(1) owned-handle reuse                                       | `identity.test.ts`, `diagnostics.test.ts`                                        |
| `ViewModelSpec.arg/arg2/arg3/arg4`                      | Typed callable families; arguments configure construction, not identity                                    | `spec-overrides.test.ts`                                                         |
| Override/proxy resolution                               | Restorable `overrideWith`, legacy `setProxy/clearProxy`, cycle rejection, effective key/tag/lifetime       | `spec-overrides.test.ts`                                                         |
| Asynchronous scoped overrides                           | Explicit isolated Runtime passed to callback; see boundary below                                           | `spec-overrides.test.ts`                                                         |
| Getter DI, `read`/`watch`, read-to-watch upgrade        | Stable generation-owned Binding; no build-pass pruning                                                     | `dependencies.test.ts`, `flutter-parity.test.ts`                                 |
| Every dependency notification; root refresh coalescing  | Parent notifications and business reactions are not deduplicated; one root refresh request per transaction | `notifications.test.ts`, `flutter-parity.test.ts`                                |
| Ordered state changes and listener removal              | FIFO state events under synchronous reentry, no stale diffs from broad notify                              | `flutter-parity.test.ts`, `flutter-api.test.ts`                                  |
| `listenState(previous, current)` and selected reactions | Positional typed values, no artificial null, Binding-owned cleanup                                         | `flutter-api.test.ts`                                                            |
| `update`, listeners, state history, equality            | Successful sync/async update auto-notifies; local/global/`Object.is` equality                              | `flutter-api.test.ts`, `electron/equality.test.tsx`, `vue.test.ts`               |
| Direct + parent-path owner counting                     | Exact registration identities; commit ledgers before callbacks; obsolete release cancellation              | `ownership-commit.test.ts`                                                       |
| Latest-created cached lookup and tag batches            | Key first, missing-key tag fallback, newest-first batches, preflight and rollback                          | `cached-dependencies.test.ts`, `diagnostics.test.ts`, `ownership-commit.test.ts` |
| Forced recycle, unbind, reset, retained instances       | Cache removed before reentry; only exact old entries removed; complete exclusive graph cleanup             | `ownership-commit.test.ts`, `flutter-api.test.ts`                                |
| Configuration, lifecycle observers, error reporting     | `ViewModel.initialize/config/reset`, observers, `ErrorType`, safe error sink                               | `flutter-api.test.ts`                                                            |
| Debug graph and counts                                  | `runtime.getDiagnostics/countInstances`, factory/tag ambiguity warnings                                    | `diagnostics.test.ts`, `flutter-api.test.ts`                                     |
| Pause and resume                                        | Runtime app/window tokens plus independent Binding visual-pause tokens                                     | `flutter-api.test.ts`, platform lifecycle suites                                 |

Test paths are under `tests/core/` unless otherwise qualified. All tests run serially.
ESM/CJS configuration, overrides, reset and class identity are also checked against built packages by
`scripts/test-package-exports.mjs`.

## Breaking changes from 0.3.1

`update` now notifies after successful completion, including after an awaited Promise.
Remove a trailing manual `notifyListeners()` inside `update` unless the extra event is deliberate.
For immutable state, use `setState/updateState` directly rather than wrapping them in `update`.

```ts
this.update('cart.add', () => {
  this.items.push(item);
});
await this.update('cart.reload', async () => {
  this.items = await loadItems();
});
```

`onDependencyNotify` has been removed. A watched child automatically notifies the parent.
For business logic, install `this.viewModelBinding.listen(childSpec, callback)` in `onCreate`.
Do not replace the removed hook with a manual forwarding loop.

```ts
binding.listenState(counterSpec, (previous, current) => {
  recordChange(previous, current);
});
binding.listenStateSelect(
  counterSpec,
  (state) => state.count,
  (previous, current) => {
    recordCount(previous, current);
  },
);
```

The old `listenState`/`listenStateSelect` object argument is now positional.
Direct `subscribeState(({ previous, current }) => ...)` deliberately retains its object payload.
A diamond can emit two parent events; only root visual refresh is coalesced.
Listener/lifecycle/cleanup errors go to `config.onError`, not a synchronous `AggregateError`.
Creation/binding hook errors are reported without automatically destroying an otherwise valid owner.
Constructor, cycle, type and invalid-owner errors still reject the operation.
After disposal, `notifyListeners` and state writes are ignored; `updateState` does not run its updater.
Dependency resolution, new subscriptions and `update` still reject an ended generation.

## Parameterized Specs and effective identity

```ts
const userSpec = ViewModelSpec.arg(UserViewModel, (id: string) => new UserViewModel(id), {
  key: (id) => id,
  tag: () => 'users',
});
const user = binding.watch(userSpec('ada'));
```

Without a key, different arguments for the same explicit class in one Binding reuse the first instance.
Within one Runtime, equal explicit class + key share even across different Specs. A later builder does
not replace an existing generation. Keys use JavaScript Map identity: objects are compared by reference,
not Dart-style overloaded equality. `undefined` means unkeyed; `null` is rejected.
`tag` only groups instances and never defines identity. `aliveForever` requires an explicit key.

## Override scopes: explicit, not an ambient Dart Zone

```ts
await userSpec.runWithOverride(fakeUserSpec, async (runtime) => {
  const binding = runtime.createBinding();
  await prepareFixture();
  const user = binding.read(userSpec('ada'));
  // Nested getters use the same Runtime and override context.
  await verifyUser(user);
});
```

`ViewModelRuntime.runWithOverrides([[source, replacement]], callback)` handles several overrides.
The instance method `runtime.runWithOverrides` inherits that Runtime's selected factories.
Each helper supplies a **new isolated cache and Runtime**, snapshots the override context, and disposes
it after the callback succeeds or fails. Use the supplied Runtime throughout the asynchronous task;
using an unrelated existing Binding does not acquire the scope. This is not a transparent Dart Zone port.
Concurrent tasks cannot replace each other's factory selections.

`spec.overrideWith(replacement)` is a manual realm-wide override and returns an idempotent restore
function. Always restore it in `finally`; do not overlap it across independent async tasks. Overrides
change future resolution, not existing generations. `withKey` creates a separate concrete declaration;
install an override on that declaration (or use an argument family) when it needs to be overridden.

## Host-specific boundaries

Core dependency lifetime follows Binding ownership, **not build/render collection**. React render can
prepare only pure objects; owner acquisition, `onCreate` and `onBind` happen at commit. Dependency
getters are for committed actions/lifecycle, not render or selectors. Natural last-owner disposal uses a
microtask to tolerate immediate React remount; forced recycle/reset/Runtime disposal are synchronous.

`binding.pause/resume` only defer that Binding's visual refresh; other owners, state and business
reactions continue. `runtime.pause/resume` additionally deliver VM `onPause/onResume` and aggregate
app/window tokens. Neither is a Flutter route/ticker provider.

Flutter Widget mixins, `ChangeNotifier`, Dart streams, annotation/code generation and the Flutter
DevTools UI/protocol are not exported by this package. Diagnostics are plain snapshots, not a DevTools
extension. JavaScript equivalents are the existing React Native/Electron Scope hooks, Vue reactive
bridge and Taro page lifecycle bridge. No React Web, SSR or RSC support is introduced. Electron
main/preload/renderer remain separate realms; share serializable DTOs over IPC, not VM objects.
