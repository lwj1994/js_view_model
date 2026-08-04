# Electron 集成

[English](../electron.md) · [文档索引](./README.md)

> `view_model/electron` 是正式支持的公开 Electron renderer 入口，不表示本库支持普通 React Web 应用。

Electron 包含多个具有严格进程与安全边界的 JavaScript 环境。每个使用 `view_model` 的环境都持有自己的 `ViewModelRuntime`；应用模块通过显式、可序列化的 IPC contract 在环境间通信，而不是共享 ViewModel 对象。

## 进程架构

不同 Electron 环境应采用不同的 package 用法：

| 环境     | 推荐 API              | 职责                                                                                  |
| -------- | --------------------- | ------------------------------------------------------------------------------------- |
| main     | `view_model/core`     | 应用服务、window、tray、update 与其他 plain Binding owner。                           |
| preload  | 窄 IPC bridge         | 校验并暴露小型可序列化 API；不要泄漏 ViewModel 对象。                                 |
| renderer | `view_model/electron` | renderer Runtime、React Scope owner adapter、hooks，以及 focus/visibility lifecycle。 |

```text
Electron main process
└── main ViewModelRuntime
    └── plain ViewModelBinding(s)
        ↕ serialized IPC DTOs/events
preload allowlist bridge
        ↕
Electron renderer process
└── renderer ViewModelRuntime
    └── ViewModelScope Binding
        └── React hooks
```

不要通过 IPC 发送 ViewModel、Runtime、Binding、Spec、function 或 object identity。Electron structured cloning 无法保留受管理生命周期图，通过 preload 暴露此类对象也会违反 context-isolation 边界。

## Renderer 公开入口

renderer entry 会重新导出 core API 与受支持 hooks：

```ts
import {
  StateViewModel,
  ViewModelRuntime,
  ViewModelScope,
  createElectronRendererLifecycleSource,
  useReadViewModel,
  useViewModel,
  useViewModelSelector,
  viewModelSpec,
} from 'view_model/electron';
```

本库没有公开 `view_model/react` 入口。renderer support 有意通过 `view_model/electron` 暴露，使其 platform contract 始终明确。

## Renderer Runtime 与 Scope

对于一个 renderer React root，最简单的 setup 是让 Scope 创建并持有 Runtime：

```tsx
import { ViewModelScope } from 'view_model/electron';

root.render(
  <ViewModelScope>
    <Application />
  </ViewModelScope>,
);
```

Scope 是 owner adapter，不是 DI 容器。其内部创建一个 Binding 并提供给 hooks。Runtime 持有应用对象图、keyed sharing、dependency edge、generation、pause state 与最终 dispose。

当 renderer-level DI 也需要由 plain owner 使用时，应创建并注入 Runtime：

```tsx
import { ViewModelRuntime, ViewModelScope } from 'view_model/electron';

const rendererRuntime = new ViewModelRuntime();

root.render(
  <ViewModelScope runtime={rendererRuntime}>
    <Application />
  </ViewModelScope>,
);
```

注入的 Runtime 仍由调用方持有。应先 unmount React root，让 Scope Binding 完成释放，再从 renderer 的永久 teardown path 调用 `rendererRuntime.dispose()`。

## 单个 renderer 内的应用级 DI

在模块顶层定义稳定 Spec。若 renderer Runtime 内有多个 Binding 需要共享一个 generation，应使用显式 key：

```ts
import { StateViewModel, viewModelSpec } from 'view_model/electron';

interface DocumentState {
  readonly dirty: boolean;
  readonly path: string | undefined;
}

class DocumentViewModel extends StateViewModel<DocumentState> {
  public constructor() {
    super({ dirty: false, path: undefined });
  }

  public markDirty(): void {
    this.updateState((current) => ({ ...current, dirty: true }), 'document.mark-dirty');
  }
}

export const documentSpec = viewModelSpec(() => new DocumentViewModel(), {
  key: 'active-document',
  debugLabel: 'DocumentViewModel',
});
```

该 key 只会让 generation 在选定 renderer Runtime 内共享，不会与 Electron main 或另一个 renderer process 共享对象。

Unkeyed Spec 对每个 Scope/plain/dependency Binding 私有。nested Scope 默认共享 parent Runtime，但会创建新 Binding，因此会得到独立 unkeyed generation。

## Renderer lifecycle source

未提供显式 `lifecycle` prop 时，`ViewModelScope` 会根据当前 renderer `window` 与 `document` 创建 source。

只有下列条件同时满足，Runtime 才是 active：

- window 处于 focused；
- `document.visibilityState` 不是 `hidden`。

source 监听：

- `window.focus`；
- `window.blur`；
- `document.visibilitychange`。

blur 或 hidden document 会 pause Runtime。只有 focus 与 visibility 同时恢复 active，才会 resume。如果两个 global object 都不可用，source 会报告 active 且不安装 listener。

可以显式提供最小 target，这对 test 与隔离 renderer host 很有用：

```tsx
import { ViewModelScope, createElectronRendererLifecycleSource } from 'view_model/electron';

const lifecycle = createElectronRendererLifecycleSource({
  window,
  document,
});

root.render(
  <ViewModelScope lifecycle={lifecycle}>
    <Application />
  </ViewModelScope>,
);
```

注入的 lifecycle source 会被直接使用，不再创建默认 source。

## Pause 是 Runtime-wide 的

lifecycle prop 控制 `ViewModelRuntime.pause(token)` 与 `resume(token)`，不会只 pause 提供它的 Scope。

如果多个 Scope 共享一个 Runtime，每个 lifecycle adapter 都提供自己的稳定 token。只要有一个 Scope inactive，整个 Runtime 就会保持 paused，即使其他 Scope 仍是 active。移除最后一个 token 后，所有已 activate generation 会 resume，并 flush coalesced Binding callback。

这会影响少见的 multi-surface renderer tree。应明确选择：

- 一个 renderer 应用对象图使用一个 root Scope/lifecycle；
- surface 需要独立 pause state 时，使用不同 Runtime；
- 除非隐藏 local panel 本就应 pause Runtime 内所有模块，否则不要将该 panel lifecycle 连接到共享 application Runtime。

Runtime pause 会延迟 Binding-delivered UI callback，但不会停止 state change、action、dependency propagation 或 direct ViewModel subscription。

## Renderer hooks

### 宽范围 reactive access

```tsx
const documentModel = useViewModel(documentSpec);
```

`useViewModel` 在 commit 中 acquire Scope Binding，并对普通 ViewModel 通知与 generation replacement 作出更新。

### Command-only access

```tsx
const commands = useReadViewModel(documentSpec);
```

`useReadViewModel` 仍会拥有 generation。它忽略普通通知，但会在 recycle 后更新，避免继续依附 disposed generation。

### Selected access

```tsx
const dirty = useViewModelSelector(documentSpec, (documentModel) => documentModel.state.dirty);
```

selector 会在 React snapshot/render 工作中求值，必须保持纯净。不要从 selector 发送 IPC、修改 ViewModel、创建 subscription 或解析 child dependency getter。

结构化结果应提供显式 equality：

```tsx
const header = useViewModelSelector(
  documentSpec,
  (documentModel) => ({
    dirty: documentModel.state.dirty,
    path: documentModel.state.path,
  }),
  (previous, next) => previous.dirty === next.dirty && previous.path === next.path,
);
```

## Render、commit 与 IPC resource

platform hooks 可能在 render 中执行 Spec builder 与 ViewModel constructor。React 可能放弃这些工作，因此 constructor 只能初始化内存。

IPC 或 native listener 应在第一个已 commit Binding acquire 后，于 `onCreate` 中安装：

```ts
class UpdateStatusViewModel extends StateViewModel<UpdateStatus> {
  public constructor() {
    super({ phase: 'idle' });
  }

  protected override onCreate(): void {
    const unsubscribe = window.desktopApi.onUpdateStatus((status) => {
      this.setState(status, 'updater.status');
    });

    this.addDispose(unsubscribe);
  }
}
```

被放弃的 render 不会调用 `onCreate`；其 provisional zero-owner generation 会自动清理。force recycle 时，旧 generation 及其 IPC subscription 会在当前 owner 解析 replacement 之前完整 dispose。

## Preload 边界

preload 应暴露小型 capability API，而不是开放式 IPC transport：

```ts
contextBridge.exposeInMainWorld('desktopApi', {
  openDocument: (path: string) => ipcRenderer.invoke('document:open', { path }),
  onUpdateStatus: (listener: (status: UpdateStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => {
      listener(status);
    };

    ipcRenderer.on('updater:status', handler);
    return () => ipcRenderer.removeListener('updater:status', handler);
  },
});
```

main 必须校验 IPC input 并返回可序列化 DTO。不要暴露 `ipcRenderer` 本身，也不要将受管理 ViewModel instance 放到 `window` 上。

## Electron main 使用 plain Binding

Electron main 没有 React Scope、render phase 或 DOM lifecycle。应在 main application composition root 创建 Runtime，并为显式 owner 创建 plain Binding：

```ts
import { ViewModel, ViewModelRuntime, viewModelSpec } from 'view_model/core';

class WindowCoordinator extends ViewModel {
  public async restoreWindows(): Promise<void> {
    // Restore persisted window state and create BrowserWindow instances.
  }
}

const windowCoordinatorSpec = viewModelSpec(() => new WindowCoordinator(), {
  key: 'main-window-coordinator',
  debugLabel: 'WindowCoordinator',
});

const mainRuntime = new ViewModelRuntime();
const applicationBinding = mainRuntime.createBinding({ id: 'electron-main' });
const windowCoordinator = applicationBinding.read(windowCoordinatorSpec);

await windowCoordinator.restoreWindows();
```

Runtime 是 main 的应用级 DI 边界。多个 main-process Binding 可以通过它共享 keyed module，而 unkeyed module 仍对各 Binding 私有。

若 owner 需要宽范围 update callback，应在创建 Binding 时提供 `onUpdate`，并通过 `watch` 解析：

```ts
const trayBinding = mainRuntime.createBinding({
  id: 'tray-owner',
  onUpdate: () => refreshTrayMenu(),
});

const trayModel = trayBinding.watch(traySpec);
```

不要从瞬时代码反复调用 `watch(spec, listener)`；直接传给 plain `watch` 的 subscription 会一直注册到当前 generation 或 Binding dispose。direct ViewModel subscription 应保存 unsubscribe function，并注册显式 cleanup。

## Main-to-renderer 模块边界

管理下列能力时，应将权威 process capability 保留在 main：

- window 与 native menu；
- tray state；
- application update；
- privileged filesystem operation；
- global shortcut；
- cross-window coordination。

renderer 应通过 preload 接收 DTO snapshot 或 typed event。renderer ViewModel 可以将这些消息适配为 UI state，但它是另一个 Runtime 中的独立 generation。

即使两个进程使用相同 Spec source code 与 key，也仍会创建两个对象。Runtime identity 永远不会跨越 process boundary。

## 多窗口

每个 BrowserWindow 通常都有自己的 renderer process，因此也有自己的 renderer Runtime。应在 main 共享权威 cross-window data，再通过 IPC 分发 update。

不要尝试通过 IPC 共享 renderer Runtime。即使在同进程 multi-root test host 中，共享一个 Runtime 也会共享 pause state：一个 hidden 或 blurred lifecycle token 就能 pause 所有使用它的 root。

当 window 或 embedded surface 需要独立的下列边界时，应使用不同 renderer Runtime：

- keyed cache；
- dependency graph；
- pause state；
- recycle 与 shutdown boundary。

## 自定义 renderer lifecycle

test 或特殊 container 可以提供符合 platform contract 的任意 source：

```ts
const lifecycle = {
  isActive: () => active,
  subscribe(listener: (active: boolean) => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
```

subscription 必须返回 cleanup。如果 installation 抛错，Scope adapter 会先移除自己的 token，再传播错误。

## Shutdown 顺序

caller-owned Runtime 应先 dispose owner Binding：

```ts
app.on('before-quit', () => {
  trayBinding.dispose();
  applicationBinding.dispose();
  mainRuntime.dispose();
});
```

`runtime.dispose()` 会强制 dispose 所有剩余 generation，包括 `aliveForever` module，并拒绝后续 acquire。这些 method 是幂等的，但 resource cleanup 同样应保持幂等。

对于注入 Runtime 的 renderer：

1. unmount React root；
2. 让 Scope cleanup 释放 Binding；
3. 由其永久 owner dispose renderer Runtime。

自行创建 Runtime 的 root Scope 会自动执行 Binding-then-Runtime 顺序。

## 检查清单

- main 使用 `view_model/core`，renderer 使用 `view_model/electron`。
- 一个 Runtime object 只存在于一个 JavaScript process 与明确的 ownership boundary 内。
- 将 `ViewModelScope` 视为 React Binding adapter，而不是 DI 容器。
- 使用稳定 Spec、显式 key 与一个 Runtime 共享应用模块。
- constructor 与 selector 不应包含 IPC 或 native side effect。
- 在 `onCreate` 注册 IPC listener，并通过 `addDispose` 移除。
- 任何 Scope lifecycle token 都会 pause 它的整个 Runtime。
- main/preload/renderer 之间只传递经过校验、可序列化的数据。
- 永远不要导入 `view_model/react` 或声称支持普通 Web。

renderer、preload 与 main-process 边界见 [examples/electron](../../examples/electron/README.md)。
