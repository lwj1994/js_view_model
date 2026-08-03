# Electron integration

Electron has separate JavaScript realms and process boundaries. Share DTOs and
events through IPC, never ViewModel, Binding, Runtime, or Spec object references.

## Renderer

Use `view_model/electron` for renderer Scope and hooks:

```tsx
import { createRoot } from 'react-dom/client';
import { ViewModelScope } from 'view_model/electron';

createRoot(document.getElementById('root')!).render(
  <ViewModelScope>
    <App />
  </ViewModelScope>,
);
```

The default renderer lifecycle is active only when the window is focused and
the document is not hidden. Use
`createElectronRendererLifecycleSource({ window, document })` with minimal
proxies for tests, custom shells, or context-isolated preload designs.

Prefer one top-level Runtime per renderer/window. Sharing a Runtime between
Scopes also shares Runtime pause state: any inactive window/source keeps every
activated instance paused until all pause tokens resume. Independent windows
therefore normally need independent Runtimes.

Renderer hooks have the same semantics as the React Native hooks:
`useViewModel`, `useReadViewModel`, `useViewModelSelector`, and advanced current
Binding/Runtime access. Keep Spec builders, constructors, render, and selectors
free of IPC and resource side effects.

## Preload and IPC

Expose a narrow allowlisted API from preload. Prefer serializable commands,
DTOs, and event payloads:

```ts
export interface OrdersBridge {
  list(): Promise<readonly OrderDto[]>;
  subscribe(listener: (orders: readonly OrderDto[]) => void): () => void;
}
```

The renderer ViewModel can acquire the bridge subscription in `onCreate`, add
its cleanup through `addDispose`, and pause expensive work in `onPause` when
appropriate.

## Main process

Electron main has no React commit phase. Use core directly:

```ts
import { ViewModelRuntime, viewModelSpec } from 'view_model/core';

const runtime = new ViewModelRuntime();
const binding = runtime.createBinding({ id: 'electron-main' });
const coordinatorSpec = viewModelSpec(() => new WindowCoordinator(), {
  key: 'window-coordinator',
  aliveForever: true,
});

binding.read(coordinatorSpec);

app.on('before-quit', () => {
  binding.dispose();
  runtime.dispose();
});
```

Main modules can represent tray, update, window, or background capabilities and
inject one another through ViewModel getters. Renderer consumers access them
only through preload IPC contracts.

## Non-renderer fallback

The default Electron lifecycle factory remains safely active when no global
`window` or `document` exists. This does not make Scope a main-process API;
main should still use a plain core Binding.
