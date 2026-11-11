# Changelog

[简体中文](./CHANGELOG_ZH.md)

Significant changes to this project are recorded here.

## [Unreleased]

## [0.5.0] - 2026-11-11

- Added a HarmonyOS / ArkUI callback adapter preview with component-owned Bindings, `watch`/`read`, recycle recovery, and independent app/window lifecycle tokens. `onUpdate` is deferred (microtask by default, or `scheduleUpdate`) and coalesced so ArkUI never copies an intermediate state; `scope.setVisible` pauses only that page's refresh on a shared Runtime; `createViewModelHarmonyLifecycle` accepts an initial `active: false`.
- Added a local OHPM package build with ES2017 JavaScript output, shared core identity, TypeScript declarations, and no framework dependencies, plus a TS facade / ArkUI V2 counter example and mirrored integration guides.
- Added adapter, npm export, isolated OHPM artifact, and TS facade checks. ArkTS compilation and HarmonyOS device validation are not covered by the Node-based checks.

## [0.4.0] - 2026-10-29

- Align shared core to Flutter 1.2.1 `c5e57d8`, including PR #82 and subsequent ownership/state reentry fixes. Keep Binding lifetime independent of build/render passes.
- **Breaking:** update auto-notifies after sync/async success; remove onDependencyNotify; listenState/listenStateSelect take (previous, current); preserve every business event and coalesce only root visual refresh.
- Add arg1-4 families, restorable overrides and isolated Runtime async scopes, global configuration/observers/error reporting, state history, unbind, local visual pause and diagnostic snapshots.
- Commit exact owner/edge registrations before callbacks; fix reentrant rollback, obsolete releases, tag-batch atomicity, invalid key-hit fallbacks and cross-ESM/CJS identity.
- Update mirrored API/tutorial/skill/migration documentation and add core/React/Vue/built-package regressions.
- Add the optional type-aware ESLint plugin `@lwjlol/view_model/eslint`, aligned to Flutter `view_model_lint` 1.3.3 `0a94737`: ten default warnings, the opt-in `cached-lookup` rule, `eslint --fix` fixes for `cached-instance`, `alive-forever-key`, and `temporary-spec`, and an IDE suggestion for the React-only `selector-with-watch`. The recommended config covers TypeScript files. The rules need typescript-eslint type information; `eslint`, `typescript`, and `@typescript-eslint/parser` are optional peers, and the entry never loads the runtime. Add mirrored rule guides whose good and bad examples are verified by tests.
- Document the host contracts behind Android 0.10.0 and Apple 0.13.0 without runtime changes: a plain Binding's `onUpdate` is a refresh request at the first watched event of a synchronous transaction, so hosts defer their read and dispose a Binding with the host it captures; async actions check `isDisposed` after each `await` before resolving dependencies. The getting-started and Electron examples now defer rendering, and no example stores a resolved ViewModel in a module variable.
- Remediate development dependency audit with Vitest 4.1.12 and compatible brace-expansion/source-map-js lockfile updates.
- Do not add Flutter generators/DevTools/Widget APIs or React Web/SSR entries. Async overrides explicitly use the supplied Runtime.

## [0.3.1] - 2026-09-08

- Fixed lifecycle microtask scheduling on hosts without `queueMicrotask` (including mini-program runtimes). The internal scheduler prefers the native API and falls back to Promise microtasks; callback failures are rethrown in a timer as uncaught exceptions, rather than unhandled Promise rejections.

## [0.3.0] - 2026-09-07

- Added optional Vue 3 and Taro 4 bridges with component-owned Bindings, reactive refs, selectors, recycle recovery, and explicit application/isolated-page lifecycle integration.

## [0.2.0] - 2026-08-04

### Added

- Added explicit ViewModel type identity through
  `viewModelSpec(MyViewModel, builder, options)`. Independent explicit Specs
  with the same type and key now share within one Runtime; the builder-only
  form retains its independent-token compatibility behavior.
- Added advanced lookup-only cached/tag Binding APIs, including required,
  optional, and tag-batch read/watch variants.
- Added Binding-owned `listen`, `listenState`, and `listenStateSelect`
  subscriptions with explicit disposers and automatic cleanup on Binding or
  generation disposal.

### Changed

- Published the npm package under the public scoped name `@lwjlol/view_model`.
- Root Binding owner sources now propagate through resolved parent-child graphs
  and mirror later bind/unbind changes in real time.
- A complete synchronous notification cascade now shares one transaction,
  deduplicating each callback per Binding while preserving deliveries to
  distinct Bindings. Asynchronous notifications start a new transaction.
- Added mirrored English and Chinese module documentation.
- Documented application-wide dependency injection as a core capability and
  clarified that Scope is a React owner adapter.
- Added the externally reusable `js-view-model` skill.
- Standardized source-code comments in English.

### Fixed

- Explicit type Specs now reject builder results that are not instances of the
  declared type or one of its subclasses. Abstract identity classes with
  protected constructors are supported.

## [0.1.0] - 2026-08-03

### Added

- Added `view_model/core` with ViewModel, Spec, Runtime, Binding, dependency
  graphs, and automatic lifecycle management.
- Added `view_model/react-native` with Scope, hooks, and AppState pause/resume
  integration.
- Added `view_model/electron` with renderer Scope, hooks, and window lifecycle
  integration.
- Added keyed/unkeyed identity, `aliveForever`, parent-child getter injection,
  and forceful recycle.
- Added React StrictMode render/commit lifecycle coordination.
- Added ESM/CJS output and a shared cross-condition ViewModel/Spec identity
  protocol.

### Limitations

- Only React Native and Electron applications are supported.
- Ordinary React Web, SSR, React Server Components, and general DOM
  applications are unsupported.
- ViewModel objects cannot be shared directly between Electron processes.
- Dependency getters are for post-commit ViewModel collaboration and cannot be
  read during React render or selectors.
