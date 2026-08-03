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
  // prepare may construct a pure object, but does not acquire it or call
  // onCreate/onBind. Activation happens in useSyncExternalStore subscribe (commit).
  const viewModel = binding.prepare(spec);
  const subscribe = useCallback(
    (listener: () => void) => binding.subscribe(spec, mode, listener),
    // After recycle, the newly prepared VM changes the subscription function
    // identity, so React unsubscribes from the old handle and subscribes to the new one.
    [binding, mode, spec, viewModel],
  );
  const getSnapshot = useCallback(() => binding.getSnapshot(spec, mode), [binding, mode, spec]);

  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return viewModel;
}

/** Resolve a ViewModel and subscribe to its updates. */
export function useViewModel<T extends ViewModel>(spec: ViewModelSpec<T>): T {
  return useResolvedViewModel(spec, 'watch');
}

/** Resolve and retain a ViewModel without rerendering on ordinary notifications. Recycle still rebuilds it. */
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
 * Update the component only when the selected value changes. The selector
 * receives the ViewModel and may select plain fields or StateViewModel state.
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
    // recycle can produce an equal selected value. Purely prepare on each
    // snapshot read to detect the generation: a new generation must return a
    // new wrapper to force one render/resubscribe, while ordinary equal-value
    // updates keep the previous wrapper.
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
