# Getting Started

[简体中文](./zh/getting-started.md)

`view_model` is a TypeScript runtime for stateful application modules, dependency injection, notifications, and automatic lifetime management. It supports:

- platform-independent TypeScript code and Electron main through `view_model/core`;
- React Native through `view_model/react-native`;
- Electron renderer through `view_model/electron`.

It does not provide a general React Web, SSR, or React Server Components entry point. In particular, there is no public `view_model/react` export.

The core runtime does not depend on React. A `ViewModelScope` is only a React adapter: it creates or receives a `ViewModelRuntime`, owns a `ViewModelBinding`, and connects platform lifecycle events to that runtime. Application services and global dependency graphs can be created and used without any UI.

## Install the current alpha

The current alpha is consumed from the repository rather than the public npm registry. Build and pack it first:

```sh
git clone https://github.com/lwj1994/js_view_model.git
cd js_view_model
npm install
npm run build
npm pack
```

Install the generated archive in the React Native or Electron application:

```sh
npm install /absolute/path/to/js_view_model/view_model-0.1.0.tgz
```

The host application supplies the relevant peer dependencies: React and React Native for a React Native app, or React and Electron for an Electron renderer. Electron main can use the core entry without React.

After a public npm release, the package can be installed by its package name. Check the root [README](../README.md) and current `package.json` for the authoritative release status and peer dependency ranges.

## 1. Choose the correct entry point

Use the core entry for models, specs, runtimes, and non-React hosts:

```ts
import {
  StateViewModel,
  ViewModel,
  ViewModelRuntime,
  viewModelSpec,
  type ViewModelSpec,
} from 'view_model/core';
```

Use a platform entry for its Scope and hooks:

```ts
import {
  ViewModelScope,
  useReadViewModel,
  useViewModel,
  useViewModelSelector,
} from 'view_model/react-native';
```

```ts
import {
  ViewModelScope,
  useReadViewModel,
  useViewModel,
  useViewModelSelector,
} from 'view_model/electron';
```

The platform entries re-export the core API, but importing models from `view_model/core` and UI adapters from the platform entry makes process and platform boundaries easier to review.

## 2. Define a ViewModel and a stable Spec

`StateViewModel<State>` stores one state snapshot and notifies its owners when the snapshot changes.

```ts
import { StateViewModel, viewModelSpec } from 'view_model/core';

type CounterState = Readonly<{
  count: number;
}>;

export class CounterViewModel extends StateViewModel<CounterState> {
  public constructor() {
    super({ count: 0 });
  }

  public readonly increment = (): boolean =>
    this.updateState((current) => ({ count: current.count + 1 }), 'counter.increment');
}

export const counterSpec = viewModelSpec(() => new CounterViewModel(), {
  debugLabel: 'Counter',
});
```

Keep the Spec at module scope. A Spec is an identity token, not merely a factory wrapper. Recreating it during every React render creates a different identity every time.

The builder and constructor must be pure. They may initialize in-memory fields, but they must not open sockets, start timers, subscribe to native APIs, perform IPC, or resolve another ViewModel. React may run a builder during a render that is later abandoned. Resource acquisition belongs in `onCreate`.

## 3. Use core without React

A `ViewModelRuntime` is an application container within one JavaScript realm. A `ViewModelBinding` is an owner of every ViewModel it resolves.

```ts
import { ViewModelRuntime } from 'view_model/core';

const runtime = new ViewModelRuntime();

function renderHost(): void {
  const counter = binding.watch(counterSpec);
  console.log(`count: ${counter.state.count}`);
}

const binding = runtime.createBinding({
  id: 'application-host',
  onUpdate: renderHost,
});

renderHost();
binding.read(counterSpec).increment();

// Shut down the owner before shutting down its container.
binding.dispose();
runtime.dispose();
```

The two resolution modes have different notification behavior:

- `binding.read(spec)` resolves and retains the instance but ignores ordinary ViewModel notifications at the Binding level.
- `binding.watch(spec)` resolves and retains the instance and routes its ordinary notifications to the Binding's `onUpdate` callback.

Both modes participate in ownership and lifetime. `read` does not mean “temporary” or “unmanaged.”

The example calls `binding.watch(counterSpec)` again from `renderHost`. That call is idempotent for the current identity, and it lets the host resolve a new generation after an explicit recycle.

Always dispose long-lived plain bindings. A Runtime should also be disposed when its application container, background service, test, Electron main process, or other host shuts down.

## 4. Use an application-level dependency container

ViewModels are not limited to screen state. A stable Runtime and Binding can own application services even when no React tree exists.

```ts
import { ViewModel, ViewModelRuntime, viewModelSpec } from 'view_model/core';

class SessionViewModel extends ViewModel {
  public async requireAccessToken(): Promise<string> {
    // Read or refresh the application session here.
    return 'token';
  }
}

export const sessionSpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'primary-session',
  debugLabel: 'Session',
});

export const applicationRuntime = new ViewModelRuntime();
export const applicationBinding = applicationRuntime.createBinding({
  id: 'application',
});

export const session = applicationBinding.read(sessionSpec);
```

As long as `applicationBinding` remains alive, it owns the session. `aliveForever` is not required merely because a binding has application lifetime.

A React Native or Electron renderer Scope can receive the same Runtime and resolve the same keyed Spec:

```tsx
<ViewModelScope runtime={applicationRuntime}>
  <App />
</ViewModelScope>
```

When a Runtime is injected, the caller owns it and must eventually dispose it. The Scope disposes its own Binding, not the injected Runtime.

Sharing only works inside the same Runtime and JavaScript realm. An Electron main process and renderer cannot share a Runtime, Binding, or ViewModel object; use a narrow preload/IPC API and serializable data between them.

## 5. React Native adapter

Define models and Specs outside render, then place a Scope around the React owner boundary.

```tsx
import { Button, Text, View } from 'react-native';
import { StateViewModel, viewModelSpec } from 'view_model/core';
import { ViewModelScope, useReadViewModel, useViewModelSelector } from 'view_model/react-native';

class CounterViewModel extends StateViewModel<Readonly<{ count: number }>> {
  public constructor() {
    super({ count: 0 });
  }

  public readonly increment = (): void => {
    this.updateState((state) => ({ count: state.count + 1 }), 'counter.increment');
  };
}

const counterSpec = viewModelSpec(() => new CounterViewModel());

function Counter(): React.JSX.Element {
  const count = useViewModelSelector(counterSpec, (counter) => counter.state.count);
  const actions = useReadViewModel(counterSpec);

  return (
    <View>
      <Text>Count: {count}</Text>
      <Button title="Increment" onPress={actions.increment} />
    </View>
  );
}

export default function App(): React.JSX.Element {
  return (
    <ViewModelScope>
      <Counter />
    </ViewModelScope>
  );
}
```

The default React Native Scope treats `AppState.currentState === 'active'` as active. Every other state pauses the Runtime.

## 6. Electron renderer adapter

The hook usage is the same, but imports come from the Electron entry:

```tsx
import { createRoot } from 'react-dom/client';
import { ViewModelScope } from 'view_model/electron';

createRoot(document.getElementById('root')!).render(
  <ViewModelScope>
    <App />
  </ViewModelScope>,
);
```

The default renderer lifecycle considers the Runtime active only while the window is focused and the document is not hidden. Electron main does not use this Scope; it uses `view_model/core` and plain bindings.

## 7. Pick the narrowest hook

```tsx
const wholeViewModel = useViewModel(counterSpec);
const actionsOnly = useReadViewModel(counterSpec);
const count = useViewModelSelector(counterSpec, (counter) => counter.state.count);
```

- `useViewModel` rerenders on every ordinary notification from the ViewModel.
- `useReadViewModel` retains the instance without rerendering on ordinary notifications. It still rerenders when recycle changes the generation.
- `useViewModelSelector` rerenders when the selected result changes according to `Object.is`, or according to the optional custom equality function.

Do not render changing state through `useReadViewModel`; that UI would become stale. Selectors must be pure and may run more than once. They must not mutate state, start work, or resolve a parent ViewModel's dependency getter.

## 8. Understand the ownership rule

Multiple hooks in one Scope share one Binding owner. Unmounting one hook removes its listener, but it does not release the Binding's ownership entry. The instance normally remains until the Scope's Binding is disposed or the instance is explicitly recycled.

This has two practical consequences:

1. An application-root Scope is suitable for application-lifetime modules.
2. A screen that requires release on unmount needs an appropriate owner boundary; merely removing the last component hook from a still-mounted Scope is not enough.

Nested Scopes inherit the parent Runtime by default but create a different Binding. Their unkeyed instances are isolated. Keyed instances can be shared when their Spec token and key are both equal.

## 9. Important lifecycle limits

- `update(action, mutation)` associates an action with notifications emitted inside `mutation`; it does not call `notifyListeners` by itself.
- `onCreate` runs after the first acquire, not during construction.
- `onBind` and `onUnbind` describe logical Binding IDs, not individual hooks.
- Runtime pause is Runtime-wide. A nested Scope that inherits a Runtime cannot pause only its own ViewModels.
- Pause does not freeze actions or state changes. It calls `onPause` and defers/coalesces Binding and hook update delivery until all pause reasons resume.
- `recycle` force-disposes a generation even while owners still use it. It is a global invalidation operation within that Runtime identity, not a local component reset.

Continue with:

- [ViewModels and state](./view-models.md)
- [Dependency injection](./dependency-injection.md)
- [Identity and lifetime](./identity-and-lifetime.md)
- [Testing](./testing.md)
