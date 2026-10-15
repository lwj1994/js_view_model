import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it } from 'vitest';
import {
  ViewModel,
  ViewModelRuntime,
  ViewModelScope,
  useViewModelSelector,
  viewModelSpec,
} from '../../src/electron/index.js';

it('React selectors use global equality unless explicitly overridden, and detect changed comparators', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ViewModel.reset();
  ViewModel.initialize({ config: { equals: () => true } });
  class Counter extends ViewModel {
    count = 0;
  }
  const spec = viewModelSpec(Counter, () => new Counter(), { key: 'counter' });
  const runtime = new ViewModelRuntime();
  const owner = runtime.createBinding();
  const vm = owner.read(spec);
  const values: number[] = [];
  function Capture({ local }: { local: boolean }) {
    const value = useViewModelSelector(spec, (vm) => vm.count, local ? Object.is : undefined);
    values.push(value);
    return null;
  }
  const lifecycle = { isActive: () => true, subscribe: () => () => {} };
  const page = (local: boolean) => (
    <ViewModelScope runtime={runtime} lifecycle={lifecycle}>
      <Capture local={local} />
    </ViewModelScope>
  );
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(page(false));
    });
    expect(values.at(-1)).toBe(0);
    await act(async () => {
      vm.update(() => {
        vm.count = 1;
      });
    });
    expect(values.at(-1)).toBe(0);
    await act(async () => {
      renderer!.update(page(true));
    });
    expect(values.at(-1)).toBe(1);
    await act(async () => {
      vm.update(() => {
        vm.count = 2;
      });
    });
    expect(values.at(-1)).toBe(2);
  } finally {
    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
    runtime.dispose();
    ViewModel.reset();
  }
});
