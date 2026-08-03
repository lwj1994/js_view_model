# API 导览

> v0.1 Alpha。以下 API 只承诺用于 React Native、Electron renderer 与 Electron main/core 场景。

本文是语义导览，不替代 TypeScript 声明。具体泛型与可选参数以当前源码构建生成的 `.d.ts` 为准。

## view_model/core

### ViewModel

所有 ViewModel 的基础类。提供：

- `subscribe` 与受保护的 `notifyListeners` 通知能力；
- `update(action, mutation)` 为一次同步修改附加调试 action；
- 当前 `viewModelBinding`，供 getter 解析 child；
- `onCreate`、`onBind`、`onUnbind`、`onPause`、`onResume`、`onDispose` 生命周期 hook；
- `addDispose` 统一登记资源 cleanup；
- generation 结束后的防误用保护。

`viewModelBinding` 与依赖 getter 属于 ViewModel 内部协作面。不要从 React render、JSX
或 selector 中读取依赖 getter；UI 应订阅 parent 自己公开的状态。

### StateViewModel<State>

带不可变状态快照的便利基类。`state` 暴露当前快照；子类通过受保护的 `setState` 替换状态，或通过 `updateState` 根据当前状态计算新快照，两者都会通知 watcher。`subscribeState` 可用于非 React 的细粒度状态订阅。

只调用 action 的组件优先使用 `useReadViewModel`；读取 `state` 的组件优先使用 selector，减少无关刷新。

### ViewModelSpec<T> / viewModelSpec

稳定的实例声明与身份 token。builder 只做纯对象构造，不接收可 acquire 的 Binding；
依赖在实例 attach 后通过 ViewModel getter 解析。options 描述 key、`aliveForever` 与
`debugLabel` 等策略。

### ViewModelRuntime

保存实例缓存、generation、owner source、依赖边和 pause 状态。Runtime 是 keyed 共享的最大边界，并提供 `createBinding`、`pause`、`resume`、`recycle` 与 `dispose`。

不要把同一个 Runtime 对象跨 Electron 进程传递。

### ViewModelBinding

非 React owner 与 ViewModel 自身的解析入口：

- `watch(spec)`：解析、保活并订阅 VM 更新；
- `read(spec)`：解析和保活，但不订阅普通 VM 更新；
- `dispose()`：释放 Binding 建立的 owner source。

Binding 也用于 parent → child getter DI。普通业务代码通常不需要手动创建 React Binding；Electron main 等非 React owner 通过 `runtime.createBinding()` 创建。

## view_model/react-native

除 core API 外，提供：

- `ViewModelScope`；
- `useViewModel`；
- `useReadViewModel`；
- `useViewModelSelector`；
- 获取当前 Binding/Runtime 的高级 hooks。

Scope 可接收外部 Runtime、可替换的 AppState，或用 `lifecycle` 接入页面 focus 等
自定义 source。默认 AppState active/resume，其他状态 pause。

## view_model/electron

除 core API 外，提供：

- `ViewModelScope`；
- `useViewModel`；
- `useReadViewModel`；
- `useViewModelSelector`；
- 获取当前 Binding/Runtime 的高级 hooks；
- `createElectronRendererLifecycleSource`。

Electron Scope 只用于 renderer。main 使用 core plain Binding。

## 不提供的入口

本库没有以下承诺：

```ts
// 不存在，也不应依赖：
import { ViewModelScope } from 'view_model/react';
```

普通 Web、SSR、React Server Components 与通用浏览器 hydration 不在 v0.1 范围内。
