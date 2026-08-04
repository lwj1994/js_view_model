# Electron Renderer + Main

[中文](./README_ZH.md)

This example documents the boundary between an Electron renderer, preload,
and the main process:

- the renderer uses the `@lwjlol/view_model/electron` Scope and hooks;
- the main process uses a plain Binding from `@lwjlol/view_model/core`;
- preload exposes a narrow IPC bridge;
- processes exchange serializable DTOs, never ViewModel objects.

> This example requires the current `view_model` API. Electron renderer
> support does not imply React Web support.

The filenames below label illustrative snippets. This directory does not
contain a complete runnable Electron project, package configuration, or
bundler setup.

## Architecture Boundaries

An Electron application has separate JavaScript realms:

- **Renderer:** React UI. `ViewModelScope` is the React owner adapter that
  creates or receives a Runtime, provides one Binding to hooks, and maps React
  commit/unmount to ownership.
- **Preload:** a context-isolated bridge exposing allowlisted commands and
  serializable values.
- **Main:** a plain host with no React commit phase. It creates a Runtime and a
  Binding explicitly, then disposes both at application shutdown.

A Runtime, Binding, Spec, or ViewModel object must not cross IPC. Each renderer
normally owns an independent top-level Runtime so window pause state and module
identity remain isolated.

## Renderer: `renderer.tsx`

```tsx
import { createRoot } from 'react-dom/client';
import { StateViewModel, viewModelSpec } from '@lwjlol/view_model/core';
import {
  ViewModelScope,
  useReadViewModel,
  useViewModelSelector,
} from '@lwjlol/view_model/electron';

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

With no injected Runtime, this top-level Scope creates and owns its Runtime.
The Scope's default lifecycle source considers the renderer active only while
the window is focused and the document is visible. Blur or a hidden document
pauses the Runtime; focus plus visibility resumes it.

The constructor and Spec builder remain pure because React may prepare an
instance during a render that never commits. Renderer IPC subscriptions and
other resources belong in `onCreate`, with cleanup registered through
`addDispose` or performed in `onDispose`.

## Main Process: `main.ts`

The main process does not use React or `ViewModelScope`. A plain Binding is its
owner adapter:

```ts
import { app, BrowserWindow } from 'electron';
import { ViewModel, ViewModelRuntime, viewModelSpec } from '@lwjlol/view_model/core';

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

`binding.read` resolves and owns the coordinator without subscribing the plain
host to ordinary ViewModel notifications. The unkeyed Spec is private to this
Binding, which is sufficient for one application owner. Use a keyed Spec only
when multiple Bindings in this same Runtime must share the same generation.

`PRELOAD_PATH` and `RENDERER_URL` are placeholders supplied by the host build.
The snippet intentionally omits Electron packaging and bundler configuration.

## Preload Bridge: `preload.ts`

Preload exposes only an allowlisted, serializable contract:

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktop', {
  getWindowSummary: () => ipcRenderer.invoke('window:get-summary'),
});
```

Do not attach the main-process `WindowCoordinator`, Runtime, Binding, or any
other managed object to `window`. The renderer should call this bridge from its
own ViewModel and convert returned DTOs into renderer-local state.

## Ownership and Shutdown

- The renderer Scope owns its Binding and, when no Runtime is injected, its
  Runtime. Scope unmount releases that React ownership.
- The main Binding represents application ownership. Dispose it when the host
  stops, then dispose the Runtime to end every remaining generation.
- If a Runtime is injected into a Scope, the caller owns Runtime disposal.
- Keep Specs at module scope. Keep constructors and builders free of IPC,
  windows, timers, and native subscriptions.
- `aliveForever` is unnecessary here because the main Binding already remains
  alive for the application's lifetime.
