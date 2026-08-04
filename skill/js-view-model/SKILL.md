---
name: js-view-model
description: Build, refactor, review, debug, or test TypeScript application modules with the view_model package for React Native and Electron. Use for application-wide dependency injection, ViewModel and StateViewModel design, ViewModelSpec identity and sharing, Runtime/Binding/Scope ownership, read/watch/selector and advanced cached/tag choices, Binding-owned listeners, parent-child module composition, automatic lifecycle, StrictMode, pause/resume, aliveForever, recycle, or platform integration.
---

# JS ViewModel

Treat `view_model` as an application-wide module and dependency-injection
runtime, not as a UI-only state store. Model features, services, repositories,
coordinators, device connections, and domain capabilities as managed
ViewModels when they benefit from lifecycle, composition, or notifications.

## Load the right references

- Read [references/core.md](references/core.md) for every implementation,
  refactor, review, or debugging task.
- Also read [references/react-native.md](references/react-native.md) for React
  Native Scope, hooks, AppState, or navigation tasks.
- Also read [references/electron.md](references/electron.md) for Electron
  renderer, preload, main, window lifecycle, or IPC tasks.
- Read [references/testing.md](references/testing.md) when adding tests,
  diagnosing lifecycle timing, or validating package output.
- When working inside the upstream repository, treat `src/`, `tests/`, and the
  matching language under `docs/` as newer truth if they conflict with these
  bundled references.

## Follow this workflow

1. Identify the host and realm.
   - Use `view_model/core` in plain TypeScript and Electron main.
   - Use `view_model/react-native` for RN Scope/hooks.
   - Use `view_model/electron` for Electron renderer Scope/hooks.
   - Never generate a `view_model/react` import or claim Web/SSR/RSC support.

2. Choose the Runtime boundary first.
   - Create one application Runtime when modules should participate in the
     same DI and keyed-sharing graph.
   - Use separate Runtimes for hard isolation, independent pause state, tests,
     or separate Electron renderer realms.
   - Keep “global” precise: it means one explicit Runtime in one JavaScript
     realm, never an implicit process-spanning singleton.

3. Model functional modules.
   - Extend `ViewModel` for mutable fields or command/service modules.
   - Extend `StateViewModel<TState>` for immutable state snapshots and state
     diffs.
   - Keep network clients and other external dependencies as ordinary
     constructor inputs when their lifecycle is not managed by this runtime.
   - Make a service/repository/coordinator a ViewModel when managed lifetime,
     lazy composition, sharing, or notifications are useful.

4. Declare stable Specs at module scope.
   - Prefer `viewModelSpec(X, () => new X(), options)` so the class is an
     explicit runtime identity.
   - Inside one Runtime, explicit identity is ViewModel type plus effective
     key. An omitted key is private to one Binding; an explicit key shares
     across Bindings.
   - Independent explicit Specs with the same type and key share. Keep one
     module-level declaration anyway so builder and options cannot diverge.
   - Treat `viewModelSpec(() => new X(), options)` as a compatibility fallback:
     every builder-only Spec receives an independent token.
   - Use `baseSpec.withKey(key)` for variants that preserve the base explicit
     type identity or builder-only fallback token.
   - Keep ordinary modules unkeyed unless cross-Binding sharing or multiple
     variants are required.
   - Treat `tag` as lookup metadata, never as part of identity.
   - Give every `aliveForever` Spec an explicit key.

5. Select an owner adapter.
   - In plain hosts, create a Binding with `runtime.createBinding()` and dispose
     it when that host's ownership ends.
   - In React, use a platform `ViewModelScope`. Scope is only the React owner
     adapter that provides a Runtime/Binding and maps commit/unmount to
     ownership; it is not the DI system itself.
   - Inject an application Runtime into Scope when React and non-React hosts
     should share keyed modules. The caller then owns Runtime disposal.

6. Resolve dependencies and UI access correctly.
   - Use `binding.read(spec)` for owned imperative access without ordinary
     update propagation.
   - Use `binding.watch(spec)` when a plain owner or parent should react to
     ordinary ViewModel notifications.
   - Resolve normal child modules through
     `this.viewModelBinding.read/watch(spec)` getters. Preserve the Spec instead
     of querying a cache by type.
   - Use `readCached`, `watchCached`, their `maybe` variants, and tag-batch
     queries only for advanced lookup of generations another path already
     created. They do not construct missing instances.
   - Use Binding-owned `listen`, `listenState`, or `listenStateSelect` for
     side-effect subscriptions that must clean up with Binding or generation
     disposal. Keep the returned disposer when earlier cleanup is useful.
   - Call dependency getters only from actions, `onCreate`, lifecycle hooks,
     or internal collaboration after attach/commit.
   - In React, choose `useViewModel`, `useReadViewModel`, or
     `useViewModelSelector`; never call a dependency getter from render or a
     selector.

7. Place side effects at the correct lifecycle phase.
   - Keep Spec builders and constructors pure.
   - Start timers, IPC, sockets, native subscriptions, and similar resources
     in `onCreate`.
   - Register cleanup through `addDispose` and keep lifecycle hooks synchronous.
   - Implement `onPause`/`onResume` only for resources that actually need
     pausing; Runtime pause does not stop business logic automatically.

8. Validate semantics, not only types.
   - Test identity, ownership release, dependency propagation, pause tokens,
     recycle, cached lookup misses, listener cleanup, and resource cleanup where
     they affect the feature.
   - Verify a complete synchronous notification cascade deduplicates the same
     callback per Binding while different Bindings still receive updates.
   - Flush disposal microtasks before asserting automatic destruction.
   - Run the repository's serial test and package checks.

## Preserve these invariants

- Both `read` and `watch` create/resolve and own an instance. `read` does not
  mean unowned; it only ignores ordinary ViewModel notifications.
- An unkeyed instance is private to the resolving Binding. A parent generation
  owns a private dependency Binding for its unkeyed children.
- Independently created explicit Specs share when their ViewModel type and key
  match. Independently created builder-only Specs retain separate fallback
  tokens and do not share.
- Root Binding owner sources are mirrored through resolved child graphs. Later
  root bind/unbind changes propagate in real time, with source-aware reference
  counting across direct and multiple-parent paths.
- One entire synchronous notification cascade shares a transaction. The same
  callback is deduplicated per Binding; asynchronous notifications start a new
  transaction.
- `update(action, mutation)` only supplies an action context. It does not call
  `notifyListeners`; ordinary `ViewModel` mutations must notify explicitly.
- `StateViewModel` compares state with `Object.is` by default. Replace immutable
  snapshots or pass a deliberate equality function.
- Parent `watch` propagation already invokes `onDependencyNotify(child)` and
  notifies the parent. Do not unconditionally notify a second time in that hook.
- A single React hook cleanup removes its listener but does not release the
  Scope Binding's owner entry. Scope disposal or recycle ends that ownership.
- Binding-owned `listen*` subscriptions differ from hook listeners: Binding
  disposal, generation disposal/recycle, or their returned disposer removes
  them automatically.
- Pause/resume is Runtime-wide and token-aggregated. A nested Scope sharing a
  Runtime cannot pause only its own instances.
- `runtime.recycle(instance)` force-disposes one generation.
  `runtime.recycle(unkeyedSpec)` can dispose every matching private generation
  in that Runtime. Recycle overrides all owners.
- Do not retain child ViewModel objects in long-lived fields. Resolve through a
  getter so a new generation can be obtained after recycle.

## Avoid invented or Flutter-only APIs

Do not generate `ViewModelSpec.argN`, spec proxy, code-generation annotations,
`ChangeNotifierViewModel`, global
`ViewModel.initialize/reset/config`, DevTools integration, route/ticker pause
providers, or widget mixins. They belong to other implementations and are not
part of this TypeScript package.

## Produce maintainable output

- Keep code comments in English.
- Explain the Runtime and owner boundary when architecture is not obvious.
- Prefer a stable, explicit composition root over hidden global service
  locator calls.
- State the blast radius before suggesting `aliveForever` or `recycle`.
- Include cleanup and Runtime ownership in examples, not only the happy-path
  read/watch call.
