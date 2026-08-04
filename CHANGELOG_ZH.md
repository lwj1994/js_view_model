# 变更记录

[English](./CHANGELOG.md)

本文件记录项目的显著变更。

## [Unreleased]

## [0.2.0] - 2026-08-04

### Added

- 通过 `viewModelSpec(MyViewModel, builder, options)` 新增显式 ViewModel type identity。同一 Runtime 内 type 与 key 相同的独立显式 Spec 现在会共享；builder-only 形式保留独立 token 的兼容行为。
- 新增高级的只查询 cached/tag Binding API，包括必须命中、可选命中以及按 tag 批量的 read/watch variant。
- 新增 Binding-owned `listen`、`listenState` 与 `listenStateSelect` 订阅，支持显式 disposer，并在 Binding 或 generation dispose 时自动清理。

### Changed

- npm 包使用公开 scoped 名称 `@lwjlol/view_model` 发布。
- root Binding owner source 现会沿已解析的 parent-child 图传播，并实时镜像后续 bind/unbind 变化。
- 一次完整的同步通知级联现会共享同一 transaction，每个 callback 按 Binding 去重，同时保留对不同 Binding 的投递。异步通知会开启新 transaction。
- 新增结构镜像的英文与中文模块文档。
- 明确应用级依赖注入是核心能力，并说明 Scope 只是 React owner 适配层。
- 新增可对外复用的 `js-view-model` skill。
- 源码注释统一为英文。

### Fixed

- 显式 type Spec 现在会拒绝并非该声明 type 或其子类实例的 builder 结果；同时支持使用带 protected constructor 的抽象类作为 identity。

## [0.1.0] - 2026-08-03

### Added

- 新增 `view_model/core`：ViewModel、Spec、Runtime、Binding、依赖图与自动生命周期。
- 新增 `view_model/react-native`：Scope、hooks 与 AppState pause/resume 集成。
- 新增 `view_model/electron`：renderer Scope、hooks 与窗口生命周期集成。
- 新增 keyed/unkeyed 身份、`aliveForever`、parent-child getter 注入与强制 recycle。
- 新增 React StrictMode render/commit 生命周期协调。
- 新增 ESM/CJS 输出与跨条件入口共享的 ViewModel/Spec 身份协议。

### Limitations

- 仅支持 React Native 与 Electron App。
- 不支持普通 React Web、SSR、React Server Components 或通用 DOM 应用。
- ViewModel 对象不能直接跨 Electron 进程共享。
- dependency getter 只用于 commit 后的 ViewModel 协作，不得在 React render 或 selector 中读取。
