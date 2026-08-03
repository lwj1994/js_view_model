# Changelog

[简体中文](./CHANGELOG_ZH.md)

Significant changes to this project are recorded here.

## [Unreleased]

### Changed

- Added mirrored English and Chinese module documentation.
- Documented application-wide dependency injection as a core capability and
  clarified that Scope is a React owner adapter.
- Added the externally reusable `js-view-model` skill.
- Standardized source-code comments in English.

## [0.1.0] - Alpha

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

### Known limitations

- v0.1 is Alpha and its API may change.
- Only React Native and Electron applications are supported.
- Ordinary React Web, SSR, React Server Components, and general DOM
  applications are unsupported.
- ViewModel objects cannot be shared directly between Electron processes.
- Dependency getters are for post-commit ViewModel collaboration and cannot be
  read during React render or selectors.
