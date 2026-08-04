# React Native Counter

[中文](./README_ZH.md)

This minimal example demonstrates:

- a stable, module-level Spec;
- one unkeyed instance privately shared inside a Scope Binding;
- selector-based rendering for one state field;
- a read hook used only to obtain actions;
- automatic Runtime pause/resume through React Native `AppState`.

> This example requires the current `view_model` API. It is for React
> Native applications, not React Web.

The `App.tsx` filename below labels an illustrative snippet. This directory
does not contain a complete runnable React Native project or native build
configuration.

## Ownership Model

`ViewModelRuntime` is the module-sharing and dependency-injection boundary.
`ViewModelScope` is its React owner adapter: it provides one stable Binding to
hooks and maps React commit/unmount to ownership. Scope is not the DI system
itself, and non-React modules can use a plain Binding from the same Runtime.

With no `runtime` prop, a root Scope creates and owns its Runtime. An injected
Runtime remains owned by the caller and must be disposed at the real
application or test shutdown boundary.

## `App.tsx`

```tsx
import { Button, SafeAreaView, Text } from 'react-native';
import { StateViewModel, viewModelSpec } from 'view_model/core';
import { ViewModelScope, useReadViewModel, useViewModelSelector } from 'view_model/react-native';

type CounterState = Readonly<{
  count: number;
}>;

class CounterViewModel extends StateViewModel<CounterState> {
  public constructor() {
    super({ count: 0 });
  }

  public readonly increment = (): void => {
    this.updateState((current) => ({
      count: current.count + 1,
    }));
  };

  public readonly decrement = (): void => {
    this.updateState((current) => ({
      count: current.count - 1,
    }));
  };
}

// Keep the Spec stable and outside React render.
const counterSpec = viewModelSpec(() => new CounterViewModel());

function CounterScreen() {
  const count = useViewModelSelector(counterSpec, (counter) => counter.state.count);
  const counter = useReadViewModel(counterSpec);

  return (
    <SafeAreaView>
      <Text accessibilityRole="header">Count: {count}</Text>
      <Button title="-1" onPress={counter.decrement} />
      <Button title="+1" onPress={counter.increment} />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <ViewModelScope>
      <CounterScreen />
    </ViewModelScope>
  );
}
```

The selector watches the counter but rerenders only when `state.count`
changes. `useReadViewModel` owns the same instance so the buttons can call its
actions without rerendering because of ordinary ViewModel notifications.

The Spec builder and constructor are pure. React may execute them while
preparing a render that never commits; start timers, requests, native
subscriptions, and other managed resources from `onCreate`, then register
their cleanup through `addDispose` or release them in `onDispose`.

## Scope Identity

Two `CounterScreen` components below the same `ViewModelScope` resolve the same
stable unkeyed Spec through the same Binding, so they share one count. Put them
under two different Scopes and each Scope Binding gets its own unkeyed
generation, even when the Scopes inherit the same Runtime.

When cross-Scope sharing is intentional, create a stable keyed variant at
module scope:

```ts
const sharedCounterSpec = counterSpec.withKey('shared-counter');
```

The key allows Bindings in one Runtime to share a generation; it does not keep
that generation alive. Avoid `aliveForever` for screen-local state. Permanent
instances require an explicit key and end only through Runtime disposal or
forceful recycle.

## AppState Lifecycle

The React Native Scope uses `AppState` by default:

- `active` resumes the Runtime;
- `inactive`, `background`, `null`, and other states pause it.

Pause/resume applies to the whole Runtime, not only to the Scope that supplied
the lifecycle source. A nested Scope sharing its parent Runtime therefore
cannot independently pause only its own ViewModels. Use a separate Runtime for
independent pause semantics, and explicitly dispose that Runtime if it was
injected.

The `lifecycle` prop replaces the default AppState source. If a screen needs an
independent Runtime governed by both AppState and navigation focus, provide
one custom lifecycle source that combines those conditions.

## Lifetime Notes

- A hook cleanup removes that hook's subscription; it does not release the
  Scope Binding's owner entry.
- The root Scope keeps the counter generation owned until the Scope unmounts
  or the generation is recycled.
- Give a screen its own nested Scope when its unkeyed modules must be released
  when that screen truly unmounts.
- Screen blur is not disposal. Model focus explicitly or provide a deliberate
  lifecycle source when mounted screens need focus-aware behavior.
