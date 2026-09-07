import { createRenderer, defineComponent, effectScope, h, isProxy, watchEffect } from 'vue';
import { describe, expect, it } from 'vitest';
import {
  ViewModel,
  ViewModelRuntime,
  viewModelSpec,
  useViewModelScope,
  useViewModel,
  useReadViewModel,
  useViewModelSelector,
} from '../src/vue/index.js';

class Counter extends ViewModel {
  count = 0;
  increment(amount = 1) {
    this.count += amount;
    this.notifyListeners();
  }
}
const spec = viewModelSpec(Counter, () => new Counter());

describe('Vue bridge', () => {
  it('tracks raw mutable instances, read mode, selectors, pause, and repeated recycle', () => {
    const effects = effectScope();
    const runtime = new ViewModelRuntime();
    let stopChecks = () => {};
    effects.run(() => {
      const owner = useViewModelScope({ runtime });
      const vm = useViewModel(spec);
      const read = useReadViewModel(spec);
      const parity = useViewModelSelector(spec, (vm) => vm.count % 2);
      let renders = 0,
        reads = 0,
        selections = 0;
      const stops = [
        watchEffect(
          () => {
            void vm.value.count;
            renders++;
          },
          { flush: 'sync' },
        ),
        watchEffect(
          () => {
            void read.value;
            reads++;
          },
          { flush: 'sync' },
        ),
        watchEffect(
          () => {
            void parity.value;
            selections++;
          },
          { flush: 'sync' },
        ),
      ];
      expect(isProxy(vm.value)).toBe(false);
      expect(read.value).toBe(vm.value);
      vm.value.increment();
      expect([renders, reads, selections]).toEqual([2, 1, 2]);
      vm.value.increment(2);
      expect([renders, reads, selections]).toEqual([3, 1, 2]);
      runtime.pause();
      vm.value.increment();
      expect(renders).toBe(3);
      runtime.resume();
      expect(renders).toBe(4);
      for (let i = 0; i < 2; i++) {
        const old = vm.value;
        runtime.recycle(old);
        expect(old.isDisposed).toBe(true);
        expect(vm.value).not.toBe(old);
        expect(read.value).toBe(vm.value);
        vm.value.increment();
        expect(parity.value).toBe(1);
      }
      stopChecks = () => {
        expect(owner.isDisposed).toBe(true);
        expect(runtime.isDisposed).toBe(false);
        stops.forEach((stop) => stop());
      };
    });
    effects.stop();
    stopChecks();
    runtime.dispose();
  });

  it('owns root runtimes and rejects calls outside effect scopes', () => {
    expect(() => useViewModel(spec)).toThrow('active Vue effect scope');
    const effects = effectScope();
    const owner = effects.run(() => useViewModelScope())!;
    effects.stop();
    expect(owner.runtime.isDisposed).toBe(true);
  });

  it('gives child components private bindings and shares explicit keys', async () => {
    type Node = { children: Node[] };
    const renderer = createRenderer<Node, Node>({
      createElement: () => ({ children: [] }),
      createText: () => ({ children: [] }),
      createComment: () => ({ children: [] }),
      insert: (node, parent) => {
        parent.children.push(node);
      },
      remove: () => {},
      setText: () => {},
      setElementText: () => {},
      parentNode: () => null,
      nextSibling: () => null,
      patchProp: () => {},
    });
    const privateModels: Counter[] = [],
      sharedModels: Counter[] = [];
    const runtime = new ViewModelRuntime();
    const Child = defineComponent({
      setup() {
        privateModels.push(useViewModel(spec).value);
        sharedModels.push(useViewModel(spec.withKey('shared')).value);
        return () => h('view');
      },
    });
    const app = renderer.createApp(
      defineComponent({
        setup() {
          useViewModelScope({ runtime });
          return () => h('view', [h(Child), h(Child)]);
        },
      }),
    );
    app.mount({ children: [] });
    expect(privateModels[0]).not.toBe(privateModels[1]);
    expect(sharedModels[0]).toBe(sharedModels[1]);
    app.unmount();
    await Promise.resolve();
    expect(privateModels.every((vm) => vm.isDisposed)).toBe(true);
    expect(sharedModels[0]!.isDisposed).toBe(true);
    expect(runtime.isDisposed).toBe(false);
    runtime.dispose();
  });
});
