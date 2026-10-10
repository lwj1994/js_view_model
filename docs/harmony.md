# HarmonyOS integration

[简体中文](./zh/harmony.md) · [Documentation index](./README.md)

The HarmonyOS adapter connects the existing TS/JS core to an ArkUI host. It provides explicit Scope ownership and a Runtime lifecycle bridge. Business ViewModels, Specs, and dependency injection remain in TypeScript; a small `.ets` page or component copies concrete facade values into ArkUI-observed state.

## Support and validation boundary

This is a **TS/JS interoperability adapter**, not a full rewrite of the core into `.ets`. It imports neither React nor Vue and does not install HarmonyOS platform listeners automatically.

The included native example targets a Stage-model ArkTS application using **ArkUI V2, API 12 or later**. Repository checks exercise the adapter and generated package in Node and type-check the TypeScript facade. They do not compile ArkTS, execute DevEco's OHPM resolver, or verify a native device. Build and run the example with your chosen HarmonyOS SDK before treating that SDK/device combination as validated.

Keeping the business code in `.ts` is deliberate. ArkTS supports importing TS/JS, but copying that code into `.ets` introduces different restrictions on types and dynamic JavaScript behavior. The adapter does not promise that `.ets` can directly inherit every JS ViewModel or consume every generic constructor/Spec type exposed by the core.

## Package entry points

| Distribution                 | Import                       | Use                                           |
| ---------------------------- | ---------------------------- | --------------------------------------------- |
| Generated local OHPM package | `@lwjlol/view_model`         | TS business code inside a DevEco application. |
| npm package                  | `@lwjlol/view_model/harmony` | The same adapter in a TS/JS toolchain.        |

Both Harmony entry points re-export the core APIs. The **npm root** remains the core-only entry; its exports are not the same as the generated OHPM root.

These Harmony entry points are **unreleased additions in this checkout**. The previously published npm `0.3.1` package does not include `/harmony`. Use the OHPM output generated from this checkout; the npm entry above describes a locally rebuilt package or a future release containing this change.

Build the local OHPM package from the repository root:

```sh
npm ci
npm run build:harmony
```

Then install the generated directory from the DevEco application's `entry` module directory:

```sh
ohpm install /absolute/path/to/js_view_model/dist/ohpm
```

Replace the absolute path with your repository location and run **Sync and Refresh Project**. Local installation does not depend on an OHPM registry release. The generated package is intended to be consumed as JS with type declarations, not renamed to `.ets`.

Follow the complete [Counter example](../examples/harmony-counter/README.md) for file placement, the page profile, and native validation steps. Code snippets below use the OHPM root import.

## Public adapter API

```ts
import {
  createViewModelHarmonyLifecycle,
  createViewModelHarmonyScope,
  StateViewModel,
  ViewModelRuntime,
  viewModelSpec,
} from '@lwjlol/view_model';
```

| API                                                    | Behavior                                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `createViewModelHarmonyScope({ runtime?, onUpdate? })` | Creates one stable Binding. Without an injected Runtime, the Scope creates and owns an independent Runtime.                   |
| `scope.watch(spec)`                                    | Acquires the current generation and delivers ordinary changes through the Scope's stable `onUpdate` callback.                 |
| `scope.read(spec)`                                     | Acquires the current generation without adding ordinary-change observation. It still participates in generation invalidation. |
| `scope.runtime`, `scope.binding`                       | Expose the existing core Runtime and Binding for composition and advanced operations.                                         |
| `scope.ownsRuntime`                                    | Indicates whether Scope disposal also disposes its Runtime.                                                                   |
| `scope.isDisposed`                                     | Is true after the Scope, its Binding, or its Runtime is disposed.                                                             |
| `scope.dispose()`                                      | Stops Scope update delivery, disposes its Binding, and then disposes a Scope-owned Runtime. Repeated disposal is safe.        |
| `createViewModelHarmonyLifecycle(runtime)`             | Creates an initially active lifecycle source with its own Runtime pause token.                                                |
| `lifecycle.setActive(active)`                          | Pauses or resumes that source. Multiple sources are aggregated by the Runtime.                                                |
| `lifecycle.dispose()`                                  | Removes only that source's pause token. It does not dispose the Runtime.                                                      |

`watch` and `read` are imperative acquisitions. Repeated `watch` calls use the same Binding callback instead of adding a new listener on each call. Calling `read` later does not remove a watch already established by that Scope.

## Keep the language boundary small

The [CounterFacade.ts](../examples/harmony-counter/src/main/ets/viewmodel/CounterFacade.ts) example keeps these details in TypeScript:

- the `StateViewModel` subclass and state type;
- a stable module-level `viewModelSpec(CounterViewModel, builder, options)`;
- the Scope, Runtime, and Binding;
- commands that resolve the current ViewModel;
- the stable `onUpdate` callback that reads a fresh snapshot.

Only a named `CounterFacade` and a concrete `CounterSnapshot` cross into `.ets`. The facade exposes `getSnapshot()`, `increment()`, `recycle()`, and `dispose()`. Its snapshot contains a `number`, so the page does not need to pass class objects as DI tokens or depend on complex TypeScript generic inference.

The important callback pattern, inside the TS facade, is:

```ts
this.scope = createViewModelHarmonyScope({
  onUpdate: () => {
    const current = this.scope.watch(counterSpec);
    onUpdate(new CounterSnapshot(current.state.count));
  },
});
```

Keep the first acquisition after the Scope is assigned, as the complete example does. Resource initialization belongs in ViewModel `onCreate` or explicit actions after acquisition; constructors and Spec builders should remain pure.

## Connect updates to ArkUI state

ArkUI does not automatically subscribe to a plain JS ViewModel's private state. Assigning the same ViewModel reference to an observed field is not a reliable update signal.

The sample [Index.ets](../examples/harmony-counter/src/main/ets/pages/Index.ets) renders `@Local count`, initialized and refreshed through the facade:

```ts
aboutToAppear(): void {
  const counter = new CounterFacade((snapshot: CounterSnapshot): void => {
    this.count = snapshot.count;
  });
  this.counter = counter;
  this.count = counter.getSnapshot().count;
}
```

`build()` only reads the local field. Button callbacks call facade commands. An application can instead use its own `@ObservedV2`/`@Trace` presentation model, provided the adapter updates the observed properties explicitly.

Always re-resolve watched Specs when publishing updates. `runtime.recycle(spec)` force-disposes the old generation; the next `scope.watch(spec)` obtains its replacement. A permanently cached ViewModel reference or a direct `subscribeState` listener remains attached to the old object and is not a replacement for this Scope-level binding.

The Scope uses the core Binding's transaction delivery: ordinary watched updates are deduplicated by Binding within a synchronous notification transaction, and paused Runtime updates are coalesced until resume. ArkUI remains responsible for scheduling its UI rendering.

## Component ownership and visibility

| Host event                                   | Adapter action                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Component `aboutToAppear`                    | Create the facade/Scope, perform initial `watch`, and copy the snapshot into observed state. |
| Component `build`                            | Read presentation state only; do not acquire ViewModels or install subscriptions.            |
| Component `aboutToDisappear`                 | Dispose the facade/Scope. Do not update ArkUI state while tearing down the component.        |
| Retained page hides or loses focus           | Keep its Binding. Visibility alone is not disposal.                                          |
| Page returns while its component is retained | Continue using the existing Scope and generation.                                            |

The adapter does not discover component lifecycle methods or navigation events. The host supplies those connections explicitly. A reusable component's recycle/reuse callbacks need their own policy for releasing and reacquiring ownership; the minimal Counter example uses a normal component.

## Runtime boundaries, sharing, and recycle

A Scope without `runtime` owns its complete graph. Disposing it releases its Binding and disposes that Runtime. An injected Runtime remains caller-owned; its creator must release the remaining owner Scopes/Bindings and then dispose the Runtime.

When several components share a Runtime, unkeyed Specs remain private to each Binding. Use an explicit ViewModel type plus `key` for an intentionally shared generation. `aliveForever` still requires a key and still ends on force recycle or Runtime disposal.

`scope.runtime.recycle(spec)` is shared invalidation, not ordinary page cleanup. It ends all matching generations in that Runtime, including those retained by other owners. The unkeyed Counter example owns an independent Runtime, so its **Recreate counter** button affects only that example instance.

## Runtime pause and application lifecycle

Use `createViewModelHarmonyLifecycle` when the host should pause a Runtime for application or window inactivity. Keep the bridge in TypeScript and expose a concrete facade method such as `setActive(active: boolean)` to `.ets`.

```ts
const lifecycle = createViewModelHarmonyLifecycle(applicationRuntime);

// Forward the actual host lifecycle, including its current state when attaching.
lifecycle.setActive(false);
lifecycle.setActive(true);

// Detach this lifecycle source when its host ends.
lifecycle.dispose();
```

For an application-owned Runtime, UIAbility's `onForeground` and `onBackground` can forward `true` and `false` respectively through that facade. The example does not install those callbacks automatically. Preserve the UIAbility code generated by DevEco and connect the bridge at the same composition boundary that owns the Runtime.

Pausing affects **every activated ViewModel in that Runtime**. It calls `onPause`/`onResume` and delays Binding-delivered UI callbacks; it does not stop actions, state changes, direct `subscribe`/`subscribeState` callbacks, or arbitrary tasks. Work that should stop in the background must implement its own lifecycle handling.

A page-specific lifecycle should only pause an independent page Runtime. Pausing a shared application Runtime when one page hides also pauses other pages. To share the application graph while changing only one page's work, pass visibility as ordinary business input.

Every lifecycle bridge contributes its own token. Removing one inactive source does not resume a Runtime still paused by another source. At final shutdown, release owner Scopes/Bindings, dispose the Runtime, and detach the lifecycle source; disposing the Runtime first prevents final teardown from flushing pending UI updates.

## What to verify before shipping

Use the [Counter validation steps](../examples/harmony-counter/README.md#4-build-and-verify-in-deveco), then exercise your application's actual boundaries:

- OHPM dependency and declaration resolution with the chosen DevEco/SDK version;
- JS/TS-to-ArkTS facade calls and native UI refresh;
- watched state, read-only commands, and generation replacement after recycle;
- page retention, destruction, and any reusable component policy;
- shared Runtime identities and independent lifecycle pause sources.

A successful Node test or TS build does not establish those native results. JS syntax compatibility and available runtime APIs also need validation; syntax transpilation alone does not provide missing runtime APIs. Full `.ets` migration, native UI widgets supplied by the library, and automatic ArkUI dependency tracking are outside this adapter's scope.

## Official references

- [ArkTS overview](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-overview): ArkTS and TS/JS interoperability.
- [TypeScript to ArkTS adaptation rules](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/typescript-to-arkts-migration-guide): language restrictions and `.ets`/`.ts`/`.js` import direction.
- [OHPM install](https://developer.huawei.com/consumer/cn/doc/doccenter-deveco-studio/ide-hmos-ohpm-install): local directory dependencies.
- [MVVM with ArkUI V2](https://developer.huawei.com/consumer/en/doc/harmonyos-guides-V14/arkts-mvvm-v2-V14): explicit observable presentation state.
- [Custom component lifecycle](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-custom-component-lifecycle): native component initialization and disposal hooks.
