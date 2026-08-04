# Electron Renderer + Main

[English](./README.md)

本示例说明 Electron renderer、preload 与 main 进程之间的正确边界：

- renderer 使用 `view_model/electron` 的 Scope 与 hooks；
- main 进程使用 `view_model/core` 的 plain Binding；
- preload 暴露窄而明确的 IPC bridge；
- 进程之间只交换可序列化 DTO，不传递 ViewModel 对象。

> 本示例需要当前正式版 `view_model` API。支持 Electron renderer 不代表支持
> React Web。

以下文件名仅用于标记示意代码片段。此目录不包含完整可运行的 Electron 项目、包配置或
bundler 配置。

## 架构边界

Electron 应用包含相互独立的 JavaScript realm：

- **Renderer：** React UI。`ViewModelScope` 是 React owner adapter；它创建或接收
  Runtime，向 hooks 提供一个 Binding，并把 React commit/unmount 映射为所有权。
- **Preload：** context-isolated bridge，只暴露白名单命令与可序列化值。
- **Main：** 没有 React commit 阶段的 plain host。它显式创建 Runtime 与 Binding，
  并在应用关闭时释放二者。

Runtime、Binding、Spec 或 ViewModel 对象都不能跨 IPC。每个 renderer 通常拥有独立的
顶层 Runtime，使窗口暂停状态与模块身份保持隔离。

## Renderer：`renderer.tsx`

```tsx
import { createRoot } from 'react-dom/client';
import { StateViewModel, viewModelSpec } from 'view_model/core';
import { ViewModelScope, useReadViewModel, useViewModelSelector } from 'view_model/electron';

type CounterState = Readonly<{
  count: number;
}>;

class RendererCounter extends StateViewModel<CounterState> {
  public constructor() {
    super({ count: 0 });
  }

  public readonly increment = (): void => {
    this.updateState((current) => ({ count: current.count + 1 }));
  };
}

// Keep the Spec stable and outside React render.
const counterSpec = viewModelSpec(() => new RendererCounter());

function Counter() {
  const count = useViewModelSelector(counterSpec, (counter) => counter.state.count);
  const counter = useReadViewModel(counterSpec);

  return (
    <main>
      <p>Count: {count}</p>
      <button onClick={counter.increment}>+1</button>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <ViewModelScope>
    <Counter />
  </ViewModelScope>,
);
```

未注入 Runtime 时，这个顶层 Scope 会创建并拥有自己的 Runtime。Scope 的默认生命周期源
仅在窗口获得焦点且 document 可见时将 renderer 视为 active。窗口 blur 或 document
hidden 会暂停 Runtime；重新 focus 且可见时恢复。

构造器与 Spec builder 必须保持纯净，因为 React 可能在最终未 commit 的 render 中准备
实例。Renderer IPC 订阅及其他资源应在 `onCreate` 中建立，并通过 `addDispose` 注册清理，
或在 `onDispose` 中释放。

## Main 进程：`main.ts`

Main 进程不使用 React 或 `ViewModelScope`。它以 plain Binding 作为 owner adapter：

```ts
import { app, BrowserWindow } from 'electron';
import { ViewModel, ViewModelRuntime, viewModelSpec } from 'view_model/core';

class WindowCoordinator extends ViewModel {
  readonly #windows = new Set<BrowserWindow>();

  public createWindow(): number {
    const window = new BrowserWindow({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: PRELOAD_PATH,
      },
    });

    this.#windows.add(window);
    window.once('closed', () => this.#windows.delete(window));
    void window.loadURL(RENDERER_URL);
    return window.id;
  }

  protected override onDispose(): void {
    for (const window of this.#windows) {
      if (!window.isDestroyed()) window.close();
    }
    this.#windows.clear();
  }
}

const coordinatorSpec = viewModelSpec(() => new WindowCoordinator());
const runtime = new ViewModelRuntime();
const binding = runtime.createBinding({ id: 'electron-main' });

app.whenReady().then(() => {
  binding.read(coordinatorSpec).createWindow();
});

app.on('before-quit', () => {
  binding.dispose();
  runtime.dispose();
});
```

`binding.read` 会解析并拥有 coordinator，但不会让 plain host 订阅普通 ViewModel 通知。
unkeyed Spec 对当前 Binding 私有，足以满足单一应用 owner。只有同一 Runtime 中的多个
Binding 确实需要共享同一 generation 时，才应使用 keyed Spec。

`PRELOAD_PATH` 与 `RENDERER_URL` 是由宿主构建提供的占位符。示例有意省略 Electron
打包与 bundler 配置。

## Preload Bridge：`preload.ts`

Preload 只暴露白名单内、可序列化的 contract：

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktop', {
  getWindowSummary: () => ipcRenderer.invoke('window:get-summary'),
});
```

不要把 main 进程的 `WindowCoordinator`、Runtime、Binding 或其他受管对象挂到
`window`。Renderer 应从自己的 ViewModel 调用该 bridge，并把返回的 DTO 转换为
renderer-local state。

## 所有权与关闭

- Renderer Scope 拥有自己的 Binding；未注入 Runtime 时，也拥有自己的 Runtime。
  Scope 卸载会释放这份 React 所有权。
- Main Binding 表达应用级所有权。宿主停止时先 dispose Binding，再 dispose Runtime，
  结束所有剩余 generation。
- Runtime 一旦被注入 Scope，就由调用方负责 dispose。
- Spec 应保存在模块级；构造器和 builder 不得创建 IPC、窗口、计时器或原生订阅。
- 此处无需 `aliveForever`，因为 main Binding 本身已存活整个应用生命周期。
