import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ViewModel, ViewModelRuntime, viewModelSpec } from '../../src/core/index.js';

const runtimes: ViewModelRuntime[] = [];
let warnings: string[] = [];
let errors: unknown[] = [];
const runtime = () => {
  const value = new ViewModelRuntime();
  runtimes.push(value);
  return value;
};
class Item extends ViewModel {
  constructor(readonly value: string) {
    super();
  }
}
beforeEach(() => {
  ViewModel.reset();
  warnings = [];
  errors = [];
  ViewModel.initialize({
    config: { onWarning: (text) => warnings.push(text), onError: (error) => errors.push(error) },
  });
});
afterEach(() => {
  for (const item of runtimes.splice(0)) item.dispose();
  ViewModel.reset();
  expect(errors).toEqual([]);
});

it('non-owning Runtime lookup neither creates nor extends a generation lifetime', async () => {
  const app = runtime();
  const owner = app.createBinding();
  const build = vi.fn(() => new Item('one'));
  const spec = viewModelSpec(Item, build, { key: 'one', tag: 'group' });
  expect(app.maybeReadCached(spec)).toBeUndefined();
  expect(build).not.toHaveBeenCalled();
  const value = owner.read(spec);
  expect(app.readCached(Item, { key: 'one' })).toBe(value);
  expect(app.readCachesByTag(Item, 'group')).toEqual([value]);
  expect(value.bindingIds).toEqual([owner.id]);
  owner.dispose();
  await Promise.resolve();
  expect(value.isDisposed).toBe(true);
  expect(app.countInstances()).toBe(0);
  expect(() => app.readCached(spec)).toThrow();
});

it('cache reuse does not change creation order and ambiguous tags warn once without coercion', () => {
  const app = runtime();
  const owner = app.createBinding();
  const tag = {
    toString() {
      throw new Error('do not coerce tags');
    },
  };
  const firstSpec = viewModelSpec(Item, () => new Item('first'), { key: 'first', tag });
  const secondSpec = viewModelSpec(Item, () => new Item('second'), { key: 'second', tag });
  const first = owner.read(firstSpec);
  const second = owner.read(secondSpec);
  owner.watch(firstSpec);
  owner.read(firstSpec);
  expect(app.readCached(Item)).toBe(second);
  expect(warnings).toEqual([]);
  expect(app.readCached(Item, { tag })).toBe(second);
  app.readCached(Item, { tag });
  expect(warnings).toHaveLength(1);
  expect(app.readCached(Item, { key: 'first', tag })).toBe(first);
  expect(app.readCached(Item, { key: 'missing', tag })).toBe(second);
  expect(app.readCachesByTag(Item, tag)).toEqual([second, first]);
  app.recycle(second);
  expect(app.readCached(Item)).toBe(first);
  expect(app.countInstances(Item, { tag })).toBe(1);
});

it('factory diagnostics do not affect fast-path identity or repeatedly run ignored builders', () => {
  const owner = runtime().createBinding();
  const firstBuilder = vi.fn(() => new Item('first'));
  const secondBuilder = vi.fn(() => new Item('second'));
  const first = viewModelSpec(Item, firstBuilder, { key: 'shared' });
  const second = viewModelSpec(Item, secondBuilder, { key: 'shared' });
  const original = owner.read(first);
  expect(owner.watch(second)).toBe(original);
  expect(owner.read(second)).toBe(original);
  expect(firstBuilder).toHaveBeenCalledOnce();
  expect(secondBuilder).not.toHaveBeenCalled();
  expect(warnings).toHaveLength(1);
  owner.unbind(original);
  expect(owner.read(second)).toBe(original);
});

it('reset clears an empty root Binding pause state while retaining the Binding itself', () => {
  const app = runtime();
  const update = vi.fn();
  const owner = app.createBinding({ onUpdate: update });
  owner.pause();
  app.pause();
  ViewModel.reset();
  expect(owner.isDisposed).toBe(false);
  expect(owner.isPaused).toBe(false);
  expect(app.isPaused).toBe(false);
  const item = owner.watch(viewModelSpec(Item, () => new Item('after reset')));
  item.notifyListeners();
  expect(update).toHaveBeenCalledOnce();
});

it('an observer can recycle on bind without invoking the hook on a disposed generation', () => {
  const app = runtime();
  const bind = vi.fn();
  class Observed extends ViewModel {
    protected override onBind() {
      bind();
    }
  }
  ViewModel.addLifecycle({
    onBind: (item) => {
      app.recycle(item);
    },
  });
  expect(() => app.createBinding().read(viewModelSpec(Observed, () => new Observed()))).toThrow();
  expect(bind).not.toHaveBeenCalled();
  expect(app.countInstances()).toBe(0);
});
