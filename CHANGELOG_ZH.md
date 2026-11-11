# 变更记录

[English](./CHANGELOG.md)

本文件记录项目的显著变更。

## [Unreleased]

## [0.5.0] - 2026-11-11

- 新增 HarmonyOS / ArkUI 回调适配预览，支持组件级 Binding、`watch`/`read`、recycle 恢复，以及独立的应用/窗口生命周期 token。`onUpdate` 延后（默认 microtask，或使用 `scheduleUpdate`）并合并投递，避免 ArkUI 拷贝中间状态；`scope.setVisible` 只暂停共享 Runtime 上该页面的刷新；`createViewModelHarmonyLifecycle` 支持初始 `active: false`。
- 新增本地 OHPM 包构建，输出 ES2017 JavaScript、共享 core 身份和 TypeScript 声明，不依赖其他 UI 框架；同时提供 TS 门面 / ArkUI V2 计数器示例及中英文集成文档。
- 新增适配器、npm 入口、隔离 OHPM 产物和 TS 门面验证。基于 Node 的检查不覆盖 ArkTS 编译与鸿蒙真机验证。

## [0.4.0] - 2026-10-29

- 按 Flutter 1.2.1 `c5e57d8` 对齐共享核心，包括 PR #82 与后续重入所有权、状态事件修复；保留不与 build 耦合的 Binding 生命周期。
- **破坏性改动：** update 同步/异步成功后自动通知；移除 onDependencyNotify；listenState/listenStateSelect 使用 (previous, current)；业务通知不去重，仅合并根界面刷新。
- 增加 arg1-4 family、可恢复 override、隔离 Runtime 异步覆盖、全局配置/观察者/错误报告、状态历史、unbind、局部界面暂停和调试快照。
- 提交精确 owner/edge 后再运行回调，修复重入 rollback、过期 release、批量缓存原子性、错误 key 命中回退与跨 ESM/CJS 身份。
- 更新中英文 API、教程、skill 和迁移矩阵；补充核心/React/Vue/产物回归。
- 新增可选的类型感知 ESLint 插件 `@lwjlol/view_model/eslint`，对齐 Flutter `view_model_lint` 1.3.3 `0a94737`：十条默认警告、可选的 `cached-lookup` 规则，可由 `eslint --fix` 应用的 `cached-instance`、`alive-forever-key`、`temporary-spec` 修复，以及仅检查 React 的 `selector-with-watch` 的 IDE 建议。推荐配置覆盖 TypeScript 文件。规则需要 typescript-eslint 类型信息；`eslint`、`typescript` 与 `@typescript-eslint/parser` 为可选 peer，该入口不会加载 runtime。新增中英文规则指南，正反示例均由测试校验。
- 记录 Android 0.10.0 与 Apple 0.13.0 背后的宿主契约，runtime 不变：plain Binding 的 `onUpdate` 是同步 transaction 第一个 watched 事件时的刷新请求，宿主应延后读取，并让 Binding 与其捕获的宿主一起 dispose；异步 action 每次 `await` 后先检查 `isDisposed` 再解析依赖。快速开始与 Electron 示例改为延后渲染，示例不再把已解析的 ViewModel 存进模块变量。
- 修复开发依赖审计：Vitest 4.1.12，以及兼容的 brace-expansion、source-map-js 锁文件更新。
- 不新增 Flutter 生成器/DevTools/Widget API，也不新增 React Web/SSR 入口；异步覆盖明确使用传入 Runtime。

## [0.3.1] - 2026-09-08

- 修复缺少 `queueMicrotask` 的宿主（包括小程序运行时）中的生命周期调度。内部统一优先使用原生 API，缺失时降级为 Promise 微任务；回调异常通过定时器重新抛出，保留未捕获异常上报，避免变为未处理的 Promise rejection。

## [0.3.0] - 2026-09-07

- 新增可选 Vue 3 与 Taro 4 桥接，支持组件级 Binding、响应式 ref、selector、recycle 恢复，以及显式应用/独立页面生命周期集成。

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
