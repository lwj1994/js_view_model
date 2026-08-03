import type { ViewModelLifecycleSource } from '../react/index.js';

export interface ElectronLifecycleSource extends ViewModelLifecycleSource {}

export interface ElectronRendererWindow {
  addEventListener(type: 'focus' | 'blur', listener: () => void): void;
  removeEventListener(type: 'focus' | 'blur', listener: () => void): void;
}

export interface ElectronRendererDocument {
  readonly visibilityState?: string | undefined;
  hasFocus?(): boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface ElectronRendererLifecycleTarget {
  readonly window?: ElectronRendererWindow | undefined;
  readonly document?: ElectronRendererDocument | undefined;
}

function globalRendererTarget(): ElectronRendererLifecycleTarget {
  const rendererWindow =
    typeof window === 'undefined' ? undefined : (window as unknown as ElectronRendererWindow);
  const rendererDocument =
    typeof document === 'undefined' ? undefined : (document as unknown as ElectronRendererDocument);

  return { window: rendererWindow, document: rendererDocument };
}

/**
 * 把 Electron renderer 的窗口焦点与页面可见性合并成 runtime 生命周期。
 * preload 隔离场景也可传入只暴露这些方法的代理对象。
 */
export function createElectronRendererLifecycleSource(
  target: ElectronRendererLifecycleTarget = globalRendererTarget(),
): ElectronLifecycleSource {
  const rendererWindow = target.window;
  const rendererDocument = target.document;
  let focused = rendererDocument?.hasFocus?.() ?? true;
  const readActive = (refreshFocus = true): boolean => {
    if (refreshFocus && rendererDocument?.hasFocus !== undefined) {
      focused = rendererDocument.hasFocus();
    }
    const visible = rendererDocument?.visibilityState !== 'hidden';
    return visible && focused;
  };

  return {
    isActive: readActive,
    subscribe(listener) {
      if (rendererWindow === undefined && rendererDocument === undefined) {
        return () => undefined;
      }

      const onFocus = (): void => {
        focused = true;
        listener(readActive(false));
      };
      const onBlur = (): void => {
        focused = false;
        listener(readActive(false));
      };
      const onVisibilityChange = (): void => {
        listener(readActive());
      };
      rendererWindow?.addEventListener('focus', onFocus);
      rendererWindow?.addEventListener('blur', onBlur);
      rendererDocument?.addEventListener('visibilitychange', onVisibilityChange);

      return () => {
        rendererWindow?.removeEventListener('focus', onFocus);
        rendererWindow?.removeEventListener('blur', onBlur);
        rendererDocument?.removeEventListener('visibilitychange', onVisibilityChange);
      };
    },
  };
}
