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
});
