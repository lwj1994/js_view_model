# view_model 文档

[English](../README.md) · [项目 README](../../README_ZH.md)

`view_model` 是面向 React Native 与 Electron 的应用架构。它组合了显式依赖注入 Runtime、按需功能模块组合、状态通知与 owner 驱动的生命周期管理。ViewModel 不只服务 View；repository、service、coordinator 与领域能力都能在不依赖 React 的情况下使用同一套 Runtime。

## 按目标阅读

### 评估整体架构

1. [快速开始与应用级 DI](./getting-started.md)
2. [Runtime、Binding、Scope 与 owner 模型](./concepts.md)
3. [模块组合与依赖注入](./dependency-injection.md)
4. [身份、owner、保活与 recycle](./identity-and-lifetime.md)

### 实现业务功能

1. [ViewModel 与 StateViewModel](./view-models.md)
2. [模块组合与依赖注入](./dependency-injection.md)
3. [生命周期、StrictMode 与暂停恢复](./lifecycle.md)
4. [React Native 集成](./react-native.md)或 [Electron 集成](./electron.md)

### 维护或审查项目

1. [测试与包验证](./testing.md)
2. [API 参考](./api.md)
3. [生命周期、StrictMode 与暂停恢复](./lifecycle.md)
4. [身份、owner、保活与 recycle](./identity-and-lifetime.md)

## 模块索引

| 模块                                         | 解决的问题                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| [快速开始](./getting-started.md)             | 如何安装、创建应用 Runtime，并在 React 内外使用 DI？                      |
| [核心概念](./concepts.md)                    | Runtime、Binding、Scope 为什么存在，边界分别在哪里？                      |
| [ViewModel](./view-models.md)                | 通知、不可变状态、判等、action 与资源 hook 如何工作？                     |
| [依赖注入](./dependency-injection.md)        | service、repository、feature 与 coordinator 如何通过 getter DI 组合？     |
| [身份与生命周期](./identity-and-lifetime.md) | 显式 type、key、owner、generation、`aliveForever`、`recycle` 分别是什么？ |
| [生命周期](./lifecycle.md)                   | React render/commit、StrictMode、pause/resume 与 dispose 之间发生什么？   |
| [React Native](./react-native.md)            | Scope、hooks、AppState、导航 focus 与自定义 lifecycle source 如何交互？   |
| [Electron](./electron.md)                    | renderer、preload、main、窗口生命周期与 IPC 边界应怎样设计？              |
| [测试](./testing.md)                         | 如何测试 core module、React binding、生命周期、包入口与资源清理？         |
| [API 参考](./api.md)                         | 当前导出的 class、function、hook、type 与 error 各自语义是什么？          |
| [Flutter 版本差异](./flutter-comparison.md)  | 哪些理念与 Flutter `view_model` 相同，哪些 API 或语义不同？               |

## 必须记住的约束

- DI 共享边界是 `ViewModelRuntime`，不是 React tree，更不是操作系统进程。
- `ViewModelScope` 只把 React owner 适配到 Runtime；plain TypeScript host 不需要 Scope。
- 推荐的 Runtime identity 是`(显式 ViewModel type, effective key)`；builder-only
  Spec 仅以私有 token 作为兼容 fallback。
- `read` 与 `watch` 都建立 owner；只有 `watch` 传播普通 ViewModel 通知。
- builder 与 constructor 必须纯净，资源工作从 acquire 后开始。
- dependency getter 只能在 commit 后使用，不得从 render 或 selector 展开。
- pause/resume 影响 Runtime 中全部已激活 ViewModel。
- `recycle` 无视 owner，强制销毁所有匹配 generation。

## 支持边界

公开应用入口只有 `@lwjlol/view_model/core`、`@lwjlol/view_model/react-native` 与 `@lwjlol/view_model/electron`。本库没有 `@lwjlol/view_model/react`，也不承诺 React Web、SSR、RSC 或浏览器 hydration。
