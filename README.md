# view_model

[![CI](https://github.com/lwj1994/js_view_model/actions/workflows/ci.yml/badge.svg)](https://github.com/lwj1994/js_view_model/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[简体中文](./README_ZH.md)

Application-wide dependency injection, functional-module composition, state
management, and automatic lifecycle management for **React Native** and
**Electron**.

`view_model` is not limited to screen state. A feature, repository, service,
coordinator, device connection, or domain capability can all be managed
ViewModels. They resolve one another lazily through `viewModelBinding`, share
instances within an explicit `ViewModelRuntime`, and release resources when
their final owner leaves.

> [!WARNING]
> **v0.1 Alpha:** APIs may still change. Pin the version and validate it in a
> non-critical project first.
>
> This package supports React Native and Electron applications only. It does
> not support ordinary React Web, SSR, React Server Components, or general DOM
> applications.

## Application-wide DI, not a UI-only store

The core runtime works without React. An application can create one runtime at
its composition root and use plain bindings from bootstrap code, background
services, Electron main, tests, or any other TypeScript host:

```ts
import { StateViewModel, ViewModel, ViewModelRuntime, viewModelSpec } from 'view_model/core';

type SessionState = Readonly<{ token: string | null }>;

interface Order {
  readonly id: string;
}

declare const ordersApi: {
  list(token: string): Promise<readonly Order[]>;
};

class SessionViewModel extends StateViewModel<SessionState> {
  public constructor() {
    super({ token: null });
  }

  public requireToken(): string {
    const token = this.state.token;
    if (token === null) throw new Error('Authentication required.');
    return token;
  }
}

export const sessionSpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'application-session',
  aliveForever: true,
  debugLabel: 'Session',
});

class OrdersRepository extends ViewModel {
  private get session(): SessionViewModel {
    return this.viewModelBinding.read(sessionSpec);
  }

  public async load(): Promise<readonly Order[]> {
    return ordersApi.list(this.session.requireToken());
  }
}

export const ordersRepositorySpec = viewModelSpec(() => new OrdersRepository());

export const appRuntime = new ViewModelRuntime();
const bootstrapBinding = appRuntime.createBinding({ id: 'application-bootstrap' });

await bootstrapBinding.read(ordersRepositorySpec).load();

// Release this host when bootstrap ownership ends. Dispose the application
// runtime at the real process/application shutdown boundary.
bootstrapBinding.dispose();
```

This example uses `aliveForever` only to preserve the session across an
intentional zero-owner handoff. If an application Binding continuously owns the
session, keep the Spec keyed for cross-Binding sharing and omit
`aliveForever`.

The same `appRuntime` can be injected into a React Native or Electron renderer
`ViewModelScope`. A keyed Spec then resolves to the same generation across
plain hosts and React Scopes in that runtime. “Application-wide” means one
explicit runtime inside one JavaScript realm; ViewModel objects never cross an
Electron process boundary.

## Why React needs a Scope

`ViewModelScope` is a React owner adapter, not the DI container itself. It:

1. provides hooks with the current Runtime and one stable Binding;
2. converts React render/commit/unmount into safe prepare/acquire/release
   operations; and
3. defines the private identity and release boundary for unkeyed instances.

Without a Scope, a hook would not know which runtime owns an instance or when
that ownership ends. Non-React code does not need a Scope; it uses
`runtime.createBinding()` directly.

A nested Scope inherits its parent Runtime by default but creates a separate
Binding. This isolates unkeyed instances while allowing `(Spec token, key)`
instances to be shared. A Scope that receives an external Runtime does not own
it; the caller must eventually dispose that Runtime.

One subtle but important rule: lifecycle pause/resume is Runtime-wide. If two
Scopes share a Runtime, an inactive lifecycle source on either Scope pauses all
activated ViewModels in that Runtime. Use a separate Runtime for an independently
paused screen/window, or model focus as ordinary application state.

## Supported entry points

| Environment                                 | Entry point               | Status          |
| ------------------------------------------- | ------------------------- | --------------- |
| Platform-neutral TypeScript / Electron main | `view_model/core`         | Alpha           |
| React Native                                | `view_model/react-native` | Alpha           |
| Electron renderer                           | `view_model/electron`     | Alpha           |
| Ordinary React Web / SSR                    | None                      | **Unsupported** |

The platform entries re-export the core API. Import ViewModel classes and Specs
from `view_model/core`, and import Scope/hooks from the relevant platform entry
to keep the runtime boundary visible. There is deliberately no
`view_model/react` export.

## Install from source

v0.1 Alpha is currently distributed from GitHub and has not been published to
npm. Build and pack it locally:

```sh
git clone https://github.com/lwj1994/js_view_model.git
cd js_view_model
npm install
npm run build
npm pack
```

Install the generated archive in the target application:

```sh
npm install /absolute/path/to/js_view_model/view_model-0.1.0.tgz
```

After a future npm release, installation will become:

```sh
npm install view_model
```

React Native applications must provide compatible `react` and `react-native`
peers. Electron renderer applications must provide React and their renderer;
the host application provides Electron. See the current `package.json` for the
exact peer ranges.

## React Native quick start

Declare Specs at module scope so their identity remains stable across renders:

```tsx
import { Button, Text, View } from 'react-native';
import { StateViewModel, viewModelSpec } from 'view_model/core';
import { ViewModelScope, useReadViewModel, useViewModelSelector } from 'view_model/react-native';

class CounterViewModel extends StateViewModel<Readonly<{ count: number }>> {
  public constructor() {
    super({ count: 0 });
  }

  public readonly increment = (): void => {
    this.updateState(({ count }) => ({ count: count + 1 }), 'counter.increment');
  };
}

const counterSpec = viewModelSpec(() => new CounterViewModel(), {
  debugLabel: 'Counter',
});

function Counter(): React.JSX.Element {
  const count = useViewModelSelector(counterSpec, (counter) => counter.state.count);
  const counter = useReadViewModel(counterSpec);

  return (
    <View>
      <Text>{count}</Text>
      <Button title="Increment" onPress={counter.increment} />
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

The default React Native Scope maps `AppState === 'active'` to resume and every
other state to pause.

## Electron renderer quick start

Each renderer/window should normally own its top-level Scope and Runtime. The
default lifecycle considers the renderer active only while the window is
focused and the document is visible:

```tsx
import { createRoot } from 'react-dom/client';
import { StateViewModel, viewModelSpec } from 'view_model/core';
import { ViewModelScope, useReadViewModel, useViewModelSelector } from 'view_model/electron';

class WindowCounter extends StateViewModel<number> {
  public constructor() {
    super(0);
  }

  public readonly increment = (): void => {
    this.updateState((count) => count + 1, 'counter.increment');
  };
}

const counterSpec = viewModelSpec(() => new WindowCounter());

function App(): React.JSX.Element {
  const count = useViewModelSelector(counterSpec, (counter) => counter.state);
  const counter = useReadViewModel(counterSpec);
  return <button onClick={counter.increment}>Count: {count}</button>;
}

createRoot(document.getElementById('root')!).render(
  <ViewModelScope>
    <App />
  </ViewModelScope>,
);
```

Electron main does not use hooks. Use `ViewModelRuntime` and a plain Binding,
then expose serializable DTOs/events through a narrow preload IPC API.

## Core rules

- Keep each `ViewModelSpec` stable at module scope. Runtime identity is the
  stable **Spec token plus key**, not the ViewModel class or key alone.
- Both `watch` and `read` create/resolve an instance and establish lifecycle
  ownership. Only `watch` propagates ordinary ViewModel notifications.
- Unkeyed instances are private to a Binding. A key shares one Spec identity
  across Bindings in the same Runtime. `aliveForever` requires an explicit key.
- Builders and constructors must remain pure. Start timers, IPC, native
  subscriptions, and other resources in `onCreate`, and register cleanup with
  `addDispose`.
- Resolve child modules through non-caching `viewModelBinding.read/watch`
  getters. Access those getters only after commit, from ViewModel actions or
  lifecycle/internal collaboration—not from React render or selectors.
- `recycle` is a Runtime-wide force-dispose operation that overrides every
  owner. Prefer a new explicit key unless global invalidation is intentional.
- One hook cleanup removes only that hook listener. The Scope Binding retains
  ownership until the Scope itself is disposed or the generation is recycled.

## Documentation

- [Documentation index](./docs/README.md)
- [Getting started and application-wide DI](./docs/getting-started.md)
- [Runtime, Binding, Scope, and architecture](./docs/concepts.md)
- [ViewModel and StateViewModel](./docs/view-models.md)
- [Module composition and dependency injection](./docs/dependency-injection.md)
- [Identity, ownership, and recycle](./docs/identity-and-lifetime.md)
- [Lifecycle, StrictMode, and pause/resume](./docs/lifecycle.md)
- [React Native integration](./docs/react-native.md)
- [Electron integration](./docs/electron.md)
- [Testing and package validation](./docs/testing.md)
- [API reference](./docs/api.md)
- [Differences from Flutter `view_model`](./docs/flutter-comparison.md)

Every module has a matching Chinese document linked from its first line.

## Install the Codex skill

The repository includes a reusable skill for implementing and reviewing
`view_model` architecture:

```sh
npx skills add https://github.com/lwj1994/js_view_model --skill js-view-model
```

Its source is in [`skill/js-view-model`](./skill/js-view-model/SKILL.md).

## License

[MIT](./LICENSE)
