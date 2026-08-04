# Electron integration

[简体中文](./zh/electron.md) · [Documentation index](./README.md)

> `view_model/electron` is the supported public Electron renderer entry point. It does not imply support for ordinary React Web applications.

Electron has several JavaScript environments with hard process and security
boundaries. Every environment that uses `view_model` owns its own
`ViewModelRuntime`; application modules communicate across environments with
explicit, serializable IPC contracts rather than shared ViewModel objects.

## Process architecture

Use the package differently in each Electron environment:

| Environment | Recommended API       | Responsibility                                                                      |
| ----------- | --------------------- | ----------------------------------------------------------------------------------- |
| main        | `view_model/core`     | Application services, windows, tray, updates, and other plain Binding owners.       |
| preload     | narrow IPC bridge     | Validate and expose a small serializable API; do not leak ViewModel objects.        |
| renderer    | `view_model/electron` | Renderer Runtime, React Scope owner adapter, hooks, and focus/visibility lifecycle. |

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

Do not send a ViewModel, Runtime, Binding, Spec, function, or object identity over IPC. Electron's structured cloning cannot preserve the managed lifecycle graph, and exposing such objects through preload would violate context-isolation boundaries.

## Renderer public entry point

The renderer entry point re-exports core APIs and the supported hooks:

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

There is no public `view_model/react` entry point. Renderer support is intentionally exposed through `view_model/electron` so its platform contract remains explicit.

## Renderer Runtime and Scope

For one renderer React root, the simplest setup lets the Scope create and own the Runtime:

```tsx
import { ViewModelScope } from 'view_model/electron';

root.render(
  <ViewModelScope>
    <Application />
  </ViewModelScope>,
);
```

The Scope is an owner adapter, not the DI container. Internally it creates one Binding and supplies it to hooks. The Runtime owns the application object graph, keyed sharing, dependency edges, generations, pause state, and final disposal.

Create and inject a Runtime when renderer-level DI must also be used by plain owners:

```tsx
import { ViewModelRuntime, ViewModelScope } from 'view_model/electron';

const rendererRuntime = new ViewModelRuntime();

root.render(
  <ViewModelScope runtime={rendererRuntime}>
    <Application />
  </ViewModelScope>,
);
```

An injected Runtime remains caller-owned. Unmount the React root so the Scope Binding releases first, then call `rendererRuntime.dispose()` from the renderer's permanent teardown path.

## Application-level DI inside one renderer

Define stable Specs at module scope. Use an explicit key when several Bindings in the renderer Runtime must share one generation:

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

The key makes this generation shareable only inside the selected renderer Runtime. It does not share the object with Electron main or another renderer process.

Unkeyed Specs remain private to each Scope/plain/dependency Binding. A nested Scope shares the parent Runtime by default but creates a new Binding, so it gets a separate unkeyed generation.

## Renderer lifecycle source

Without an explicit `lifecycle` prop, `ViewModelScope` creates a source from the current renderer `window` and `document`.

The Runtime is active only when both conditions are true:

- the window is focused;
- `document.visibilityState` is not `hidden`.

The source listens to:

- `window.focus`;
- `window.blur`;
- `document.visibilitychange`.

A blur or hidden document pauses the Runtime. It resumes only after focus and visibility are active at the same time. If neither global object is available, the source reports active and installs no listeners.

You can explicitly provide the minimal targets, which is useful for tests and isolated renderer hosts:

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

An injected lifecycle source is used directly instead of creating the default source.

## Pause is Runtime-wide

The lifecycle prop controls `ViewModelRuntime.pause(token)` and `resume(token)`. It does not pause only the Scope that supplied it.

If several Scopes share one Runtime, each lifecycle adapter contributes its own stable token. One inactive Scope keeps the entire Runtime paused even when another Scope is active. The final token removal resumes every activated generation and flushes coalesced Binding callbacks.

This matters for unusual multi-surface renderer trees. Choose deliberately:

- use one root Scope/lifecycle for one renderer application graph;
- use separate Runtime objects when surfaces need independent pause state;
- do not attach a local panel lifecycle to a shared application Runtime unless hiding that panel should pause all modules in the Runtime.

Runtime pause delays Binding-delivered UI callbacks. It does not stop state changes, actions, dependency propagation, or direct ViewModel subscriptions.

## Renderer hooks

### Broad reactive access

```tsx
const documentModel = useViewModel(documentSpec);
```

`useViewModel` acquires the Scope Binding during commit and updates for ordinary ViewModel notifications and generation replacement.

### Command-only access

```tsx
const commands = useReadViewModel(documentSpec);
```

`useReadViewModel` still owns the generation. It ignores ordinary notifications but updates after recycle so it cannot remain attached to a disposed generation.

### Selected access

```tsx
const dirty = useViewModelSelector(documentSpec, (documentModel) => documentModel.state.dirty);
```

The selector is evaluated during React snapshot/render work and must be pure. Do not send IPC, mutate a ViewModel, create subscriptions, or resolve a child dependency getter from the selector.

For a structured result, supply explicit equality:

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

## Render, commit, and IPC resources

Platform hooks may execute the Spec builder and ViewModel constructor during render. React may abandon that work, so constructors must only initialize memory.

Install IPC or native listeners in `onCreate`, after the first committed Binding acquire:

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

An abandoned render never calls `onCreate`; its provisional zero-owner generation is cleaned up automatically. On force recycle, the old generation and its IPC subscriptions are fully disposed before the current owners resolve a replacement.

## Preload boundary

Expose a small capability API from preload instead of an open-ended IPC transport:

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

Validate IPC input in main and return serializable DTOs. Do not expose `ipcRenderer` itself and do not place managed ViewModel instances on `window`.

## Electron main uses plain Bindings

Electron main has no React Scope, render phase, or DOM lifecycle. Create a Runtime at the main application composition root and create plain Bindings for explicit owners:

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

The Runtime is main's application-level DI boundary. Multiple main-process Bindings can share a keyed module through it, while unkeyed modules remain private to their Binding.

For an owner that needs broad update callbacks, provide `onUpdate` when creating its Binding and resolve with `watch`:

```ts
const trayBinding = mainRuntime.createBinding({
  id: 'tray-owner',
  onUpdate: () => refreshTrayMenu(),
});

const trayModel = trayBinding.watch(traySpec);
```

Do not repeatedly call `watch(spec, listener)` from transient code; subscriptions passed directly to plain `watch` remain registered until the current generation or Binding is disposed. For a direct ViewModel subscription, keep the unsubscribe function and register explicit cleanup.

## Main-to-renderer module boundary

Keep authoritative process capabilities in main when they manage:

- windows and native menus;
- tray state;
- application updates;
- privileged filesystem operations;
- global shortcuts;
- cross-window coordination.

Renderers should receive DTO snapshots or typed events through preload. A renderer ViewModel may adapt those messages into UI state, but it is a separate generation in a separate Runtime.

The same Spec source code and key used in two processes still create two objects. Runtime identity never crosses the process boundary.

## Multiple windows

Each BrowserWindow normally has its own renderer process and therefore its own renderer Runtime. Share authoritative cross-window data in main and distribute updates over IPC.

Do not try to share a renderer Runtime through IPC. Even in a same-process multi-root test host, sharing one Runtime also shares pause state: one hidden or blurred lifecycle token can pause all roots using it.

Use distinct renderer Runtime objects when windows or embedded surfaces need independent:

- keyed caches;
- dependency graphs;
- pause state;
- recycle and shutdown boundaries.

## Custom renderer lifecycle

Tests or special containers can provide any source with the platform contract:

```ts
const lifecycle = {
  isActive: () => active,
  subscribe(listener: (active: boolean) => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
```

The subscription must return cleanup. If installation throws, the Scope adapter removes its token before propagating the error.

## Shutdown order

Dispose owner Bindings before their caller-owned Runtime:

```ts
app.on('before-quit', () => {
  trayBinding.dispose();
  applicationBinding.dispose();
  mainRuntime.dispose();
});
```

`runtime.dispose()` force-disposes every remaining generation, including `aliveForever` modules, and rejects later acquisition. The methods are idempotent, but resource cleanup should also be idempotent.

In a renderer with an injected Runtime:

1. unmount the React root;
2. let Scope cleanup release its Binding;
3. dispose the renderer Runtime from its permanent owner.

A root Scope that created its own Runtime performs the Binding-then-Runtime sequence automatically.

## Checklist

- Use `view_model/core` in main and `view_model/electron` in renderer.
- Keep one Runtime object inside one JavaScript process and explicit ownership boundary.
- Treat `ViewModelScope` as a React Binding adapter, not as the DI container.
- Share application modules with stable Specs, explicit keys, and one Runtime.
- Keep constructors and selectors free of IPC and native side effects.
- Register IPC listeners in `onCreate` and remove them through `addDispose`.
- Remember that any Scope lifecycle token pauses its entire Runtime.
- Communicate across main/preload/renderer with validated serializable data.
- Never import `view_model/react` or claim ordinary Web support.

See [examples/electron](../examples/electron/README.md) for the renderer, preload, and main-process boundaries.
