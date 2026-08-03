# Electron 集成

> `view_model/electron` 处于 v0.1 Alpha，仅用于 Electron App，不代表支持普通 Web。

## 进程边界

Electron main、preload 与 renderer 是不同执行环境：

- main 可使用 `view_model/core` 和 plain `ViewModelBinding`；
- renderer 使用 `view_model/electron` 的 Scope 与 hooks；
- preload 负责暴露最小、可序列化、经过白名单限制的 IPC API；
- 不要通过 IPC 传递 ViewModel 对象或试图共享对象引用。

多个 renderer/window 默认应有各自顶层 Scope，并使用各自 Runtime。若让多个窗口共享一个 Runtime，任一窗口 lifecycle source inactive 都会让整个 Runtime 保持 paused；确实需要跨窗口共享的数据更适合放在 main 中，由 IPC 同步 DTO 或事件。

## renderer Scope

```tsx
import { ViewModelScope, createElectronRendererLifecycleSource } from 'view_model/electron';

const lifecycle = createElectronRendererLifecycleSource({
  window,
  document,
});

root.render(
  <ViewModelScope lifecycle={lifecycle}>
    <App />
  </ViewModelScope>,
);
```

未提供 lifecycle 时，Scope 会使用当前 renderer 的默认窗口生命周期。显式创建 source 更方便测试与自定义宿主。

active 判定同时考虑：

- `window` focus/blur；
- `document.visibilityState`。

只有窗口 focus 且页面 visible 时 resume，否则 pause。

## renderer hooks

`useViewModel`、`useReadViewModel` 与 `useViewModelSelector` 的语义和 React Native 入口一致：

```tsx
const documentVm = useViewModel(documentSpec);
const commands = useReadViewModel(documentSpec);
const dirty = useViewModelSelector(documentSpec, (vm) => vm.state.dirty);
```

不要在 render 中调用 Electron IPC 或启动原生资源；让 ViewModel 在 commit 后的生命周期回调中完成订阅，并在 dispose 中释放。

## main 使用 plain Binding

main process 没有 React Scope。创建 Runtime 与 Binding，使用 `watch/read` 解析实例，并在 app 退出时释放：

```ts
import { ViewModelRuntime, viewModelSpec } from 'view_model/core';

const runtime = new ViewModelRuntime();
const binding = runtime.createBinding();
const coordinatorSpec = viewModelSpec(() => new WindowCoordinator(), {
  key: 'main-window-coordinator',
  aliveForever: true,
});

const coordinator = binding.read(coordinatorSpec);

app.on('before-quit', () => {
  binding.dispose();
  runtime.dispose();
});
```

main 中的 ViewModel 可以协调窗口、托盘或自动更新，但 renderer 只能通过 preload 提供的窄 IPC 接口访问它。

## 自定义生命周期源

测试或特殊窗口容器可传入：

```ts
const lifecycle = {
  isActive: () => active,
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
```

listener 接收布尔 active 状态。订阅函数必须返回 cleanup，避免窗口关闭后残留监听。

## 示例

renderer、preload 边界说明与 main plain binding 示例见 [examples/electron](../examples/electron/README.md)。
