import { describe, expect, it, vi } from 'vitest';

import {
  StateViewModel,
  ViewModel,
  ViewModelRuntime,
  ViewModelSpecError,
  type ViewModelSpec,
  viewModelSpec,
} from '../../src/core/index.js';

const flushDisposals = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const sharedKey = 'cached-shared-child';
const childrenTag = 'cached-tagged-children';

class CachedChildViewModel extends ViewModel {
  public readonly boundIds: string[] = [];
  public readonly unboundIds: string[] = [];

  public emit(): void {
    this.notifyListeners();
  }

  protected override onBind(bindingId: string): void {
    this.boundIds.push(bindingId);
  }

  protected override onUnbind(bindingId: string): void {
    this.unboundIds.push(bindingId);
  }
}

class CachedParentViewModel extends ViewModel {
  public dependencyNotifications = 0;
  public listenCallbacks = 0;

  public constructor(private readonly childSpec: ViewModelSpec<CachedChildViewModel>) {
    super();
  }

  public get cachedChild(): CachedChildViewModel {
    return this.viewModelBinding.readCached(CachedChildViewModel, { key: sharedKey });
  }

  public get watchedCachedChild(): CachedChildViewModel {
    return this.viewModelBinding.watchCached(CachedChildViewModel, { key: sharedKey });
  }

  public get taggedChildren(): CachedChildViewModel[] {
    return this.viewModelBinding.readCachesByTag(CachedChildViewModel, childrenTag);
  }

  public get child(): CachedChildViewModel {
    return this.viewModelBinding.watch(this.childSpec);
  }

  public listenToChild(): void {
    this.viewModelBinding.listen(this.childSpec, () => {
      this.listenCallbacks += 1;
    });
  }

  protected override onDependencyNotify(): void {
    this.dependencyNotifications += 1;
  }
}

describe('cached/tag/listen 的 VM→VM DI 语义', () => {
  it('cached 与 tag batch 命中后建立同样的 parent ownership', async () => {
    const runtime = new ViewModelRuntime();
    const creator = runtime.createBinding({ id: 'creator' });
    const owner = runtime.createBinding({ id: 'owner' });
    const sharedSpec = viewModelSpec(CachedChildViewModel, () => new CachedChildViewModel(), {
      key: sharedKey,
    });
    const taggedASpec = viewModelSpec(CachedChildViewModel, () => new CachedChildViewModel(), {
      key: 'tagged-a',
      tag: childrenTag,
    });
    const taggedBSpec = viewModelSpec(CachedChildViewModel, () => new CachedChildViewModel(), {
      key: 'tagged-b',
      tag: childrenTag,
    });
    const parentSpec = viewModelSpec(
      CachedParentViewModel,
      () => new CachedParentViewModel(sharedSpec),
    );
    const shared = creator.read(sharedSpec);
    const taggedA = creator.read(taggedASpec);
    const taggedB = creator.read(taggedBSpec);
    const parent = owner.read(parentSpec);

    expect(parent.cachedChild).toBe(shared);
    expect(parent.taggedChildren).toEqual([taggedA, taggedB]);
    expect(shared.boundIds).toContain('owner');
    expect(taggedA.boundIds).toContain('owner');
    expect(taggedB.boundIds).toContain('owner');

    creator.dispose();
    await flushDisposals();
    expect(shared.isDisposed).toBe(false);
    expect(taggedA.isDisposed).toBe(false);
    expect(taggedB.isDisposed).toBe(false);

    owner.dispose();
    await flushDisposals();
    expect(shared.isDisposed).toBe(true);
    expect(taggedA.isDisposed).toBe(true);
    expect(taggedB.isDisposed).toBe(true);
    runtime.dispose();
  });

  it('watchCached 只冒泡一次，并按 type + key 跨 Spec 命中', () => {
    const runtime = new ViewModelRuntime();
    const creator = runtime.createBinding();
    const update = vi.fn();
    const owner = runtime.createBinding({ onUpdate: update });
    const creatorSpec = viewModelSpec(CachedChildViewModel, () => new CachedChildViewModel(), {
      key: sharedKey,
    });
    const independentSpec = viewModelSpec(CachedChildViewModel, () => new CachedChildViewModel(), {
      key: sharedKey,
    });
    const parentSpec = viewModelSpec(
      CachedParentViewModel,
      () => new CachedParentViewModel(independentSpec),
    );
    const child = creator.read(creatorSpec);
    const parent = owner.watch(parentSpec);

    expect(parent.watchedCachedChild).toBe(child);
    update.mockClear();
    child.emit();

    expect(parent.dependencyNotifications).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('shared parent 的 watch 与 Binding-owned listen 对所有 roots 只安装一次', () => {
    const runtime = new ViewModelRuntime();
    const updateA = vi.fn();
    const updateB = vi.fn();
    const ownerA = runtime.createBinding({ id: 'owner-a', onUpdate: updateA });
    const ownerB = runtime.createBinding({ id: 'owner-b', onUpdate: updateB });
    const childSpec = viewModelSpec(CachedChildViewModel, () => new CachedChildViewModel());
    const parentSpec = viewModelSpec(
      CachedParentViewModel,
      () => new CachedParentViewModel(childSpec),
      { key: 'shared-parent' },
    );
    const parent = ownerA.watch(parentSpec);
    const child = parent.child;
    parent.listenToChild();
    expect(ownerB.watch(parentSpec)).toBe(parent);
    updateA.mockClear();
    updateB.mockClear();

    child.emit();

    expect(parent.dependencyNotifications).toBe(1);
    expect(parent.listenCallbacks).toBe(1);
    expect(updateA).toHaveBeenCalledTimes(1);
    expect(updateB).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('maybe/cache miss 不创建实例，key miss 可按 tag 回退', () => {
    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const builder = vi.fn(() => new CachedChildViewModel());
    const missingSpec = viewModelSpec(CachedChildViewModel, builder, { key: 'missing' });

    expect(binding.maybeReadCached(CachedChildViewModel, { key: 'missing' })).toBeUndefined();
    expect(binding.maybeWatchCached(missingSpec, { tag: 'missing' })).toBeUndefined();
    expect(binding.readCachesByTag(CachedChildViewModel, 'missing')).toEqual([]);
    expect(() => binding.readCached(CachedChildViewModel, { key: 'missing' })).toThrow(
      ViewModelSpecError,
    );
    expect(builder).not.toHaveBeenCalled();

    const taggedSpec = viewModelSpec(CachedChildViewModel, () => new CachedChildViewModel(), {
      key: 'actual-key',
      tag: childrenTag,
    });
    const tagged = binding.read(taggedSpec);
    expect(
      binding.readCached(CachedChildViewModel, {
        key: 'not-the-key',
        tag: childrenTag,
      }),
    ).toBe(tagged);
    runtime.dispose();
  });

  it('listenState 与 listenStateSelect 由 Binding 自动清理', () => {
    class CounterStateViewModel extends StateViewModel<number> {
      public constructor() {
        super(0);
      }

      public set(value: number): void {
        this.setState(value);
      }
    }

    const runtime = new ViewModelRuntime();
    const binding = runtime.createBinding();
    const spec = viewModelSpec(CounterStateViewModel, () => new CounterStateViewModel());
    const states = vi.fn();
    const parity = vi.fn();
    binding.listenState(spec, states);
    binding.listenStateSelect(spec, (state) => state % 2, parity);
    const counter = binding.read(spec);

    counter.set(1);
    counter.set(3);
    expect(states).toHaveBeenCalledTimes(2);
    expect(parity).toHaveBeenCalledTimes(1);

    binding.dispose();
    expect(() => counter.set(4)).not.toThrow();
    expect(states).toHaveBeenCalledTimes(2);
    expect(parity).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });
});
