# Changelog

本项目的显著变更记录在此文件中。

## [Unreleased]

### Changed

- 暂无。

## [0.1.0] - Alpha

### Added

- 新增 `view_model/core`：ViewModel、Spec、Runtime、Binding、依赖图与自动生命周期。
- 新增 `view_model/react-native`：Scope、hooks 与 AppState pause/resume 集成。
- 新增 `view_model/electron`：renderer Scope、hooks 与窗口生命周期集成。
- 新增 keyed/unkeyed 实例身份、`aliveForever`、父子 ViewModel getter 依赖和强制 recycle。
- 新增 StrictMode render/commit 生命周期协调。
- 新增 ESM/CJS 双格式输出与跨条件入口的统一 ViewModel/Spec 身份协议。

### Known limitations

- 当前为 **v0.1 Alpha**，API 可能调整。
- 仅支持 React Native 与 Electron App。
- 不支持普通 React Web、SSR、React Server Components 或通用 DOM 应用。
- 不支持跨 Electron 进程直接共享 ViewModel 对象。
- 依赖 getter 只用于 commit 后的 ViewModel 内部协作，不支持在 React render/selector 中读取。
