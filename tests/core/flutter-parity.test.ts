import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  StateViewModel,
  ViewModel,
  ViewModelRuntime,
  ViewModelDependencyCycleError,
  type ViewModelBinding,
  type ViewModelSpec,
  viewModelSpec,
} from '../../src/core/index.js';

const runtimes: ViewModelRuntime[] = [];
const runtime = () => {
  const result = new ViewModelRuntime();
  runtimes.push(result);
  return result;
};
afterEach(() => {
  for (const item of runtimes.splice(0)) item.dispose();
});

class Counter extends StateViewModel<number> {
  constructor() {
    super(0);
  }
  set(value: number): void {
    this.setState(value);
  }
  emit(): void {
    this.notifyListeners();
  }
}

class Node extends ViewModel {
  constructor(
    readonly bindHook: (vm: Node, id: string) => void = () => {},
    readonly unbindHook: (vm: Node, id: string) => void = () => {},
    readonly createHook: (vm: Node) => void = () => {},
  ) {
    super();
  }
  emit(): void {
    this.notifyListeners();
  }
  child(spec: ViewModelSpec<Node>, watch = false): Node {
    return watch ? this.viewModelBinding.watch(spec) : this.viewModelBinding.read(spec);
  }
  protected override onCreate(): void {
    this.createHook(this);
  }
  protected override onBind(id: string): void {
    this.bindHook(this, id);
  }
  protected override onUnbind(id: string): void {
    this.unbindHook(this, id);
  }
}

describe('Flutter main behavioral parity', () => {
  it('delivers reentrant state events in transition order to every listener', () => {
    const binding = runtime().createBinding();
    const spec = viewModelSpec(Counter, () => new Counter());
    const events: string[] = [];
    binding.listenState(spec, (previous, current) => {
      events.push(`a:${previous}->${current}`);
      if (current === 1) binding.read(spec).set(2);
    });
    binding.listenState(spec, (previous, current) => events.push(`b:${previous}->${current}`));
    binding.read(spec).set(1);
    expect(events).toEqual(['a:0->1', 'b:0->1', 'a:1->2', 'b:1->2']);
  });

  it('coalesces root refreshes across reentrant state transitions, not business events', () => {
    const onUpdate = vi.fn();
    const binding = runtime().createBinding({ onUpdate });
    const spec = viewModelSpec(Counter, () => new Counter());
    binding.watch(spec);
    binding.listenState(spec, (_previous, current) => {
      if (current === 1) binding.read(spec).set(2);
    });
    const effects = vi.fn();
    binding.listen(spec, effects);
    binding.read(spec).set(1);
    expect(effects).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('keeps each dependency notification in a diamond graph', () => {
    const owner = runtime().createBinding({ onUpdate: vi.fn() });
    const leaf = viewModelSpec(Node, () => new Node(), { key: 'leaf' });
    const left = viewModelSpec(Node, () => new Node(), { key: 'left' });
    const right = viewModelSpec(Node, () => new Node(), { key: 'right' });
    const root = viewModelSpec(Node, () => new Node(), { key: 'root' });
    owner.watch(root).child(left, true).child(leaf, true);
    owner.read(root).child(right, true).child(leaf, true);
    const business = vi.fn();
    owner.listen(root, business);
    owner.read(leaf).emit();
    expect(business).toHaveBeenCalledTimes(2);
    expect(owner.read(root).version).toBe(2);
  });

  it('skips broad and state listeners removed during dispatch', () => {
    const binding = runtime().createBinding();
    const spec = viewModelSpec(Counter, () => new Counter());
    let removeBroad = () => {};
    let removeState = () => {};
    const broad = vi.fn();
    const state = vi.fn();
    binding.listen(spec, () => removeBroad());
    removeBroad = binding.listen(spec, broad);
    binding.listenState(spec, () => removeState());
    removeState = binding.listenState(spec, state);
    binding.read(spec).set(1);
    expect(broad).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
  });

  it('does not call remaining state listeners or notify after synchronous recycle', () => {
    const app = runtime();
    const binding = app.createBinding();
    const spec = viewModelSpec(Counter, () => new Counter());
    const remaining = vi.fn();
    binding.listenState(spec, () => app.recycle(spec));
    binding.listenState(spec, remaining);
    const vm = binding.read(spec);
    expect(() => vm.set(1)).not.toThrow();
    expect(remaining).not.toHaveBeenCalled();
    expect(vm.isDisposed).toBe(true);
  });

  it('preserves an onBind reentrant read-to-watch upgrade', () => {
    const app = runtime();
    const onUpdate = vi.fn();
    const binding = app.createBinding({ onUpdate });
    const spec = viewModelSpec(Node, () => new Node(() => binding.watch(spec)), { key: 'node' });
    binding.read(spec).emit();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  for (const phase of ['builder', 'create', 'bind'] as const) {
    for (const retained of [false, true]) {
      it(`rolls back ${phase}-disposed owners, including retained=${retained} generations`, async () => {
        const app = runtime();
        const binding = app.createBinding();
        const instances: Node[] = [];
        const spec = viewModelSpec(
          Node,
          () => {
            if (phase === 'builder') binding.dispose();
            const vm = new Node(
              () => {
                if (phase === 'bind') binding.dispose();
              },
              undefined,
              () => {
                if (phase === 'create') binding.dispose();
              },
            );
            instances.push(vm);
            return vm;
          },
          { key: 'node', aliveForever: retained },
        );
        expect(() => binding.read(spec)).toThrow();
        await Promise.resolve();
        expect(instances).toHaveLength(1);
        expect(instances[0]?.isDisposed).toBe(true);
        expect(app.createBinding().maybeReadCached(Node)).toBeUndefined();
      });
    }
  }

  it('rejects a joining owner disposed in onBind without recycling another owner', () => {
    const app = runtime();
    const keep = app.createBinding({ id: 'keep' });
    const join = app.createBinding({ id: 'join' });
    const spec = viewModelSpec(
      Node,
      () =>
        new Node((_vm, id) => {
          if (id === 'join') join.dispose();
        }),
      { key: 'node' },
    );
    const original = keep.read(spec);
    expect(() => join.watch(spec)).toThrow();
    expect(original.isDisposed).toBe(false);
    expect(keep.read(spec)).toBe(original);
  });

  it('preflights every tag-batch edge before binding any candidate', () => {
    const app = runtime();
    const creator = app.createBinding();
    const events: string[] = [];
    const first = viewModelSpec(Node, () => new Node((_vm, id) => events.push(id)), {
      key: 'first',
      tag: 'group',
    });
    const root = viewModelSpec(Node, () => new Node(), { key: 'root', tag: 'group' });
    creator.read(first);
    const parent = creator.read(root);
    events.length = 0;
    expect(() => parent.viewModelBinding.watchCachesByTag(Node, 'group')).toThrow(
      ViewModelDependencyCycleError,
    );
    expect(events).toEqual([]);
  });

  it('returns tag batches in newest-first creation order', () => {
    const binding = runtime().createBinding();
    const first = viewModelSpec(Node, () => new Node(), { key: 'a', tag: 'group' });
    const second = viewModelSpec(Node, () => new Node(), { key: 'b', tag: 'group' });
    const a = binding.read(first);
    const b = binding.read(second);
    binding.read(first);
    expect(binding.readCachesByTag(Node, 'group')).toEqual([b, a]);
  });

  it('does not publish roots removed by a child onBind callback', () => {
    const app = runtime();
    const first = app.createBinding({ id: 'first' });
    const joining = app.createBinding({ id: 'joining' });
    const events: string[] = [];
    const grand = viewModelSpec(
      Node,
      () =>
        new Node(
          (_vm, id) => events.push(`+${id}`),
          (_vm, id) => events.push(`-${id}`),
        ),
      { key: 'grandchild' },
    );
    const child = viewModelSpec(
      Node,
      () =>
        new Node((_vm, id) => {
          if (id === 'joining') joining.dispose();
        }),
      { key: 'child' },
    );
    const parentSpec = viewModelSpec(Node, () => new Node(), { key: 'parent' });
    const parent = first.read(parentSpec);
    const leaf = parent.child(child).child(grand);
    events.length = 0;
    expect(() => joining.read(parentSpec)).toThrow();
    expect(events.filter((event) => event.includes('joining'))).toEqual([]);
    expect(leaf.isDisposed).toBe(false);
  });
});
