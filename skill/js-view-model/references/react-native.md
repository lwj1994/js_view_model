# React Native integration

Use `view_model/react-native` for Scope and hooks. It re-exports the core API,
but importing ViewModel classes and Specs from `view_model/core` keeps the
platform boundary explicit.

## Root setup

```tsx
import { ViewModelRuntime } from 'view_model/core';
import { ViewModelScope } from 'view_model/react-native';

export const appRuntime = new ViewModelRuntime();

export function App(): React.JSX.Element {
  return (
    <ViewModelScope runtime={appRuntime}>
      <RootNavigator />
    </ViewModelScope>
  );
}
```

Omit `runtime` when the root Scope should create and own its own Runtime. When a
Runtime is injected, the caller must dispose it at the real application/test
shutdown boundary.

Scope is the React owner adapter. It provides one stable Binding to hooks and
delays ownership until commit. It is not required by non-React services, which
use `appRuntime.createBinding()`.

## Hooks

- `useViewModel(spec)`: own the instance and rerender on every ordinary
  ViewModel notification.
- `useReadViewModel(spec)`: own the instance without rerendering on ordinary
  notifications; generation recycle still causes re-resolution.
- `useViewModelSelector(spec, selector, equals?)`: own/watch the instance and
  rerender only when the selected value changes. Equality defaults to
  `Object.is`.
- `useViewModelBinding()` / `useViewModelRuntime()`: advanced access to the
  current owner objects. Do not imperatively acquire a ViewModel during render.

Keep Specs at module scope. Keep selectors pure, expect them to run more than
once, and pass `equals` for structural results. Use arrow-function actions or
bind methods explicitly before passing them as callbacks.

One hook cleanup removes that hook subscription only. The Scope Binding keeps
its ownership entry until Scope disposal or recycle. Put screen-local modules
inside a screen owner Scope if they must be released when that screen truly
unmounts; an application root Scope otherwise owns them for the root lifetime.

## AppState

The default Scope maps only `AppState.currentState === 'active'` to active.
`null`, `inactive`, `background`, and unknown values pause the Runtime.

Use `appState` to inject a test/custom object with the minimal AppState shape.
Use `lifecycle` to replace the default AppState source entirely.

All lifecycle sources call Runtime-level pause/resume. A nested Scope that
inherits the parent Runtime does not get local pause semantics: when its source
is inactive, every activated ViewModel in the shared Runtime is paused. Use a
separate Runtime for an independently paused subtree, and dispose an injected
Runtime explicitly. Alternatively model navigation focus as ordinary state.

If an independent screen Runtime must consider both AppState and navigation
focus, provide one custom lifecycle source that combines both conditions; the
`lifecycle` prop replaces the default AppState adapter.

## Minimal consumer

```tsx
function CartButton(): React.JSX.Element {
  const count = useViewModelSelector(cartSpec, (cart) => cart.state.ids.length);
  const cart = useReadViewModel(cartSpec);

  return <Button title={`Items: ${count}`} onPress={() => cart.add('sku-1', 12)} />;
}
```

Never access a parent ViewModel's dependency getter from the selector or JSX.
Expose UI state on the parent and perform module collaboration from actions.
