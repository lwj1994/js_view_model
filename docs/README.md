# view_model documentation

[简体中文](./zh/README.md) · [Project README](../README.md)

`view_model` is an application architecture for React Native and Electron. It
combines an explicit dependency-injection runtime, demand-driven functional
module composition, state notifications, and owner-based lifecycle management.
ViewModels are not restricted to views: repositories, services, coordinators,
and domain capabilities can use the same runtime without React.

## Choose a path

### I am evaluating the architecture

1. [Getting started and application-wide DI](./getting-started.md)
2. [Runtime, Binding, Scope, and the ownership model](./concepts.md)
3. [Module composition and dependency injection](./dependency-injection.md)
4. [Identity, ownership, retention, and recycle](./identity-and-lifetime.md)

### I am implementing a feature

1. [ViewModel and StateViewModel](./view-models.md)
2. [Module composition and dependency injection](./dependency-injection.md)
3. [Lifecycle, StrictMode, and pause/resume](./lifecycle.md)
4. [React Native integration](./react-native.md) or
   [Electron integration](./electron.md)

### I am maintaining or reviewing a project

1. [Testing and package validation](./testing.md)
2. [API reference](./api.md)
3. [Lifecycle, StrictMode, and pause/resume](./lifecycle.md)
4. [Identity, ownership, retention, and recycle](./identity-and-lifetime.md)

## Module index

| Module                                              | What it answers                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [Getting started](./getting-started.md)             | How do I install the package, create an app Runtime, and use DI with or without React?   |
| [Core concepts](./concepts.md)                      | Why do Runtime, Binding, and Scope exist, and where are their boundaries?                |
| [ViewModels](./view-models.md)                      | How do notifications, immutable state, equality, actions, and resource hooks work?       |
| [Dependency injection](./dependency-injection.md)   | How do services, repositories, features, and coordinators compose through getter DI?     |
| [Identity and lifetime](./identity-and-lifetime.md) | What do explicit type, key, owner, generation, `aliveForever`, and `recycle` mean?       |
| [Lifecycle](./lifecycle.md)                         | What happens across React render/commit, StrictMode, pause/resume, and disposal?         |
| [React Native](./react-native.md)                   | How do Scope, hooks, AppState, navigation focus, and custom lifecycle sources interact?  |
| [Electron](./electron.md)                           | How should renderer, preload, main, windows, lifecycle, and IPC boundaries be designed?  |
| [Testing](./testing.md)                             | How do I test core modules, React bindings, lifecycle, package exports, and cleanup?     |
| [API reference](./api.md)                           | What does each currently exported class, function, hook, type, and error mean?           |
| [Flutter comparison](./flutter-comparison.md)       | Which concepts are shared with Flutter `view_model`, and which APIs or semantics differ? |

## Invariants to remember

- The DI sharing boundary is a `ViewModelRuntime`, not the React tree or the
  entire operating-system process.
- `ViewModelScope` adapts React ownership to a Runtime; it is not required by
  plain TypeScript hosts.
- Recommended Runtime identity is `(explicit ViewModel type, effective key)`.
  Builder-only Specs retain a private token as a compatibility fallback.
- Both `read` and `watch` establish ownership. Only `watch` propagates ordinary
  ViewModel notifications.
- Builders and constructors are pure. Resource work starts after acquire.
- Dependency getters run only after commit, never from render or a selector.
- Pause/resume affects every activated ViewModel in the Runtime.
- `recycle` force-disposes globally matching generations regardless of owners.

## Support boundary

Only `@lwjlol/view_model/core`, `@lwjlol/view_model/react-native`, and `@lwjlol/view_model/electron` are
public application entry points. There is no `@lwjlol/view_model/react`, and this
package makes no React Web, SSR, RSC, or browser hydration promise.
