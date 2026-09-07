# Vue 3 and Taro 4

[简体中文](./zh/vue-taro.md)

## Optional entries

The same package exports `@lwjlol/view_model/vue` and
`@lwjlol/view_model/taro-vue`. Both re-export core; the Taro entry re-exports the
Vue bridge. The root, core, RN, and Electron entries do not import Vue or Taro.
Vue `>=3.3 <4` and Taro `>=4 <5` are optional peers supplied by the host. Use an
existing Taro 4 project configured with `@tarojs/plugin-framework-vue3` and matching
Taro package versions. This bridge does not configure the Taro compiler.

```sh
npm install @lwjlol/view_model
```

The Vue entry is the framework bridge for Taro. SSR, React Web, and React Server
Components are not supported. Adapter tests cover Vue and Taro lifecycle contracts;
they do not certify every mini-program platform or device.

## Page setup

Keep the declaration in a separate module, outside component setup:

```ts
// counter.ts
import { StateViewModel, viewModelSpec } from '@lwjlol/view_model/core';

class Counter extends StateViewModel<Readonly<{ count: number }>> {
  constructor() {
    super({ count: 0 });
  }
  increment() {
    this.updateState((s) => ({ count: s.count + 1 }));
  }
}
export const counterSpec = viewModelSpec(Counter, () => new Counter());
```

```vue
<script setup lang="ts">
import { useTaroViewModelScope, useViewModel } from '@lwjlol/view_model/taro-vue';
import { counterSpec } from './counter';

useTaroViewModelScope();
const counter = useViewModel(counterSpec);
const increment = () => counter.value.increment();
</script>

<template>
  <view>
    <text>{{ counter.state.count }}</text>
    <button @tap="increment">+1</button>
  </view>
</template>
```

Call composables synchronously in setup (or an active Vue effect scope for the
Vue-only APIs). Acquisition and `onCreate` happen during setup; this differs from
React's commit subscription. Keep constructors pure, and allocate managed resources
in `onCreate`. Dependency getters are for actions/lifecycle, not templates or selectors.

## Reactive access

- `useViewModel(spec, scope?)` returns a readonly shallow ref of a raw ViewModel.
  Notifications trigger ref consumers without proxying the class instance.
- `useReadViewModel(spec, scope?)` ignores ordinary notifications but replaces the
  ref value after recycle.
- `useViewModelSelector(spec, selector, equals = Object.is, scope?)` returns a
  readonly shallow ref of the selected value. Equality suppresses unchanged selections.
- `useViewModelRuntime()` and `useViewModelBinding()` resolve the current owner.

Use `.value` in script; templates unwrap top-level refs. Retain the ref, not a cached
`ref.value`, because recycle replaces the instance. Selectors should select plain
fields or immutable snapshots. Do not wrap ViewModels in `reactive()`.

## Ownership

`useViewModelScope({ runtime?, isolated? })` creates one Binding per Vue effect scope
and provides its runtime to descendants. A consuming component creates its own
Binding automatically. Without an injected or inherited runtime, the scope owns a
new runtime. `isolated: true` disables inheritance. Supplied runtimes remain caller-owned.
Unkeyed instances are private to each Binding; explicit keys share within one runtime.
Passing an explicit scope to a composable intentionally shares that scope's Binding.

Effect-scope cleanup releases the Binding and any owned runtime. An individual
composable's cleanup removes its subscription; the owner retains the instance until
its Binding is disposed. The returned scope also exposes idempotent `dispose()` and
`isDisposed`. Configure one scope per effect scope, before consuming composables;
options are fixed for that scope's lifetime.

## Taro lifecycle

`useTaroViewModelScope({ runtime?, pauseOnHide? })` belongs in page setup. It additionally
releases the page Binding on `useUnload`. Hiding a page retains its ownership and does
not pause a shared runtime. Child component Bindings release on Vue unmount.

For an isolated page, `useTaroViewModelScope({ pauseOnHide: true })` creates an independent
runtime and maps hide/show to pause/resume. Combining this option with an injected
runtime throws, preventing one hidden page from pausing siblings.

For application-wide sharing, create and export one runtime at the composition root:

```ts
// runtime.ts
import { ViewModelRuntime } from '@lwjlol/view_model/core';
export const appRuntime = new ViewModelRuntime();
```

```ts
// app setup
import { onScopeDispose } from 'vue';
import { useTaroAppLifecycle } from '@lwjlol/view_model/taro-vue';
import { appRuntime } from './runtime';

useTaroAppLifecycle(appRuntime);
onScopeDispose(() => appRuntime.dispose());
```

Each page calls `useTaroViewModelScope({ runtime: appRuntime })`. Explicit injection
also works when the Taro platform does not preserve app-to-page Vue provide/inject.
Only register application lifecycle once, in app setup. Its pause token is removed
on cleanup, without clearing other owners' pause tokens. Pause affects the whole
runtime and coalesces Binding notifications; it does not stop actions or async work.

## Verification

Serial tests cover raw refs, selectors, read mode, repeated recycle, pause/resume,
component identity/cleanup, page unload, isolated visibility, and application tokens.
The package build preserves shared core and Vue entry identities for ESM/CJS.
Before production rollout, build the consuming Taro project for its actual targets
and verify navigation, background/foreground transitions, and resource cleanup on device.
