import { describe, expect, it, vi } from 'vitest';

import {
  ViewModel,
  ViewModelDependencyCycleError,
  ViewModelRuntime,
  ViewModelSpecError,
  type ViewModelSpec,
  viewModelSpec,
} from '../../src/core/index.js';

const flushDependencyDisposals = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

class ChildViewModel extends ViewModel {
  public disposes = 0;

  public change(): void {
    this.notifyListeners('child.change');
  }

  protected override onDispose(): void {
    this.disposes += 1;
  }
}

class ParentViewModel extends ViewModel {
  public dependencyNotifications = 0;

  public constructor(private readonly childSpec: ViewModelSpec<ChildViewModel>) {
    super();
  }

  public get childRead(): ChildViewModel {
    return this.viewModelBinding.read(this.childSpec);
  }

  public get childWatch(): ChildViewModel {
    return this.viewModelBinding.watch(this.childSpec);
  }

  protected override onDependencyNotify(): void {
    this.dependencyNotifications += 1;
  }
}

describe('父子依赖图', () => {
  it('read 建立父子保活边，但不冒泡普通通知', async () => {
    const runtime = new ViewModelRuntime();
    const root = runtime.createBinding();
    const childSpec = viewModelSpec(() => new ChildViewModel());
    const parentSpec = viewModelSpec(() => new ParentViewModel(childSpec));
    const parent = root.read(parentSpec);
    const child = parent.childRead;

    child.change();
    expect(parent.version).toBe(0);
    expect(parent.dependencyNotifications).toBe(0);

    root.dispose();
    await flushDependencyDisposals();
    expect(parent.isDisposed).toBe(true);
    expect(child.isDisposed).toBe(true);
    expect(child.disposes).toBe(1);
  });

  it('watch 将 child 通知冒泡到 parent 与 root，且同步事务只投递一次', () => {
    const rootUpdate = vi.fn();
    const runtime = new ViewModelRuntime();
    const root = runtime.createBinding({ onUpdate: rootUpdate });
    const childSpec = viewModelSpec(() => new ChildViewModel());
    const parentSpec = viewModelSpec(() => new ParentViewModel(childSpec));
    const parent = root.watch(parentSpec);
    const child = parent.childWatch;

    child.change();

    expect(parent.version).toBe(1);
    expect(parent.dependencyNotifications).toBe(1);
    expect(rootUpdate).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('diamond graph 合法，并对共同祖先去重冒泡', () => {
    class Leaf extends ViewModel {
      public change(): void {
        this.notifyListeners();
      }
    }
    class Branch extends ViewModel {
      public constructor(private readonly leafSpec: ViewModelSpec<Leaf>) {
        super();
      }
      public get leaf(): Leaf {
        return this.viewModelBinding.watch(this.leafSpec);
      }
    }
    class Root extends ViewModel {
      public constructor(
        private readonly leftSpec: ViewModelSpec<Branch>,
        private readonly rightSpec: ViewModelSpec<Branch>,
      ) {
        super();
      }
      public get left(): Branch {
        return this.viewModelBinding.watch(this.leftSpec);
      }
      public get right(): Branch {
        return this.viewModelBinding.watch(this.rightSpec);
      }
    }

    const runtime = new ViewModelRuntime();
    const update = vi.fn();
    const binding = runtime.createBinding({ onUpdate: update });
    const leafSpec = viewModelSpec(() => new Leaf(), { key: 'shared-leaf' });
    const leftSpec = viewModelSpec(() => new Branch(leafSpec));
    const rightSpec = viewModelSpec(() => new Branch(leafSpec));
    const rootSpec = viewModelSpec(() => new Root(leftSpec, rightSpec));
    const root = binding.watch(rootSpec);
    const leftLeaf = root.left.leaf;
    const rightLeaf = root.right.leaf;
    expect(rightLeaf).toBe(leftLeaf);

    leftLeaf.change();

    expect(root.version).toBe(1);
    expect(root.left.version).toBe(1);
    expect(root.right.version).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('拒绝运行期 parent -> child 依赖环', () => {
    class Link extends ViewModel {
      public child(spec: ViewModelSpec<Link>): Link {
        return this.viewModelBinding.read(spec);
      }
    }
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const firstSpec = viewModelSpec(() => new Link(), {
      key: 'first',
      debugLabel: 'First',
    });
    const secondSpec = viewModelSpec(() => new Link(), {
      key: 'second',
      debugLabel: 'Second',
    });
    const first = binding.read(firstSpec);
    const second = first.child(secondSpec);

    expect(() => second.child(firstSpec)).toThrow(ViewModelDependencyCycleError);
    runtime.dispose();
  });

  it('拒绝 unkeyed private scope 沿 lineage 间接递归', () => {
    class Link extends ViewModel {
      public child(spec: ViewModelSpec<Link>): Link {
        return this.viewModelBinding.read(spec);
      }
    }
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const firstSpec = viewModelSpec(() => new Link(), { debugLabel: 'FirstUnkeyed' });
    const secondSpec = viewModelSpec(() => new Link(), { debugLabel: 'SecondUnkeyed' });
    const first = binding.read(firstSpec);
    const second = first.child(secondSpec);

    expect(() => second.child(firstSpec)).toThrow(ViewModelDependencyCycleError);
    runtime.dispose();
  });

  it('拒绝 builder 在 prepare 阶段 acquire 依赖', () => {
    let childCreates = 0;
    class Child extends ViewModel {
      protected override onCreate(): void {
        childCreates += 1;
      }
    }
    class Parent extends ViewModel {}
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const childSpec = viewModelSpec(() => new Child());
    const parentSpec = viewModelSpec(() => {
      binding.read(childSpec);
      return new Parent();
    });

    expect(() => binding.prepare(parentSpec)).toThrow(ViewModelSpecError);
    expect(childCreates).toBe(0);
    runtime.dispose();
  });

  it('recycle 在通知 owner 前同步结束旧 generation 的独占依赖树', () => {
    const events: string[] = [];
    let generation = 0;

    class Child extends ViewModel {
      public constructor(private readonly generation: number) {
        super();
      }

      protected override onCreate(): void {
        events.push(`child:create:${this.generation}`);
      }

      protected override onDispose(): void {
        events.push(`child:dispose:${this.generation}`);
      }
    }

    class Parent extends ViewModel {
      public constructor(
        private readonly generation: number,
        private readonly childSpec: ViewModelSpec<Child>,
      ) {
        super();
      }

      protected override onCreate(): void {
        events.push(`parent:create:${this.generation}`);
        this.viewModelBinding.read(this.childSpec);
      }

      protected override onDispose(): void {
        events.push(`parent:dispose:${this.generation}`);
      }
    }

    const runtime = new ViewModelRuntime();
    const childSpec = viewModelSpec(() => new Child(generation));
    const parentSpec = viewModelSpec(() => new Parent(++generation, childSpec));
    let root: ReturnType<ViewModelRuntime['createBinding']>;
    root = runtime.createBinding({ onUpdate: () => root.read(parentSpec) });

    root.read(parentSpec);
    runtime.recycle(parentSpec);

    expect(events).toEqual([
      'parent:create:1',
      'child:create:1',
      'parent:dispose:1',
      'child:dispose:1',
      'parent:create:2',
      'child:create:2',
    ]);

    runtime.dispose();
  });

  it('root 可强制 recycle 仅由 parent 持有的 child，并让 getter 解析新 generation', () => {
    const runtime = new ViewModelRuntime();
    const update = vi.fn();
    const binding = runtime.createBinding({ onUpdate: update });
    const childSpec = viewModelSpec(ChildViewModel, () => new ChildViewModel());
    const parentSpec = viewModelSpec(ParentViewModel, () => new ParentViewModel(childSpec));
    const parent = binding.watch(parentSpec);
    const child = parent.childRead;
    update.mockClear();

    expect(runtime.recycle(child)).toBe(1);

    expect(child.isDisposed).toBe(true);
    expect(parent.dependencyNotifications).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(parent.childRead).not.toBe(child);
    runtime.dispose();
  });

  it('把现有与后续 root source 实时传播到新 child，并支持多层镜像', async () => {
    class RootAwareViewModel extends ViewModel {
      public readonly bindIds: string[] = [];
      public readonly unbindIds: string[] = [];

      protected override onBind(bindingId: string): void {
        this.bindIds.push(bindingId);
      }

      protected override onUnbind(bindingId: string): void {
        this.unbindIds.push(bindingId);
      }
    }

    class Leaf extends RootAwareViewModel {}
    class Middle extends RootAwareViewModel {
      public constructor(private readonly leafSpec: ViewModelSpec<Leaf>) {
        super();
      }

      public get leaf(): Leaf {
        return this.viewModelBinding.read(this.leafSpec);
      }
    }
    class Top extends RootAwareViewModel {
      public constructor(private readonly middleSpec: ViewModelSpec<Middle>) {
        super();
      }

      public get middle(): Middle {
        return this.viewModelBinding.read(this.middleSpec);
      }
    }

    const runtime = new ViewModelRuntime();
    const rootA = runtime.createBinding({ id: 'root-a' });
    const rootB = runtime.createBinding({ id: 'root-b' });
    const rootC = runtime.createBinding({ id: 'root-c' });
    const leafSpec = viewModelSpec(() => new Leaf());
    const middleSpec = viewModelSpec(() => new Middle(leafSpec));
    const topSpec = viewModelSpec(() => new Top(middleSpec), { key: 'shared-top' });

    const top = rootA.read(topSpec);
    expect(rootB.read(topSpec)).toBe(top);

    // Both roots already exist when the dependency chain is resolved.
    const middle = top.middle;
    const leaf = middle.leaf;
    expect(middle.bindIds.filter((id) => id.startsWith('root-'))).toEqual(['root-a', 'root-b']);
    expect(leaf.bindIds.filter((id) => id.startsWith('root-'))).toEqual(['root-a', 'root-b']);

    rootA.dispose();
    expect(top.unbindIds.filter((id) => id === 'root-a')).toHaveLength(1);
    expect(middle.unbindIds.filter((id) => id === 'root-a')).toHaveLength(1);
    expect(leaf.unbindIds.filter((id) => id === 'root-a')).toHaveLength(1);
    expect(top.isDisposed).toBe(false);
    expect(middle.isDisposed).toBe(false);
    expect(leaf.isDisposed).toBe(false);

    // A new root added after child resolution is mirrored through every level.
    expect(rootC.read(topSpec)).toBe(top);
    expect(top.bindIds.filter((id) => id === 'root-c')).toHaveLength(1);
    expect(middle.bindIds.filter((id) => id === 'root-c')).toHaveLength(1);
    expect(leaf.bindIds.filter((id) => id === 'root-c')).toHaveLength(1);

    rootB.dispose();
    rootC.dispose();
    expect(top.unbindIds.filter((id) => id.startsWith('root-'))).toEqual([
      'root-a',
      'root-b',
      'root-c',
    ]);
    expect(middle.unbindIds.filter((id) => id.startsWith('root-'))).toEqual([
      'root-a',
      'root-b',
      'root-c',
    ]);
    expect(leaf.unbindIds.filter((id) => id.startsWith('root-'))).toEqual([
      'root-a',
      'root-b',
      'root-c',
    ]);

    await flushDependencyDisposals();
    expect(top.isDisposed).toBe(true);
    expect(middle.isDisposed).toBe(true);
    expect(leaf.isDisposed).toBe(true);
    runtime.dispose();
  });

  it('同一 root 的 direct 与多 parent source 独立释放，首尾各触发生命周期一次', async () => {
    class Leaf extends ViewModel {
      public readonly bindIds: string[] = [];
      public readonly unbindIds: string[] = [];

      protected override onBind(bindingId: string): void {
        this.bindIds.push(bindingId);
      }

      protected override onUnbind(bindingId: string): void {
        this.unbindIds.push(bindingId);
      }
    }

    class Branch extends ViewModel {
      public constructor(private readonly leafSpec: ViewModelSpec<Leaf>) {
        super();
      }

      public get leaf(): Leaf {
        return this.viewModelBinding.read(this.leafSpec);
      }
    }

    const runtime = new ViewModelRuntime();
    const root = runtime.createBinding({ id: 'shared-root' });
    const leafSpec = viewModelSpec(() => new Leaf(), { key: 'shared-leaf-sources' });
    const leftSpec = viewModelSpec(() => new Branch(leafSpec));
    const rightSpec = viewModelSpec(() => new Branch(leafSpec));

    const leaf = root.read(leafSpec);
    const left = root.read(leftSpec);
    const right = root.read(rightSpec);
    expect(left.leaf).toBe(leaf);
    expect(right.leaf).toBe(leaf);
    expect(leaf.bindIds.filter((id) => id === 'shared-root')).toHaveLength(1);

    runtime.recycle(left);
    expect(leaf.unbindIds.filter((id) => id === 'shared-root')).toHaveLength(0);

    runtime.recycle(right);
    expect(leaf.unbindIds.filter((id) => id === 'shared-root')).toHaveLength(0);
    expect(leaf.isDisposed).toBe(false);

    root.dispose();
    expect(leaf.unbindIds.filter((id) => id === 'shared-root')).toHaveLength(1);
    await flushDependencyDisposals();
    expect(leaf.isDisposed).toBe(true);
    runtime.dispose();
  });

  it('direct listener 触发 sibling notify 时，整条同步级联只更新 parent/root 一次', () => {
    class Emitter extends ViewModel {
      public emit(): void {
        this.notifyListeners();
      }
    }
    class Parent extends ViewModel {
      public dependencyNotifications = 0;

      public constructor(
        private readonly firstSpec: ViewModelSpec<Emitter>,
        private readonly secondSpec: ViewModelSpec<Emitter>,
      ) {
        super();
      }

      public get first(): Emitter {
        return this.viewModelBinding.watch(this.firstSpec);
      }

      public get second(): Emitter {
        return this.viewModelBinding.watch(this.secondSpec);
      }

      protected override onDependencyNotify(): void {
        this.dependencyNotifications += 1;
      }
    }

    const runtime = new ViewModelRuntime();
    const update = vi.fn();
    const binding = runtime.createBinding({ onUpdate: update });
    const firstSpec = viewModelSpec(() => new Emitter(), { key: 'nested-first' });
    const secondSpec = viewModelSpec(() => new Emitter(), { key: 'nested-second' });
    const parentSpec = viewModelSpec(() => new Parent(firstSpec, secondSpec));
    const parent = binding.watch(parentSpec);
    const first = parent.first;
    const second = parent.second;
    first.subscribe(() => second.emit());

    first.emit();

    expect(parent.dependencyNotifications).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('microtask 中的 child notify 会开启新的 propagation transaction', async () => {
    const runtime = new ViewModelRuntime();
    const update = vi.fn();
    const binding = runtime.createBinding({ onUpdate: update });
    const childSpec = viewModelSpec(() => new ChildViewModel());
    const parentSpec = viewModelSpec(() => new ParentViewModel(childSpec));
    const parent = binding.watch(parentSpec);
    const child = parent.childWatch;
    let scheduleAgain = true;
    child.subscribe(() => {
      if (!scheduleAgain) return;
      scheduleAgain = false;
      queueMicrotask(() => child.change());
    });

    child.change();
    await Promise.resolve();

    expect(parent.dependencyNotifications).toBe(2);
    expect(update).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it('aliveForever parent 会传递性保活已解析的 private child', async () => {
    class Child extends ViewModel {
      public readonly boundIds: string[] = [];

      protected override onBind(bindingId: string): void {
        this.boundIds.push(bindingId);
      }
    }
    class Parent extends ViewModel {
      public constructor(private readonly childSpec: ViewModelSpec<Child>) {
        super();
      }

      public get child(): Child {
        return this.viewModelBinding.read(this.childSpec);
      }
    }

    const runtime = new ViewModelRuntime();
    const childSpec = viewModelSpec(Child, () => new Child());
    const parentSpec = viewModelSpec(Parent, () => new Parent(childSpec), {
      key: 'alive-parent',
      aliveForever: true,
    });
    const firstOwner = runtime.createBinding({ id: 'first-owner' });
    const parent = firstOwner.read(parentSpec);
    const child = parent.child;

    firstOwner.dispose();
    await flushDependencyDisposals();
    expect(parent.isDisposed).toBe(false);
    expect(child.isDisposed).toBe(false);

    const secondOwner = runtime.createBinding({ id: 'second-owner' });
    expect(secondOwner.read(parentSpec)).toBe(parent);
    expect(parent.child).toBe(child);
    expect(child.boundIds).toContain('second-owner');

    expect(runtime.recycle(parent)).toBe(1);
    expect(parent.isDisposed).toBe(true);
    expect(child.isDisposed).toBe(true);
    secondOwner.dispose();
    runtime.dispose();
  });
});
