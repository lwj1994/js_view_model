# Electron renderer + main

这个示例展示 Electron 的正确边界：

- renderer 使用 `view_model/electron` 的 Scope 与 hooks；
- main 使用 `view_model/core` 的 plain Binding；
- renderer 与 main 不共享 ViewModel 对象；
- IPC 只传递可序列化 DTO。

> 需要 v0.1 Alpha 的 `view_model`。Electron renderer 支持不等于普通 React Web 支持。

## renderer.tsx

```tsx
import { createRoot } from 'react-dom/client';
import { StateViewModel, viewModelSpec } from 'view_model/core';
import { ViewModelScope, useReadViewModel, useViewModelSelector } from 'view_model/electron';

type CounterState = {
  count: number;
};

class RendererCounter extends StateViewModel<CounterState> {
  constructor() {
    super({ count: 0 });
  }

  increment = () => {
    this.updateState((current) => ({ count: current.count + 1 }));
  };
}

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

默认 Scope 会在窗口 blur 或 document hidden 时 pause，在重新 focus 且 visible 时 resume。

## main.ts

main process 不使用 React：

```ts
import { app, BrowserWindow } from 'electron';
import { ViewModel, ViewModelRuntime, viewModelSpec } from 'view_model/core';

class WindowCoordinator extends ViewModel {
  createWindow() {
    const window = new BrowserWindow({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: PRELOAD_PATH,
      },
    });

    void window.loadURL(RENDERER_URL);
    return window.id;
  }
}

const coordinatorSpec = viewModelSpec(() => new WindowCoordinator(), {
  key: 'window-coordinator',
  aliveForever: true,
});

const runtime = new ViewModelRuntime();
const binding = runtime.createBinding();

app.whenReady().then(() => {
  binding.read(coordinatorSpec).createWindow();
});

app.on('before-quit', () => {
  binding.dispose();
  runtime.dispose();
});
```

`PRELOAD_PATH` 与 `RENDERER_URL` 由应用的构建工具注入，这里省略 bundler 配置。

## preload.ts

preload 只暴露白名单能力：

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktop', {
  getWindowSummary: () => ipcRenderer.invoke('window:get-summary'),
});
```

不要把 main 中的 `WindowCoordinator` 或其他 ViewModel 挂到 `window`。跨进程应传递 DTO，并在 renderer 自己的 ViewModel 中把 IPC 结果转成 UI 状态。
