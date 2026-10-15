import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ViewModel,
  ViewModelRuntime,
  ViewModelDependencyCycleError,
  ViewModelSpecError,
  viewModelSpec,
  type ViewModelSpec,
} from '../../src/core/index.js';
let events: string[];
let errors: unknown[];
const runtimes: ViewModelRuntime[] = [];
const runtime = () => {
  const app = new ViewModelRuntime();
  runtimes.push(app);
  return app;
};
beforeEach(() => {
  ViewModel.reset();
  events = [];
  errors = [];
  ViewModel.initialize({ config: { onError: (error) => errors.push(error) } });
});
afterEach(() => {
  for (const app of runtimes.splice(0)) app.dispose();
  ViewModel.reset();
  expect(errors).toEqual([]);
});
class Node extends ViewModel {
  constructor(
    readonly name: string,
    readonly bound: (vm: Node, id: string) => void = () => {},
    readonly unbound: (vm: Node, id: string) => void = () => {},
  ) {
    super();
  }
  child(spec: ViewModelSpec<Node>, watch = false) {
    return watch ? this.viewModelBinding.watch(spec) : this.viewModelBinding.read(spec);
  }
  release(spec: ViewModelSpec<Node>) {
    return this.viewModelBinding.unbind(spec);
  }
  batch(tag: string, watch: boolean) {
    return watch
      ? this.viewModelBinding.watchCachesByTag(Node, tag)
      : this.viewModelBinding.readCachesByTag(Node, tag);
  }
  protected override onCreate() {
    events.push(`create:${this.name}`);
  }
  protected override onBind(id: string) {
    events.push(`bind:${this.name}:${id}`);
    this.bound(this, id);
  }
  protected override onUnbind(id: string) {
    events.push(`unbind:${this.name}:${id}`);
    this.unbound(this, id);
  }
  protected override onDispose() {
    events.push(`dispose:${this.name}`);
  }
}
const spec = (
  name: string,
  bound?: (vm: Node, id: string) => void,
  unbound?: (vm: Node, id: string) => void,
  tag?: string,
) => viewModelSpec(Node, () => new Node(name, bound, unbound), { key: name, tag });
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('Flutter 1.2.1 ownership commit regressions', () => {
  it('ordinary onUnbind can reacquire without losing replacement ownership and listeners', () => {
    const app = runtime();
    const update = vi.fn();
    const keeper = app.createBinding({ id: 'keeper' });
    const owner = app.createBinding({ id: 'owner', onUpdate: update });
    let rebind = true;
    const target = spec('node', undefined, (_vm, id) => {
      if (id === 'owner' && rebind) {
        rebind = false;
        owner.watch(target);
      }
    });
    keeper.read(target);
    const old = owner.watch(target);
    events.length = 0;
    owner.unbind(old);
    expect(events).toEqual(['unbind:node:owner', 'bind:node:owner']);
    expect(owner.read(target)).toBe(old);
    old.notifyListeners();
    expect(update).toHaveBeenCalledOnce();
    owner.dispose();
    expect(old.bindingIds).toEqual(['keeper']);
  });
  it('child reentry cancels the obsolete pending parent onUnbind', async () => {
    const app = runtime();
    const update = vi.fn();
    const owner = app.createBinding({ id: 'owner', onUpdate: update });
    const parent = spec('parent');
    let rebind = true;
    const child = spec('child', undefined, (_vm, id) => {
      if (id === 'owner' && rebind) {
        rebind = false;
        owner.watch(parent);
      }
    });
    const original = owner.watch(parent);
    original.child(child, true);
    events.length = 0;
    owner.unbind(original);
    expect(events).toEqual(['unbind:child:owner', 'bind:parent:owner', 'bind:child:owner']);
    expect(owner.read(parent)).toBe(original);
    original.child(child).notifyListeners();
    expect(update).toHaveBeenCalledOnce();
    owner.dispose();
    await flush();
    expect(events.filter((value) => value === 'unbind:parent:owner')).toHaveLength(1);
    expect(original.isDisposed).toBe(true);
  });
  it('nested rebind followed by unbind publishes the parent release once', () => {
    const app = runtime();
    const keeper = app.createBinding({ id: 'keeper' });
    const owner = app.createBinding({ id: 'owner' });
    const parent = spec('parent');
    let rebind = true;
    const child = spec('child', undefined, (_vm, id) => {
      if (id === 'owner' && rebind) {
        rebind = false;
        owner.watch(parent);
        owner.unbind(parent);
      }
    });
    keeper.read(parent);
    owner.watch(parent).child(child, true);
    events.length = 0;
    owner.unbind(parent);
    expect(events.filter((value) => value === 'unbind:parent:owner')).toHaveLength(1);
    expect(keeper.read(parent).bindingIds).toEqual(['keeper']);
  });
  for (const action of ['recycle', 'reset', 'release-last-owner']) {
    it(`preserves a pending parent release when child onUnbind triggers ${action}`, async () => {
      const app = runtime();
      const owner = app.createBinding({ id: 'owner' });
      const keeper = app.createBinding({ id: 'keeper' });
      const parent = spec('parent');
      let trigger = true;
      const child = spec('child', undefined, (_vm, id) => {
        if (id !== 'owner' || !trigger) return;
        trigger = false;
        if (action === 'recycle') app.recycle(parent);
        else if (action === 'reset') ViewModel.reset();
        else keeper.unbind(parent);
      });
      if (action === 'release-last-owner') keeper.read(parent);
      owner.watch(parent).child(child, true);
      events.length = 0;
      owner.unbind(parent);
      await flush();
      expect(events.filter((value) => value === 'unbind:parent:owner')).toHaveLength(1);
      expect(events.filter((value) => value === 'dispose:parent')).toHaveLength(1);
      expect(events.indexOf('unbind:parent:owner')).toBeLessThan(events.indexOf('dispose:parent'));
    });
  }
  it('commits an edge before onBind checks the reverse cycle', () => {
    const app = runtime();
    const owner = app.createBinding({ id: 'owner' });
    const parent = spec('parent');
    const rejected: unknown[] = [];
    const child = spec('child', (vm, id) => {
      if (id !== 'owner') {
        try {
          vm.child(parent);
        } catch (error) {
          rejected.push(error);
        }
      }
    });
    owner.read(parent).child(child);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(ViewModelDependencyCycleError);
    expect(app.getDiagnostics().dependencies).toHaveLength(1);
  });
  it('does not treat a found key with a rejected edge as a tag miss', () => {
    const app = runtime();
    const first = app.createBinding();
    const second = app.createBinding();
    const a = spec('a', undefined, undefined, 'batch');
    const b = spec('b', undefined, undefined, 'batch');
    const node = first.read(a);
    second.read(b);
    events.length = 0;
    expect(() => node.viewModelBinding.readCached(Node, { key: 'a', tag: 'batch' })).toThrow(
      ViewModelDependencyCycleError,
    );
    expect(() => node.viewModelBinding.maybeReadCached(Node, { key: 'a', tag: 'batch' })).toThrow(
      ViewModelDependencyCycleError,
    );
    expect(events).toEqual([]);
    expect(app.getDiagnostics().dependencies).toEqual([]);
  });
  for (const watch of [false, true]) {
    it(`preflights a complete tag batch watch=${watch} without changing pre-existing watches`, () => {
      const app = runtime();
      const updates = vi.fn();
      const owner = app.createBinding({ onUpdate: updates });
      const other = app.createBinding();
      const a = spec('a', undefined, undefined, 'batch');
      const b = spec('b', undefined, undefined, 'batch');
      const c = spec('c', undefined, undefined, 'batch');
      const parent = owner.watch(a);
      const middle = other.read(b);
      const child = other.read(c);
      parent.child(c, true);
      const before = app.getDiagnostics();
      events.length = 0;
      expect(() => parent.batch('batch', watch)).toThrow(ViewModelDependencyCycleError);
      expect(events).toEqual([]);
      expect(app.getDiagnostics()).toEqual(before);
      child.notifyListeners();
      middle.notifyListeners();
      expect(updates).toHaveBeenCalledOnce();
    });
    it(`a failed tag batch watch=${watch} preserves reentrant replacement registration and watch`, () => {
      const app = runtime();
      const keeper = app.createBinding({ id: 'keeper' });
      const update = vi.fn();
      const joining = app.createBinding({ id: 'joining', onUpdate: update });
      const b = spec('b', undefined, undefined, 'batch');
      let replace = true;
      const a = spec(
        'a',
        (vm, id) => {
          if (id === 'joining' && replace) {
            replace = false;
            joining.unbind(vm);
            joining.watch(a);
            app.recycle(b);
          }
        },
        undefined,
        'batch',
      );
      keeper.read(b);
      const node = keeper.read(a);
      expect(() =>
        watch ? joining.watchCachesByTag(Node, 'batch') : joining.readCachesByTag(Node, 'batch'),
      ).toThrow(ViewModelSpecError);
      expect(node.bindingIds).toEqual(['keeper', 'joining']);
      node.notifyListeners();
      expect(update).toHaveBeenCalledOnce();
      joining.dispose();
      expect(node.bindingIds).toEqual(['keeper']);
    });
  }
  it('reentrant child attachment is not removed with the obsolete parent edge', async () => {
    const app = runtime();
    const keeper = app.createBinding({ id: 'keeper' });
    const owner = app.createBinding({ id: 'owner' });
    const parent = spec('parent');
    let dependencyId: string | undefined;
    let reattach = true;
    const child = spec('child', undefined, (_vm, id) => {
      if (id === dependencyId && reattach) {
        reattach = false;
        owner.read(parent).child(child, true);
      }
    });
    const target = keeper.read(child);
    owner.read(parent).child(child, true);
    dependencyId = owner.read(parent).viewModelBinding.id;
    events.length = 0;
    owner.read(parent).release(child);
    expect(target.bindingIds).toContain(dependencyId);
    expect(target.bindingIds).toContain('owner');
    expect(events).not.toContain('unbind:child:owner');
    owner.dispose();
    await flush();
    expect(target.bindingIds).toEqual(['keeper']);
  });
  it('removes old cache before propagated unbind and coalesces recycle refreshes', () => {
    const app = runtime();
    const update = vi.fn();
    const owner = app.createBinding({ id: 'owner', onUpdate: update });
    const parent = spec('parent');
    let resolve = true;
    const child = spec('child', undefined, (_vm, id) => {
      if (id === 'owner' && resolve) {
        resolve = false;
        owner.watch(parent).notifyListeners();
      }
    });
    const original = owner.watch(parent);
    original.child(child);
    app.recycle(original);
    expect(owner.read(parent)).not.toBe(original);
    expect(owner.read(parent).isDisposed).toBe(false);
    expect(update).toHaveBeenCalledOnce();
    expect(events.filter((value) => value === 'dispose:parent')).toHaveLength(1);
    expect(events.filter((value) => value === 'dispose:child')).toHaveLength(1);
  });
});
