# Changelog

[简体中文](./CHANGELOG_ZH.md)

Significant changes to this project are recorded here.

## [Unreleased]

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
