# React Native integration

[简体中文](./zh/react-native.md) · [Documentation index](./README.md)

> `view_model/react-native` is the public React Native entry point in v0.1 alpha. It is for React Native applications, not React DOM or general Web rendering.

The application DI graph belongs to a `ViewModelRuntime`. `ViewModelScope` is the React Native owner adapter for that graph: it creates a `ViewModelBinding`, connects platform lifecycle events to the Runtime, and provides the Runtime and Binding to hooks.

## Public entry point

Import React Native APIs and core APIs from the platform entry point:

```ts
import {
  StateViewModel,
  ViewModel,
  ViewModelRuntime,
  ViewModelScope,
  useReadViewModel,
  useViewModel,
  useViewModelSelector,
  viewModelSpec,
} from 'view_model/react-native';
```

There is intentionally no public `view_model/react` entry point. The shared React implementation is internal and does not promise React Web, SSR, React Server Components, or browser hydration support.

## Choose the Runtime boundary first

For a simple application with only one React root, the root Scope can create and own its Runtime:

```tsx
import { ViewModelScope } from 'view_model/react-native';

export default function App() {
  return (
    <ViewModelScope>
      <RootNavigator />
    </ViewModelScope>
  );
}
```

The Scope disposes its Binding on real unmount and then disposes the Runtime it created.

For application-level DI shared by React and non-React owners, create the Runtime at the composition root and inject it:

```tsx
import { ViewModelRuntime, ViewModelScope } from 'view_model/react-native';

export const applicationRuntime = new ViewModelRuntime();

export default function App() {
  return (
    <ViewModelScope runtime={applicationRuntime}>
      <RootNavigator />
    </ViewModelScope>
  );
}
```

An injected Runtime is caller-owned. The Scope releases its own Binding but does not dispose that Runtime. Tests, embedded React Native surfaces, and explicit application shutdown paths must dispose it themselves.

This arrangement allows a bootstrap Binding, background coordinator, and React Scope to participate in the same application graph:

```ts
const bootstrap = applicationRuntime.createBinding({ id: 'application-bootstrap' });
const session = bootstrap.read(sessionSpec);

await session.restore();
bootstrap.dispose();
```

To share `sessionSpec` with the React Scope, it must have an explicit key. An unkeyed Spec remains private to each Binding even when the Bindings use the same Runtime.

## Define a stable module

Specs must be module-level stable objects because their token participates in runtime identity:

```ts
import { StateViewModel, viewModelSpec } from 'view_model/react-native';

interface CounterState {
  readonly count: number;
}

class CounterViewModel extends StateViewModel<CounterState> {
  public constructor() {
    super({ count: 0 });
  }

  public increment = (): void => {
    this.updateState((current) => ({ count: current.count + 1 }), 'counter.increment');
  };
}

export const counterSpec = viewModelSpec(() => new CounterViewModel(), {
  debugLabel: 'CounterViewModel',
});
```

Do not create `counterSpec` inside a component or hook. A new Spec creates a new token and therefore a new identity.

## Use hooks inside a Scope

### `useViewModel`

Use `useViewModel` when the component reads broad ViewModel data and should update after each ordinary notification:

```tsx
import { Button, Text, View } from 'react-native';
import { useViewModel } from 'view_model/react-native';

function CounterPanel() {
  const counter = useViewModel(counterSpec);

  return (
    <View>
      <Text>{counter.state.count}</Text>
      <Button title="Increment" onPress={counter.increment} />
    </View>
  );
}
```

The hook prepares during render and acquires the Scope Binding during commit. It subscribes to ordinary ViewModel notifications and to generation replacement.

### `useReadViewModel`

Use `useReadViewModel` for command-only components:

```tsx
import { Button } from 'react-native';
import { useReadViewModel } from 'view_model/react-native';

function IncrementButton() {
  const counter = useReadViewModel(counterSpec);
  return <Button title="Increment" onPress={counter.increment} />;
}
```

The hook still resolves, acquires, and retains the generation. It ignores ordinary ViewModel notifications, but force recycle changes its lifecycle snapshot and causes it to resolve the replacement generation.

### `useViewModelSelector`

Prefer `useViewModelSelector` when a component needs one part of a larger model:

```tsx
const count = useViewModelSelector(counterSpec, (counter) => counter.state.count);
```

The default equality is `Object.is`. Pass a third argument for structured selections:

```tsx
const summary = useViewModelSelector(
  cartSpec,
  (cart) => ({
    count: cart.state.items.length,
    total: cart.state.total,
  }),
  (previous, next) => previous.count === next.count && previous.total === next.total,
);
```

Selectors run as part of React snapshot/render work and must be pure. They may read fields already exposed by the selected ViewModel. They must not:

- mutate state;
- start asynchronous work;
- install subscriptions;
- resolve a parent ViewModel's child dependency getter.

If the UI needs child-derived data, let the parent ViewModel publish that data on its own state or fields.

### Advanced context hooks

`useViewModelRuntime()` and `useViewModelBinding()` expose the current context objects for infrastructure integrations. Normal component code should prefer the three resolution hooks above. Do not call imperative Binding methods during render.

## What a Scope owns

Every Scope creates one stable Binding. A nested Scope:

- reuses the parent Runtime by default;
- creates a different Binding;
- isolates unkeyed Specs from the parent Scope;
- can share keyed Specs through the common Runtime.

An individual hook cleanup removes that hook's listener but does not release the Binding's acquired entry. The generation remains owned until the Scope is disposed or it is force-recycled.

This makes Scope an explicit React owner boundary, not a component-by-component service locator.

To isolate both identity and pause state, inject a different Runtime into the nested Scope:

```tsx
const editorRuntime = new ViewModelRuntime();

<ViewModelScope runtime={editorRuntime}>
  <EditorSurface />
</ViewModelScope>;
```

The code that created `editorRuntime` must dispose it when the surface permanently ends.

## AppState integration

By default, the React Native Scope adapts `AppState`:

| AppState value                                           | Runtime state |
| -------------------------------------------------------- | ------------- |
| `active`                                                 | active        |
| every other value, including `inactive` and `background` | paused        |

The source uses one stable pause token. If several lifecycle sources pause the same Runtime, it resumes only after every token is removed.

Pause is Runtime-wide. It calls `onPause`/`onResume` on all activated generations and delays Binding-delivered React updates. It does not stop actions, state mutations, or direct `subscribe` callbacks.

Tests and custom React Native hosts can inject the minimal AppState shape used by the library:

```tsx
const testAppState = {
  currentState: 'active',
  addEventListener(_type: 'change', listener: (state: string) => void) {
    appStateListeners.add(listener);
    return {
      remove() {
        appStateListeners.delete(listener);
      },
    };
  },
};

<ViewModelScope appState={testAppState}>
  <Application />
</ViewModelScope>;
```

## Custom lifecycle sources

`ViewModelScope` accepts a `lifecycle` object with this contract:

```ts
interface ViewModelLifecycleSource {
  isActive(): boolean;
  subscribe(listener: (active: boolean) => void): () => void;
}
```

An explicit `lifecycle` replaces the default AppState source for that Scope; it is not automatically combined with AppState. A custom source that needs both conditions must combine them itself.

```tsx
const lifecycle = {
  isActive: () => applicationActive && navigationFocused,
  subscribe(listener: (active: boolean) => void) {
    const emit = () => listener(applicationActive && navigationFocused);
    const removeAppState = subscribeToAppState(emit);
    const removeFocus = subscribeToNavigationFocus(emit);

    return () => {
      removeFocus();
      removeAppState();
    };
  },
};
```

Installation failures are rolled back: the adapter removes its pause token before rethrowing. The returned cleanup must unsubscribe all native listeners.

## Navigation focus is not disposal

React Navigation commonly keeps blurred screens mounted. Blur should not be treated as generation disposal unless the business model genuinely requires a new owner boundary.

There is an important Runtime-level consequence: assigning a navigation-focus lifecycle to a nested Scope that shares the application Runtime pauses the entire application Runtime when that screen blurs. It does not pause only that Scope.

Choose one of these designs:

1. Keep one application Runtime and expose screen focus as ordinary ViewModel input when only screen-specific work should change.
2. Give the screen an independent Runtime when its entire graph should pause separately.
3. Use a shared Runtime navigation lifecycle only when screen blur is intentionally an application-wide pause condition.

Returning to a blurred-but-mounted screen normally resumes the same generation. Do not recycle merely to represent focus changes.

## Application-global modules

Use an explicit key for a module that must be shared by multiple Scope or plain Binding owners:

```ts
export const sessionSpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'primary-session',
  debugLabel: 'SessionViewModel',
});
```

The module is application-global only within the `applicationRuntime` supplied to those owners. Another Runtime resolves another generation with the same Spec and key.

`aliveForever` is optional and normally unnecessary while an application owner Binding remains. If used, it requires an explicit key and still ends on recycle or Runtime disposal.

## React render safety

The hooks may run the Spec builder and ViewModel constructor during render. Keep both pure. Put subscriptions and native resources in `onCreate`:

```ts
class NetworkViewModel extends ViewModel {
  protected override onCreate(): void {
    const unsubscribe = networkStatus.subscribe((status) => {
      this.handleStatus(status);
    });

    this.addDispose(unsubscribe);
  }

  private handleStatus(_status: NetworkStatus): void {
    this.notifyListeners('network.status');
  }
}
```

An abandoned render is cleaned up without calling `onCreate`, because no Binding committed the generation.

## StrictMode

In development, StrictMode may probe effects with `setup -> cleanup -> setup`. Scope disposal and lifecycle-token release are delayed by a cancellable microtask so the matching setup can retain the current Binding and inactive state.

Constructors may still be evaluated more than once across abandoned renders. Business code must not use constructor counts as lifecycle events.

## Testing

For component tests:

- create a fresh Runtime per test when isolation matters;
- inject a deterministic AppState or lifecycle source;
- render the platform `ViewModelScope` around the tested tree;
- unmount the tree before disposing an injected Runtime;
- run this repository's tests serially.

For non-React module tests, a plain Binding is usually simpler:

```ts
const runtime = new ViewModelRuntime();
const binding = runtime.createBinding({ id: 'counter-test' });

const counter = binding.read(counterSpec);
counter.increment();

binding.dispose();
runtime.dispose();
```

## Checklist

- Import from `view_model/react-native`, never `view_model/react`.
- Decide whether the Runtime is Scope-owned or application-owned.
- Use one shared Runtime plus explicit keys for application-global DI.
- Treat Scope as one React owner Binding, not as the DI container.
- Keep Specs stable at module scope.
- Use selectors for narrow rendering and `useReadViewModel` for commands.
- Keep builders, constructors, and selectors pure.
- Remember that lifecycle pause affects the entire Runtime.
- Dispose injected Runtime objects explicitly after their owner Bindings end.

See the complete example in [examples/react-native-counter](../examples/react-native-counter/README.md).
