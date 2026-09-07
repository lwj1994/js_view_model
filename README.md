# view_model — State Management, Dependency Injection, and Module Architecture

[![CI](https://github.com/lwj1994/js_view_model/actions/workflows/ci.yml/badge.svg)](https://github.com/lwj1994/js_view_model/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40lwjlol%2Fview_model.svg)](https://www.npmjs.com/package/@lwjlol/view_model)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[简体中文](./README_ZH.md)

**More than state management: view_model is a TypeScript architecture for
application-wide dependency injection, functional-module composition, and
automatic lifecycle management in React Native and Electron, with optional Vue 3 / Taro 4 bridges.**

Published on npm as [`@lwjlol/view_model`](https://www.npmjs.com/package/@lwjlol/view_model).

`view_model` is not limited to screen state. A feature, repository, service,
coordinator, device connection, or domain capability can all be managed
ViewModels. They resolve one another lazily through `viewModelBinding`, share
instances within an explicit `ViewModelRuntime`, and release resources when
their final owner leaves.

```sh
npm install @lwjlol/view_model@0.3.0
```

## Install Skill

```sh
npx skills add https://github.com/lwj1994/js_view_model --skill js-view-model
```

The skill is designed for implementation and architecture review. Its source
is in [`skill/js-view-model`](./skill/js-view-model/SKILL.md).

> [!IMPORTANT]
> This package supports React Native, Electron, and optional Taro 4 + Vue 3 integration.
> Ordinary React Web, SSR, and React Server Components remain unsupported.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Two Core Roles](#two-core-roles)
- [Application-wide DI](#application-wide-di-not-a-ui-only-store)
- [Why React Needs a Scope](#why-react-needs-a-scope)
- [ViewModel-to-ViewModel Dependencies](#viewmodel-to-viewmodel-dependencies)
- [Supported Entry Points](#supported-entry-points)
- [Getting Started](#getting-started)
- [Core Rules](#core-rules)
- [Documentation](#documentation)

---

## Architecture Overview

The TypeScript implementation follows the same managed-module direction as
the Flutter package, with explicit Runtime boundaries for JavaScript realms:

```text
Application / Consumer Layer
├── React Native ViewModelScope + hooks
├── Electron renderer ViewModelScope + hooks
└── Plain TypeScript host (bootstrap, service, Electron main, test)
                 │ read / watch / listen
                 ▼
ViewModelRuntime + ViewModelBinding
├── Runtime: identity, keyed sharing, dependency graph, pause state
├── Binding: owner, resolver, notification adapter
└── Scope: React adapter that owns one stable Binding
                 │ acquire / release
                 ▼
Managed ViewModel Generations
└── Per-generation dependency Binding → lazily resolved children
```

Key mechanics:

1. Both `watch(spec)` and `read(spec)` resolve and own a generation; only
   `watch` propagates ordinary ViewModel notifications.
2. A Runtime is the application DI and sharing boundary inside one JavaScript
   realm. A Binding represents one owner inside that Runtime.
3. Unkeyed identity is private to a Binding. An explicit ViewModel type and key
   share one generation across Bindings in the same Runtime.
4. Every parent generation lazily owns a dependency Binding. Resolving a child
   establishes a managed parent edge and propagates current root owner sources.
5. When the last owner edge leaves, a non-`aliveForever` generation is disposed
   automatically. `recycle` force-disposes it regardless of owners.

## Two Core Roles

`ViewModel` and `StateViewModel<TState>` are the managed side: application
modules gain notifications, dependency access, lifecycle hooks, and registered
cleanup. `ViewModelRuntime` and `ViewModelBinding` are the managing side: they
resolve identities, own generations, propagate updates, and release resources.

React `ViewModelScope` is a thin platform adapter over that managing side. It
does not turn the library into a UI-only store; plain TypeScript hosts use the
same Runtime through `runtime.createBinding()`.

## Application-wide DI, not a UI-only store

The core runtime works without React. An application can create one runtime at
its composition root and use plain bindings from bootstrap code, background
services, Electron main, tests, or any other TypeScript host:

```ts
import {
  StateViewModel,
  ViewModel,
  ViewModelRuntime,
  viewModelSpec,
} from '@lwjlol/view_model/core';

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

export const sessionSpec = viewModelSpec(SessionViewModel, () => new SessionViewModel(), {
  key: 'application-session',
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

export const ordersRepositorySpec = viewModelSpec(OrdersRepository, () => new OrdersRepository());

export const appRuntime = new ViewModelRuntime();
const applicationBinding = appRuntime.createBinding({ id: 'application' });

await applicationBinding.read(ordersRepositorySpec).load();

// Release the application owner before disposing the Runtime at shutdown.
export function shutdownApplication(): void {
  applicationBinding.dispose();
  appRuntime.dispose();
}
```

The long-lived application Binding is a real owner, so `aliveForever` is not
needed. The explicit session key exists only because independent plain and
React Bindings may intentionally share that generation. Use `aliveForever`
only for deliberate zero-owner retention.

The same `appRuntime` can be injected into a React Native or Electron renderer
`ViewModelScope`. The same explicit ViewModel type and key then resolve to one
generation across plain hosts and React Scopes in that runtime. “Application-wide”
means one explicit runtime inside one JavaScript realm; ViewModel objects never
cross an Electron process boundary.

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
Binding. This isolates unkeyed instances while allowing an explicit ViewModel
type plus explicit key to be shared. A Scope that receives an external Runtime
does not own it; the caller must eventually dispose that Runtime.

One subtle but important rule: lifecycle pause/resume is Runtime-wide. If two
Scopes share a Runtime, an inactive lifecycle source on either Scope pauses all
activated ViewModels in that Runtime. Use a separate Runtime for an independently
paused screen/window, or model focus as ordinary application state.

## ViewModel-to-ViewModel Dependencies

Resolve managed child modules through a non-caching getter on the parent. The
getter declaration creates nothing by itself; access after attachment calls
`viewModelBinding.read/watch(spec)`, establishes a parent-owned lifecycle edge,
and can resolve a fresh generation after explicit `recycle`.

### Keep ViewModel instances inside their Binding boundary

Do not pass a resolved ViewModel instance through component props, constructor
arguments, globals, registries, callback payloads, or ad-hoc caches. Such a
reference is invisible to the Runtime: it does not acquire ownership, establish
a parent dependency edge, or define when the receiver must release the instance.
The code may appear to work while the original owner remains alive, then retain
a stale or disposed generation after Scope disposal or `recycle`.

Pass a stable `ViewModelSpec`, business key/ID, immutable DTO, or plain port
instead. React consumers resolve the Spec from their Scope; plain hosts resolve
it from their own Binding; parent ViewModels resolve it through a non-caching
`viewModelBinding.read/watch` getter. If separate Bindings must receive the same
generation, use the same Runtime with an explicit key—never instance passing as
a substitute for managed sharing.

## Supported entry points

| Environment                                 | Entry point                       | Status          |
| ------------------------------------------- | --------------------------------- | --------------- |
| Platform-neutral TypeScript / Electron main | `@lwjlol/view_model/core`         | Supported       |
| React Native                                | `@lwjlol/view_model/react-native` | Supported       |
| Electron renderer                           | `@lwjlol/view_model/electron`     | Supported       |
| Vue 3 bridge                                | `@lwjlol/view_model/vue`          | Optional        |
| Taro 4 + Vue 3                              | `@lwjlol/view_model/taro-vue`     | Optional        |
| Ordinary React Web / SSR                    | None                              | **Unsupported** |

The platform entries re-export the core API. Import ViewModel classes and Specs
from `@lwjlol/view_model/core`, and import Scope/hooks from the relevant platform entry
to keep the runtime boundary visible. There is deliberately no
`@lwjlol/view_model/react` export.

Choose the entry for your platform. Framework peers are optional and are not
installed automatically with this package. Existing projects only need to install
`@lwjlol/view_model`; keep the framework versions already managed by the project.

| Choose one platform | Import                            | Required host dependencies                           |
| ------------------- | --------------------------------- | ---------------------------------------------------- |
| React Native        | `@lwjlol/view_model/react-native` | `react`, `react-native`                              |
| Electron renderer   | `@lwjlol/view_model/electron`     | `react`; Electron provided by the host               |
| Taro 4 + Vue 3      | `@lwjlol/view_model/taro-vue`     | `vue`, `@tarojs/taro`, the project's Taro Vue plugin |

The core entry needs none of these frameworks. Other adapters are included as small
files in the same npm package, but are not loaded by your selected entry. Repository
`devDependencies` are for developing this library and are not consumer dependencies.
See `package.json` for exact peer ranges.

## Vue 3 + Taro 4 optional bridge

Import from `@lwjlol/view_model/taro-vue` in Taro page setup; use
`@lwjlol/view_model/vue` for the underlying Vue bridge. Only these entries
require Vue; only `taro-vue` requires Taro. Existing RN/Electron users do not
need either peer. See [Vue and Taro integration](./docs/vue-taro.md) for setup,
ref access, ownership, and lifecycle examples.

## Getting Started

### React Native

Declare Specs at module scope to avoid render-time allocation and keep their
builders and options stable:

```tsx
import { Button, Text, View } from 'react-native';
import { StateViewModel, viewModelSpec } from '@lwjlol/view_model/core';
import {
  ViewModelScope,
  useReadViewModel,
  useViewModelSelector,
} from '@lwjlol/view_model/react-native';

class CounterViewModel extends StateViewModel<Readonly<{ count: number }>> {
  public constructor() {
    super({ count: 0 });
  }

  public readonly increment = (): void => {
    this.updateState(({ count }) => ({ count: count + 1 }), 'counter.increment');
  };
}

const counterSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel(), {
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

### Electron renderer

Each renderer/window should normally own its top-level Scope and Runtime. The
default lifecycle considers the renderer active only while the window is
focused and the document is visible:

```tsx
import { createRoot } from 'react-dom/client';
import { StateViewModel, viewModelSpec } from '@lwjlol/view_model/core';
import {
  ViewModelScope,
  useReadViewModel,
  useViewModelSelector,
} from '@lwjlol/view_model/electron';

class WindowCounter extends StateViewModel<number> {
  public constructor() {
    super(0);
  }

  public readonly increment = (): void => {
    this.updateState((count) => count + 1, 'counter.increment');
  };
}

const counterSpec = viewModelSpec(WindowCounter, () => new WindowCounter());

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

- Prefer `viewModelSpec(MyViewModel, () => new MyViewModel(), options)`. Within
  one Runtime, explicit identity is the **ViewModel type plus effective key**;
  an omitted key is private to the Binding. Separate explicit Specs with the
  same type and key share one generation.
- Keep Specs stable at module scope to avoid render-time allocation and keep
  builders/options consistent. The builder-only form remains a compatibility
  fallback, where each Spec receives an independent identity token.
- Both `watch` and `read` create/resolve an instance and establish lifecycle
  ownership. Only `watch` propagates ordinary ViewModel notifications.
- One complete synchronous notification cascade shares a transaction. The same
  callback delivery is deduplicated per Binding, while separate Bindings still
  receive their own update; asynchronous notifications start a new transaction.
- Unkeyed instances are private to a Binding. An explicit key shares one
  explicit ViewModel type identity across Bindings in the same Runtime.
  `aliveForever` requires an explicit key.
- Builders and constructors must remain pure. Start timers, IPC, native
  subscriptions, and other resources in `onCreate`, and register cleanup with
  `addDispose`.
- Resolve child modules through non-caching `viewModelBinding.read/watch`
  getters. Access those getters only after commit, from ViewModel actions or
  lifecycle/internal collaboration—not from React render or selectors.
- Never pass resolved ViewModel instances between owners. Pass Specs, keys/IDs,
  immutable DTOs, or plain ports, then let the receiver resolve through its own
  Binding so ownership, dependency edges, recycle, and disposal remain managed.
- Root Binding ownership sources attached to a parent propagate to its resolved
  children, including later bind/unbind changes in real time.
- Cached/tag Binding APIs (`readCached`, `watchCached`, their `maybe` variants,
  and `readCachesByTag`/`watchCachesByTag`) are advanced lookup-only tools. They
  never create a missing generation, and tags do not participate in identity.
- Use `binding.listen`, `listenState`, or `listenStateSelect` for Binding-owned
  side-effect subscriptions. Their disposer supports early cleanup; Binding
  disposal or generation recycle also removes them automatically.
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

## License

[MIT](./LICENSE)
