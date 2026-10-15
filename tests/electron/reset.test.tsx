import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it } from 'vitest';
import {
  ViewModel,
  ViewModelRuntime,
  ViewModelScope,
  useReadViewModel,
  useViewModel,
  useViewModelSelector,
  viewModelSpec,
} from '../../src/electron/index.js';

it.each(['runtime', 'global'] as const)(
  'mounted React hooks resubscribe after repeated %s resets',
  async (kind) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    ViewModel.reset();
    class Counter extends ViewModel {
      count = 0;
    }
    const spec = viewModelSpec(Counter, () => new Counter());
    const runtime = new ViewModelRuntime();
    const lifecycle = { isActive: () => true, subscribe: () => () => {} };
    let watched: Counter | undefined;
    let read: Counter | undefined;
    let selected = -1;
    let watchRenders = 0;
    let readRenders = 0;
    let selectorRenders = 0;
    function Watch() {
      watched = useViewModel(spec);
      watchRenders++;
      return null;
    }
    function Read() {
      read = useReadViewModel(spec);
      readRenders++;
      return null;
    }
    function Select() {
      selected = useViewModelSelector(spec, (vm) => vm.count);
      selectorRenders++;
      return null;
    }
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <ViewModelScope runtime={runtime} lifecycle={lifecycle}>
            <Watch />
            <Read />
            <Select />
          </ViewModelScope>,
        );
      });
      for (let index = 0; index < 2; index++) {
        const old = watched!;
        const before = [watchRenders, readRenders, selectorRenders];
        await act(async () => {
          if (kind === 'runtime') runtime.reset();
          else ViewModel.reset();
        });
        expect(old.isDisposed).toBe(true);
        expect(watched).not.toBe(old);
        expect(watched!.isDisposed).toBe(false);
        expect(read).toBe(watched);
        expect(selected).toBe(0);
        expect(watchRenders).toBeGreaterThan(before[0]!);
        expect(readRenders).toBeGreaterThan(before[1]!);
        expect(selectorRenders).toBeGreaterThan(before[2]!);
        const reads = readRenders;
        await act(async () => {
          watched!.update(() => {
            watched!.count = 1;
          });
        });
        expect(selected).toBe(1);
        expect(readRenders).toBe(reads);
        await act(async () => {
          watched!.update(() => {
            watched!.count = 0;
          });
        });
        expect(selected).toBe(0);
      }
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      runtime.dispose();
      ViewModel.reset();
    }
  },
);
