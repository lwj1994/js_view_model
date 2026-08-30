---
name: js-view-model
description: Build or refactor React Native and Electron functional modules and state management with @lwjlol/view_model, including application-wide dependency injection, ViewModelSpec identity and sharing, Runtime/Binding/Scope ownership, watch/read and cached lookup semantics, lifecycle, pause-resume, testing, and platform integration.
---

# JS ViewModel Skill

Use this skill when tasks involve `@lwjlol/view_model` architecture,
migration, bug fixing, performance tuning, review, or feature implementation
for React Native and Electron applications.

## Source of truth

- Core architecture and API: [references/core.md](references/core.md)
- React Native integration: [references/react-native.md](references/react-native.md)
- Electron integration: [references/electron.md](references/electron.md)
- Testing and package validation: [references/testing.md](references/testing.md)
- When working inside the upstream repository, `src/`, `tests/`, and the
  matching language under `docs/` are newer truth if they conflict with the
  bundled references.

## Reference loading policy

- For implementation, refactor, review, or debugging tasks, read
  [references/core.md](references/core.md) first.
- Also read the React Native reference for Scope, hooks, AppState, or
  navigation work.
- Also read the Electron reference for renderer, preload, main, window
  lifecycle, or IPC work.
- Read the testing reference when adding tests, diagnosing lifecycle timing,
  or validating package output.
- For a narrow API clarification, use this summary first and open the relevant
  reference when detail affects the answer.

## Trigger phrases

Use this skill for requests such as:

- “用 js view_model 写/改状态管理”
- “全局 DI / application Runtime 怎么设计”
- “watch/read 有什么区别”
- “ViewModelSpec 怎么共享或隔离实例”
- “ViewModel 之间如何依赖注入”
- “Scope、Binding、生命周期、pause/resume、recycle”
- “React Native 或 Electron 的 view_model 集成”

## Primary resolution rule (must follow)

- **`watch(spec)` and `read(spec)` are the primary entry points.** Use a
  stable module-level `ViewModelSpec` for normal React access, plain Binding
  hosts, tests, and ViewModel-to-ViewModel dependencies.
- Choose `watch(spec)` when ordinary ViewModel notifications should update the
  Binding owner. Choose `read(spec)` for lifecycle-owned imperative access
  without that propagation.
- Cached/tag APIs are not an alternative dependency style. They are advanced,
  lookup-only escape hatches for generations already created by another path.
  Do not suggest them by default.

## Core model (must stay accurate)

- **Every functional module can be a ViewModel.** UI state, features, services,
  repositories, coordinators, device connections, and domain capabilities can
  all use managed lifecycle, composition, and notifications.
- **The Runtime is application-wide DI, not a UI store.** One
  `ViewModelRuntime` owns identity, generations, dependency edges, and pause
  state inside one JavaScript realm. It never spans Electron processes.
- **A Binding is an owner and resolver.** Plain TypeScript hosts create a
  Binding directly. A platform `ViewModelScope` is only the React adapter that
  owns one stable Binding and maps commit/unmount to acquire/release.
- **ViewModels inject one another through Specs.** Resolve managed children
  with non-caching `this.viewModelBinding.read/watch(spec)` getters after
  attachment. Each parent generation owns a stable dependency Binding.
- **Never pass resolved ViewModel instances between lifecycle owners.** A raw
  JavaScript reference establishes no owner or dependency edge and can outlive
  the Binding that resolved it. Give each owner a stable Spec; pass plain data,
  IDs, immutable value objects, narrow callbacks, or ports across other
  boundaries.
- **Prefer managed instances over hidden singletons.** Keep normal modules
  unkeyed and non-`aliveForever` unless sharing or zero-owner retention is an
  explicit requirement.
- Both `read` and `watch` resolve and own a generation. Only `watch` propagates
  ordinary ViewModel notifications to the Binding.
- Unkeyed identity is private to the resolving Binding. For an explicit Spec,
  an explicit ViewModel type plus effective key defines identity inside one
  Runtime. Builder-only Specs use independent fallback tokens.
- A key enables cross-Binding sharing but does not retain a generation. Every
  `aliveForever` Spec must have an explicit key.
- Root Binding owner sources propagate through resolved child graphs in real
  time. Direct and multiple-parent paths are source-aware and independently
  counted.
- One synchronous notification cascade shares a transaction and deduplicates
  the same callback per Binding. An asynchronous notification starts a new
  transaction.

## Feature-module architecture

Treat `ViewModel` as the reusable unit of application functionality rather
than a class reserved for one screen. Declare stable Specs, then compose larger
modules through getter-based DI:

```ts
class CheckoutViewModel extends ViewModel {
  private get cart(): CartViewModel {
    return this.viewModelBinding.read(cartSpec);
  }

  private get pricing(): PricingViewModel {
    return this.viewModelBinding.read(pricingSpec);
  }

  public async submit(): Promise<void> {
    await this.pricing.validate(this.cart.items);
  }
}

export const checkoutSpec = viewModelSpec(CheckoutViewModel, () => new CheckoutViewModel());
```

- A getter declaration creates nothing. Its first post-attachment access
  resolves the child and establishes a parent-owned lifecycle edge.
- Prefer getters over long-lived fields or manual caches so the next
  access can resolve a fresh generation after explicit `recycle`.
- Use parent `read` for imperative collaboration. Use parent `watch` only when
  child notifications should invoke `onDependencyNotify(child)` and notify the
  parent.
- Keep normal modules unkeyed for private per-Binding graphs. When independent
  owners intentionally share one generation, let every owner resolve the same
  explicit type and key from the same Runtime.
- The resulting lifetime is the union of managed owner paths. Do not use
  instance passing or `aliveForever` as a substitute for keyed, Binding-owned
  sharing.

## Implementation workflow

1. Choose the host and Runtime boundary.
   - Use `@lwjlol/view_model/core` in plain TypeScript and Electron main.
   - Use `@lwjlol/view_model/react-native` for React Native Scope/hooks.
   - Use `@lwjlol/view_model/electron` for Electron renderer Scope/hooks.
   - Never generate `@lwjlol/view_model/react` or claim Web/SSR/RSC support.
   - Use one application Runtime for one sharing graph; use separate Runtimes
     for hard isolation, independent pause state, tests, or separate realms.

2. Choose the ViewModel style.
   - Extend `ViewModel` for commands, services, repositories, coordinators, or
     explicitly notified mutable fields.
   - Extend `StateViewModel<TState>` for immutable state snapshots and state
     diffs.
   - Keep unmanaged network clients and other plain external dependencies as
     ordinary constructor ports.

3. Declare a stable `ViewModelSpec`.
   - Prefer `viewModelSpec(X, () => new X(), options)` at module scope.
   - Use no key for ordinary private modules.
   - Use an explicit key for cross-Binding sharing or multiple variants.
   - Use `baseSpec.withKey(key)` when deriving a keyed variant that preserves
     the base identity.
   - Treat `tag` as lookup metadata, never identity.
   - Treat the builder-only overload as a compatibility fallback with an
     independent token.

4. Integrate the owner.
   - Plain host: `runtime.createBinding()` and explicit `binding.dispose()`.
   - React host: a platform `ViewModelScope` and platform hooks.
   - Inject an external application Runtime into Scope only when React and
     non-React owners should share keyed modules. The caller owns its disposal.

5. Choose the access API.
   - `watch(spec)`: resolve, own, and propagate ordinary notifications.
   - `read(spec)`: resolve and own without ordinary notification propagation.
   - `listen`, `listenState`, `listenStateSelect`: Binding-owned side-effect
     listeners with automatic cleanup and an optional early disposer.
   - `readCached`/`watchCached`, `maybe*`, and tag-batch APIs: advanced
     lookup-only access; a miss never runs a builder.
   - In React use `useViewModel`, `useReadViewModel`, or
     `useViewModelSelector`. Never expand dependency getters from render or a
     selector.

6. Handle dependencies and sharing.
   - Pass Specs or ordinary ports through constructors, not resolved managed
     instances.
   - Resolve child ViewModels through non-caching getters after attach/commit.
   - Use the same Runtime plus explicit type/key identity for intentional
     cross-Binding sharing.
   - Keep the dependency graph acyclic.

7. Place side effects in lifecycle.
   - Keep builders and constructors pure; React may abandon prepared objects.
   - Start timers, IPC, sockets, and native subscriptions in `onCreate`.
   - Register cleanup with `addDispose`; lifecycle hooks stay synchronous.
   - Use `onPause`/`onResume` only for resources that need it. Runtime pause
     does not prevent business actions or direct subscriptions.

8. Validate semantics.
   - Test identity, ownership release, parent-source propagation, synchronous
     transaction deduplication, listener cleanup, pause tokens, and recycle
     where they affect the feature.
   - Flush disposal microtasks before asserting automatic destruction.
   - Run the repository's serial tests, build, package checks, and audit.

## Do/Don't checklist

Do:

- Use stable `watch(spec)` / `read(spec)` resolution as the default.
- Model application features as collaborating ViewModel modules when managed
  lifetime, DI, reuse, or notifications are useful.
- Default normal Specs to no key and no `aliveForever`.
- Expose children through non-caching `viewModelBinding.read/watch` getters.
- Give every lifecycle owner its own managed resolution path.
- Use an explicit key when cross-Binding sharing is a real requirement.
- Dispose plain Bindings and externally owned Runtimes explicitly.
- Keep code comments in English.

Don't:

- Pass resolved ViewModel instances through props, constructors, route or IPC
  payloads, globals, registries, callbacks, service fields, or manual caches.
- Introduce a hidden singleton or service locator for ViewModel modules by
  default.
- Claim `read` is unowned; it still participates in lifecycle ownership.
- Cache a child ViewModel object in a long-lived field.
- Use cached/tag APIs as normal dependency resolution or expect them to create
  a missing generation.
- Overuse `aliveForever` for screen- or owner-scoped state.
- Use `recycle` for local updates; it force-disposes a generation for every
  owner.
- Attach a navigation lifecycle to a nested Scope that shares a Runtime when
  only that page should pause. Pause is Runtime-wide.

## Important semantic details

- `update(action, mutation)` supplies debug action context but does not call
  `notifyListeners`; ordinary `ViewModel` mutations notify explicitly.
- `StateViewModel` uses `Object.is` by default. Replace immutable snapshots or
  provide a deliberate equality function.
- Parent `watch` already propagates a child notification after
  `onDependencyNotify(child)`; do not notify the same event again
  unconditionally.
- One React hook cleanup removes only its listener. The Scope Binding retains
  its owner entry until Scope disposal or recycle.
- Binding-owned `listen*` subscriptions are removed by their disposer, Binding
  disposal, or generation disposal/recycle. Direct `subscribe*` listeners are
  manually owned.
- `runtime.recycle(instance)` force-disposes one generation.
  `runtime.recycle(unkeyedSpec)` can match one private generation per Binding.
- Pause/resume is Runtime-wide and token-aggregated.

## Avoid invented or Flutter-only APIs

Do not generate `ViewModelSpec.argN`, spec proxy/override APIs, annotations or
code generation, `ChangeNotifierViewModel`, global
`ViewModel.initialize/reset/config`, Flutter route/ticker pause providers,
DevTools integration, or widget mixins. They are not part of this TypeScript
package.

## Response pattern for implementation requests

- Default examples to stable Specs with `watch` or `read`; show cached lookup
  only for an explicit advanced cache-query requirement.
- Present application architecture as collaborating, managed ViewModel modules
  rather than a collection of UI stores or global singletons.
- Prefer complete snippets with imports, ViewModel class, Spec declaration,
  owner usage, and disposal/setup notes.
- State why `watch` or `read` was chosen.
- When introducing sharing, show the explicit key, Runtime boundary, and
  lifecycle consequences.
- Explain Runtime and owner boundaries when they are not obvious, and state the
  blast radius before suggesting `aliveForever` or `recycle`.
