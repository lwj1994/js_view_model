import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  ViewModel,
  ViewModelRuntime,
  ViewModelSpec,
  ViewModelSpecError,
  viewModelSpec,
} from '../../src/core/index.js';
const runtimes: ViewModelRuntime[] = [];
const restores: (() => void)[] = [];
const runtime = () => {
  const value = new ViewModelRuntime();
  runtimes.push(value);
  return value;
};
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const app of runtimes.splice(0)) app.dispose();
  ViewModel.reset();
});
class Item extends ViewModel {
  constructor(readonly value: string) {
    super();
  }
}
const make = (value: string, key?: string) => viewModelSpec(Item, () => new Item(value), { key });

describe('typed argument Specs and isolated overrides', () => {
  it('computes argument identity from explicit type and key, not arguments or builder', () => {
    const build = vi.fn((id: string, label: string) => new Item(`${id}:${label}`));
    const family = ViewModelSpec.arg2(Item, build, {
      key: (id) => id,
      tag: () => 'item',
      aliveForever: () => true,
    });
    const binding = runtime().createBinding();
    const first = binding.read(family('1', 'first'));
    const second = binding.watch(family('1', 'ignored'));
    expect(second).toBe(first);
    expect(first.value).toBe('1:first');
    expect(build).toHaveBeenCalledOnce();
    expect(first.key).toBe('1');
    expect(first.tag).toBe('item');
    expect(first.instanceInfo?.aliveForever).toBe(true);
  });
  it('supports one, three and four typed arguments with local unkeyed identity', () => {
    const app = runtime();
    const binding = app.createBinding();
    const one = ViewModelSpec.arg(Item, (a: string) => new Item(a));
    const three = ViewModelSpec.arg3(
      Item,
      (a: string, b: number, c: boolean) => new Item(`${a}${b}${c}`),
    );
    const four = ViewModelSpec.arg4(
      Item,
      (a: string, b: number, c: boolean, d: string[]) => new Item(`${a}${b}${c}${d.join()}`),
    );
    expectTypeOf(one('1')).toEqualTypeOf<ViewModelSpec<Item>>();
    expect(binding.read(one('first'))).toBe(binding.read(one('ignored')));
    expect(app.createBinding().read(three('a', 1, true)).value).toBe('a1true');
    expect(app.createBinding().read(four('b', 2, false, ['x'])).value).toBe('b2falsex');
    // @ts-expect-error The second argument is a number.
    if (false) three('a', 'wrong', true);
  });
  it('validates retained family keys before invoking a builder', () => {
    const build = vi.fn((a: string) => new Item(a));
    const family = ViewModelSpec.arg(Item, build, { aliveForever: () => true });
    expect(() => family('x')).toThrow(ViewModelSpecError);
    expect(build).not.toHaveBeenCalled();
  });
  it('supports primitive and object-reference keys without string conversion', () => {
    const app = runtime();
    const first = app.createBinding();
    const second = app.createBinding();
    for (const key of [
      false,
      0n,
      Symbol('x'),
      {
        toString: () => {
          throw new Error('do not stringify');
        },
      },
    ]) {
      const spec = viewModelSpec(Item, () => new Item('keyed'), { key });
      expect(first.read(spec)).toBe(second.read(spec));
    }
    expect(first.read(viewModelSpec(Item, () => new Item('one'), { key: {} }))).not.toBe(
      first.read(viewModelSpec(Item, () => new Item('two'), { key: {} })),
    );
  });
  it('restores manual overrides idempotently, nested and out of order', () => {
    const spec = make('default');
    const app = runtime();
    const old = spec.overrideWith(make('old'));
    restores.push(old);
    const newest = spec.overrideWith(make('new'));
    restores.push(newest);
    expect(app.createBinding().read(spec).value).toBe('new');
    old();
    old();
    expect(app.createBinding().read(spec).value).toBe('new');
    newest();
    expect(app.createBinding().read(spec).value).toBe('default');
  });
  it('applies override key/tag/lifetime but preserves declared type and cache reuse', () => {
    const app = runtime();
    const binding = app.createBinding();
    const spec = make('original', 'shared');
    const original = binding.read(spec);
    const restore = spec.overrideWith(make('mock', 'shared'));
    restores.push(restore);
    expect(binding.read(spec)).toBe(original);
    restore();
    const replacement = viewModelSpec(Item, () => new Item('new'), {
      key: 'new',
      tag: 'mock',
      aliveForever: true,
    });
    restores.push(spec.overrideWith(replacement));
    const next = binding.read(spec);
    expect(next.key).toBe('new');
    expect(next.tag).toBe('mock');
    expect(next.instanceInfo?.type).toBe(Item);
    expect(binding.recycle(spec)).toBe(1);
    expect(next.isDisposed).toBe(true);
    expect(original.isDisposed).toBe(false);
  });
  it('rejects override cycles without constructing anything', () => {
    const a = make('a');
    const b = make('b');
    restores.push(a.overrideWith(b), b.overrideWith(a));
    const app = runtime();
    expect(() => app.createBinding().read(a)).toThrow('override cycle');
    expect(app.countInstances()).toBe(0);
  });
  it('overrides argument families for concrete Specs resolved before and after installation', () => {
    const base = ViewModelSpec.arg(Item, (id: string) => new Item(`base:${id}`), {
      key: (id) => id,
    });
    const replacement = ViewModelSpec.arg(Item, (id: string) => new Item(`mock:${id}`), {
      key: (id) => `mock:${id}`,
    });
    const resolved = base('1');
    const restore = base.overrideWith(replacement);
    restores.push(restore);
    const binding = runtime().createBinding();
    expect(binding.read(resolved).value).toBe('mock:1');
    expect(binding.read(base('2')).key).toBe('mock:2');
    restore();
    expect(binding.read(base('1')).value).toBe('base:1');
  });
  it('isolates overlapping async scopes and disposes them on success and failure', async () => {
    const spec = make('base', 'shared');
    const outer = runtime();
    const base = outer.createBinding().read(spec);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scopes: ViewModelRuntime[] = [];
    const first = spec.runWithOverride(make('one', 'shared'), async (scope) => {
      scopes.push(scope);
      await gate;
      return scope.createBinding().read(spec).value;
    });
    const second = spec.runWithOverride(make('two', 'shared'), async (scope) => {
      scopes.push(scope);
      const value = scope.createBinding().read(spec).value;
      release();
      await Promise.resolve();
      return value;
    });
    expect(await Promise.all([first, second])).toEqual(['one', 'two']);
    expect(base.value).toBe('base');
    expect(base.isDisposed).toBe(false);
    expect(scopes.every((scope) => scope.isDisposed)).toBe(true);
    let failed!: ViewModelRuntime;
    await expect(
      spec.runWithOverride(make('bad'), async (scope) => {
        failed = scope;
        throw new Error('body');
      }),
    ).rejects.toThrow('body');
    expect(failed.isDisposed).toBe(true);
  });
  it('nested scopes inherit frozen override selection without mutating the parent', async () => {
    const first = make('first', 'first');
    const second = make('second', 'second');
    const values: string[] = [];
    await first.runWithOverride(make('outer', 'first'), async (scope) => {
      await scope.runWithOverrides([[second, make('inner', 'second')]], async (nested) => {
        await Promise.resolve();
        const owner = nested.createBinding();
        values.push(owner.read(first).value, owner.read(second).value);
      });
      values.push(scope.createBinding().read(second).value);
    });
    expect(values).toEqual(['outer', 'inner', 'second']);
  });
  it('scoped overrides flow through parent dependency getters', async () => {
    const childSpec = make('real');
    class Parent extends ViewModel {
      get child() {
        return this.viewModelBinding.read(childSpec);
      }
    }
    await childSpec.runWithOverride(make('mock'), async (scope) => {
      const parent = scope.createBinding().read(viewModelSpec(Parent, () => new Parent()));
      await Promise.resolve();
      expect(parent.child.value).toBe('mock');
    });
  });
  it('argument families support async-isolated replacement selection', async () => {
    const family = ViewModelSpec.arg(Item, (id: number) => new Item(`real:${id}`));
    const fake = ViewModelSpec.arg(Item, (id: number) => new Item(`mock:${id}`));
    await family.runWithOverride(fake, async (scope) => {
      await Promise.resolve();
      expect(scope.createBinding().read(family(7)).value).toBe('mock:7');
    });
  });
  it('does not observe new manual overrides after an async scope has begun', async () => {
    const spec = make('base');
    let restore = () => {};
    await ViewModelRuntime.runWithOverrides([], async (scope) => {
      restore = spec.overrideWith(make('leak'));
      restores.push(restore);
      await Promise.resolve();
      expect(scope.createBinding().read(spec).value).toBe('base');
    });
    restore();
  });
});
