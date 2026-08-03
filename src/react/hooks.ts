import { useCallback, useRef, useSyncExternalStore } from 'react';

import type {
  ViewModel,
  ViewModelBinding,
  ViewModelRuntime,
  ViewModelSpec,
} from '../core/index.js';
import { useViewModelContext } from './context.js';

type SubscriptionMode = 'watch' | 'read';

export type ViewModelSelector<T extends ViewModel, Selection> = (viewModel: T) => Selection;
export type ViewModelEquality<Selection> = (previous: Selection, next: Selection) => boolean;

export function useViewModelRuntime(): ViewModelRuntime {
  return useViewModelContext().runtime;
}

export function useViewModelBinding(): ViewModelBinding {
  return useViewModelContext().binding;
}

function useResolvedViewModel<T extends ViewModel>(
  spec: ViewModelSpec<T>,
  mode: SubscriptionMode,
): T {
  const binding = useViewModelBinding();
  // prepare 可以构造纯对象，但不会 addRef、onCreate 或 onBind；真正激活发生在
  // useSyncExternalStore 的 subscribe（commit）阶段。
  const viewModel = binding.prepare(spec);
  const subscribe = useCallback(
    (listener: () => void) => binding.subscribe(spec, mode, listener),
    // generation 被 recycle 后，新的 prepared VM 会改变订阅函数身份，React 因此
    // 退订旧 handle 并订阅新 handle。
    [binding, mode, spec, viewModel],
  );
  const getSnapshot = useCallback(() => binding.getSnapshot(spec, mode), [binding, mode, spec]);

  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return viewModel;
}

/** 解析并监听 ViewModel 的更新。 */
export function useViewModel<T extends ViewModel>(spec: ViewModelSpec<T>): T {
  return useResolvedViewModel(spec, 'watch');
}

/** 解析并保活 ViewModel，但不因普通 notify 更新组件。回收 generation 时仍会重建。 */
export function useReadViewModel<T extends ViewModel>(spec: ViewModelSpec<T>): T {
  return useResolvedViewModel(spec, 'read');
}

interface SelectorCache<T extends ViewModel, Selection> {
  readonly binding: ViewModelBinding;
  readonly spec: ViewModelSpec<T>;
  readonly viewModel: T;
  readonly selector: ViewModelSelector<T, Selection>;
  version: unknown;
  readonly snapshot: SelectorSnapshot<Selection>;
}

interface SelectorSnapshot<Selection> {
  readonly value: Selection;
}

/**
 * 只在选择结果变化时更新组件。selector 接收 ViewModel，因此既可选普通字段，
 * 也可选 StateViewModel 的 state。
 */
export function useViewModelSelector<T extends ViewModel, Selection>(
  spec: ViewModelSpec<T>,
  selector: ViewModelSelector<T, Selection>,
  equals: ViewModelEquality<Selection> = Object.is,
): Selection {
  const binding = useViewModelBinding();
  const viewModel = binding.prepare(spec);
  const cache = useRef<SelectorCache<T, Selection> | undefined>(undefined);
  const subscribe = useCallback(
    (listener: () => void) => binding.subscribe(spec, 'watch', listener),
    [binding, spec, viewModel],
  );
  const getSnapshot = useCallback((): SelectorSnapshot<Selection> => {
    // recycle 可能在 selector 的值恰好相同时发生。每次读取 snapshot 都重新做纯
    // prepare，借此识别 generation；新 generation 必须返回新 wrapper 触发一次
    // render / resubscribe，普通同值更新仍复用旧 wrapper。
    const currentViewModel = binding.prepare(spec);
    const version = binding.getSnapshot(spec, 'watch');
    const previous = cache.current;

    if (
      previous !== undefined &&
      previous.binding === binding &&
      previous.spec === spec &&
      previous.viewModel === currentViewModel &&
      previous.selector === selector &&
      Object.is(previous.version, version)
    ) {
      return previous.snapshot;
    }

    const next = selector(currentViewModel);
    if (
      previous !== undefined &&
      previous.binding === binding &&
      previous.spec === spec &&
      previous.viewModel === currentViewModel &&
      equals(previous.snapshot.value, next)
    ) {
      cache.current = {
        binding,
        spec,
        viewModel: currentViewModel,
        selector,
        version,
        snapshot: previous.snapshot,
      };
      return previous.snapshot;
    }

    const snapshot = { value: next };
    cache.current = {
      binding,
      spec,
      viewModel: currentViewModel,
      selector,
      version,
      snapshot,
    };
    return snapshot;
  }, [binding, equals, selector, spec, viewModel]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).value;
}
