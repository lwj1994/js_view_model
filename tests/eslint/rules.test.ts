import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

import plugin from '../../src/eslint/index.js';
import { fix, lint, reported } from './lint.js';

const core = `import { StateViewModel, ViewModel, ViewModelRuntime, ViewModelSpec, viewModelSpec } from '../../../src/core/index.js';
import { CounterViewModel, UserViewModel, counterSpec } from './shared.js';
`;

const reactNative = `import { useEffect, useRef } from 'react';
import {
  useReadViewModel,
  useViewModel,
  useViewModelBinding,
  useViewModelSelector,
} from '../../../src/react-native/index.js';
import { CounterViewModel, counterSpec } from './shared.js';
`;

describe('plugin', () => {
  it('recommends every warning except the opt-in cached lookup', () => {
    expect(plugin.configs.recommended.rules).toEqual({
      'view-model/dependency-cycle': 'warn',
      'view-model/cached-instance': 'warn',
      'view-model/alive-forever-key': 'warn',
      'view-model/unmanaged-construction': 'warn',
      'view-model/listen-in-render': 'warn',
      'view-model/instance-handoff': 'warn',
      'view-model/identity-collision': 'warn',
      'view-model/selector-with-watch': 'warn',
      'view-model/undisposed-binding': 'warn',
      'view-model/temporary-spec': 'warn',
    });
    expect(plugin.configs.recommended.plugins?.['view-model']).toBe(plugin);
    expect(Object.keys(plugin.rules)).toContain('cached-lookup');
  });

  it('requires type information', () => {
    const linter = new Linter({ configType: 'flat' });
    expect(() =>
      linter.verify(
        'const value = 1;',
        [{ plugins: { 'view-model': plugin }, rules: { 'view-model/temporary-spec': 'warn' } }],
        'plain.js',
      ),
    ).toThrow(/requires type information/);
  });
});

describe('dependency-cycle', () => {
  it('reports ViewModels that resolve each other', () => {
    const code = `${core}
class SessionViewModel extends ViewModel {
  get cart(): CartViewModel {
    return this.viewModelBinding.read(cartSpec);
  }
}
class CartViewModel extends ViewModel {
  get session(): SessionViewModel {
    return this.viewModelBinding.watch(sessionSpec);
  }
}
const sessionSpec = viewModelSpec(SessionViewModel, () => new SessionViewModel());
const cartSpec = viewModelSpec(CartViewModel, () => new CartViewModel());
`;
    expect(lint('dependency-cycle', code).map((message) => message.message)).toEqual([
      expect.stringContaining('SessionViewModel -> CartViewModel -> SessionViewModel'),
      expect.stringContaining('CartViewModel -> SessionViewModel -> CartViewModel'),
    ]);
  });

  it('follows listen registrations into other files', () => {
    const file = 'cycle-owner.ts';
    const code = readFileSync(resolve(import.meta.dirname, 'fixtures', file), 'utf8');
    expect(lint('dependency-cycle', code, { file }).map((message) => message.message)).toEqual([
      expect.stringContaining('DashboardViewModel -> ReportViewModel -> DashboardViewModel'),
    ]);
  });

  it('accepts one-way dependencies and inherited edges without a cycle', () => {
    const code = `${core}
class SessionViewModel extends ViewModel {
  userId: string | undefined;
}
class BaseCartViewModel extends ViewModel {
  get session(): SessionViewModel {
    return this.viewModelBinding.read(sessionSpec);
  }
}
class CartViewModel extends BaseCartViewModel {}
const sessionSpec = viewModelSpec(SessionViewModel, () => new SessionViewModel());
export const cartSpec = viewModelSpec(CartViewModel, () => new CartViewModel());
`;
    expect(lint('dependency-cycle', code)).toEqual([]);
  });
});

describe('cached-instance', () => {
  it('reports stored resolutions', () => {
    const code = `${core}
class CheckoutViewModel extends ViewModel {
  readonly counter = this.viewModelBinding.read(counterSpec);
  private last: CounterViewModel | undefined;

  remember(): void {
    this.last = this.viewModelBinding.watch(counterSpec);
  }
}
const binding = new ViewModelRuntime().createBinding();
export const shared = binding.read(counterSpec);
`;
    expect(reported('cached-instance', code)).toEqual([
      'this.viewModelBinding.read(counterSpec)',
      'this.viewModelBinding.watch(counterSpec)',
      'binding.read(counterSpec)',
    ]);
  });

  it('reports hook results kept in refs', () => {
    const code = `${reactNative}
export function CounterPage() {
  const ref = useRef<CounterViewModel | null>(null);
  ref.current = useViewModel(counterSpec);
  return null;
}
`;
    expect(reported('cached-instance', code, { extension: 'tsx' })).toEqual([
      'useViewModel(counterSpec)',
    ]);
  });

  it('accepts getters and locals', () => {
    const code = `${core}
class CheckoutViewModel extends ViewModel {
  get counter(): CounterViewModel {
    return this.viewModelBinding.read(counterSpec);
  }

  submit(): void {
    const counter = this.counter;
    counter.increment();
  }
}
`;
    expect(lint('cached-instance', code)).toEqual([]);
  });

  it('turns readonly and private fields into getters', () => {
    const code = `${core}
class CheckoutViewModel extends ViewModel {
  readonly counter = this.viewModelBinding.read(counterSpec);
  private readonly typed: CounterViewModel = this.viewModelBinding.watch(counterSpec);
  #hidden = this.viewModelBinding.read(counterSpec);
  public mutable = this.viewModelBinding.read(counterSpec);
}
`;
    expect(fix('cached-instance', code)).toBe(`${core}
class CheckoutViewModel extends ViewModel {
  get counter() {
    return this.viewModelBinding.read(counterSpec);
  }
  private get typed(): CounterViewModel {
    return this.viewModelBinding.watch(counterSpec);
  }
  get #hidden() {
    return this.viewModelBinding.read(counterSpec);
  }
  public mutable = this.viewModelBinding.read(counterSpec);
}
`);
  });
});

describe('alive-forever-key', () => {
  it('reports retained specs without a key', () => {
    const code = `${core}
class AuthViewModel extends ViewModel {}
export const authSpec = viewModelSpec(AuthViewModel, () => new AuthViewModel(), {
  aliveForever: true,
});
export const userCacheSpec = ViewModelSpec.arg(UserViewModel, (id: string) => new UserViewModel(id), {
  aliveForever: () => true,
});
export const nullKeySpec = viewModelSpec(AuthViewModel, () => new AuthViewModel(), {
  key: undefined,
  aliveForever: true,
});
export const keyed = viewModelSpec(AuthViewModel, () => new AuthViewModel(), {
  key: 'auth',
  aliveForever: true,
});
export const userSpec = ViewModelSpec.arg(UserViewModel, (id: string) => new UserViewModel(id), {
  key: (id) => id,
  aliveForever: () => true,
});
`;
    expect(lint('alive-forever-key', code).map((message) => message.line)).toEqual([5, 8, 11]);
  });

  it('adds a key named after the spec', () => {
    const code = `${core}
class AuthViewModel extends ViewModel {}
export const authSpec = viewModelSpec(AuthViewModel, () => new AuthViewModel(), {
  aliveForever: true,
});
export const sessionSpec = viewModelSpec(AuthViewModel, () => new AuthViewModel(), { aliveForever: true });
export const userCacheSpec = ViewModelSpec.arg(UserViewModel, (id: string) => new UserViewModel(id), {
  aliveForever: () => true,
});
export const nullKeySpec = viewModelSpec(AuthViewModel, () => new AuthViewModel(), {
  key: undefined,
  aliveForever: true,
});
`;
    expect(fix('alive-forever-key', code)).toBe(`${core}
class AuthViewModel extends ViewModel {}
export const authSpec = viewModelSpec(AuthViewModel, () => new AuthViewModel(), {
  key: 'auth',
  aliveForever: true,
});
export const sessionSpec = viewModelSpec(AuthViewModel, () => new AuthViewModel(), { key: 'session', aliveForever: true });
export const userCacheSpec = ViewModelSpec.arg(UserViewModel, (id: string) => new UserViewModel(id), {
  key: (arg) => arg,
  aliveForever: () => true,
});
export const nullKeySpec = viewModelSpec(AuthViewModel, () => new AuthViewModel(), {
  key: 'nullKey',
  aliveForever: true,
});
`);
  });
});

describe('unmanaged-construction', () => {
  it('reports ViewModels constructed outside a builder', () => {
    const code = `${core}
export function main(): void {
  const counter = new CounterViewModel();
  counter.increment();
}
class FakeCounterViewModel extends CounterViewModel {}
export const fakeSpec = viewModelSpec(CounterViewModel, () => {
  const make = () => new FakeCounterViewModel();
  return make();
});
export const restore = counterSpec.overrideWith(
  viewModelSpec(CounterViewModel, () => new FakeCounterViewModel()),
);
export const userSpec = ViewModelSpec.arg(UserViewModel, (id: string) => new UserViewModel(id));
`;
    expect(reported('unmanaged-construction', code)).toEqual(['new CounterViewModel()']);
  });
});

describe('listen-in-render', () => {
  it('reports listeners registered during render or getter access', () => {
    const code = `${reactNative}
export function CounterPage() {
  const binding = useViewModelBinding();
  binding.listen(counterSpec, () => {});
  useEffect(() => binding.listen(counterSpec, () => {}), [binding]);
  return null;
}
export function useCounterLog(): void {
  const counter = useReadViewModel(counterSpec);
  counter.listen(() => {});
}
`;
    expect(reported('listen-in-render', code, { extension: 'tsx' })).toEqual([
      'binding.listen(counterSpec, () => {})',
      'counter.listen(() => {})',
    ]);
  });

  it('reports getters and onUpdate, not onCreate', () => {
    const code = `${core}
class BadgeViewModel extends ViewModel {
  get counter(): CounterViewModel {
    this.viewModelBinding.listen(counterSpec, () => this.notifyListeners());
    return this.viewModelBinding.read(counterSpec);
  }

  protected override onCreate(): void {
    this.viewModelBinding.listenState(counterSpec, (previous, current) => {
      void previous;
      void current;
    });
  }
}
export function host(runtime: ViewModelRuntime): void {
  const binding = runtime.createBinding({
    onUpdate: () => {
      binding.listen(counterSpec, () => {});
    },
  });
  binding.dispose();
}
`;
    expect(lint('listen-in-render', code).map((message) => message.message)).toEqual([
      expect.stringContaining('every getter access'),
      expect.stringContaining('every onUpdate refresh request'),
    ]);
  });

  it('does not treat Vue composables as renders', () => {
    const code = `${core}
export function useCounterLog(binding: { listen: ViewModelRuntime['createBinding'] }): void {
  void binding;
}
export function useCounterListener(runtime: ViewModelRuntime): void {
  const binding = runtime.createBinding();
  binding.listen(counterSpec, () => {});
  binding.dispose();
}
`;
    expect(lint('listen-in-render', code)).toEqual([]);
  });
});

describe('instance-handoff', () => {
  it('reports ViewModels passed through constructors and props', () => {
    const code = `${reactNative}
import { ViewModel } from '../../../src/core/index.js';
class ReportViewModel extends ViewModel {
  constructor(readonly counter: CounterViewModel) {
    super();
  }
}
class Printer {
  constructor(counter?: CounterViewModel) {
    void counter;
  }
}
export function CounterLabel({ counter }: { counter: CounterViewModel }) {
  return counter.state.count;
}
export const CounterBadge = (props: { counter: CounterViewModel; label: string }) => props.label;
export function CountLabel({ count }: { count: number }) {
  return count;
}
void ReportViewModel;
void Printer;
`;
    expect(reported('instance-handoff', code, { extension: 'tsx' })).toEqual([
      'readonly counter: CounterViewModel',
      'counter?: CounterViewModel',
      'counter',
      'props: { counter: CounterViewModel; label: string }',
    ]);
  });

  it('reports ViewModel props declared with defineProps', () => {
    const code = `${core}
declare function defineProps<T>(): T;
export const props = defineProps<{ counter: CounterViewModel; title: string }>();
`;
    expect(reported('instance-handoff', code)).toEqual(['counter: CounterViewModel;']);
  });
});

describe('identity-collision', () => {
  it('reports unkeyed resolutions that share one instance', () => {
    const code = `${core}
class ItemViewModel extends ViewModel {
  constructor(readonly id: string) {
    super();
  }
}
const itemSpec = ViewModelSpec.arg(ItemViewModel, (id: string) => new ItemViewModel(id));
const firstCounterSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel());
const secondCounterSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel());
class PageViewModel extends ViewModel {
  get first(): CounterViewModel {
    return this.viewModelBinding.watch(firstCounterSpec);
  }
  get second(): CounterViewModel {
    return this.viewModelBinding.watch(secondCounterSpec);
  }
  items(ids: readonly string[]): ItemViewModel[] {
    return ids.map((id) => this.viewModelBinding.read(itemSpec(id)));
  }
  item(id: string): ItemViewModel {
    return this.viewModelBinding.read(itemSpec(id));
  }
}
export { PageViewModel };
`;
    expect(reported('identity-collision', code)).toEqual([
      'this.viewModelBinding.watch(secondCounterSpec)',
      'this.viewModelBinding.read(itemSpec(id))',
      'this.viewModelBinding.read(itemSpec(id))',
    ]);
  });

  it('reports different arguments to one unkeyed family through hooks', () => {
    const code = `${reactNative}
import { ViewModel, ViewModelSpec } from '../../../src/core/index.js';
class ItemViewModel extends ViewModel {
  constructor(readonly id: string) {
    super();
  }
}
const itemSpec = ViewModelSpec.arg(ItemViewModel, (id: string) => new ItemViewModel(id));
export function Items() {
  const a = useViewModel(itemSpec('a'));
  const b = useReadViewModel(itemSpec('b'));
  return [a.id, b.id];
}
export function Item({ id }: { id: string }) {
  return useViewModel(itemSpec(id)).id;
}
`;
    expect(reported('identity-collision', code, { extension: 'tsx' })).toEqual([
      "useReadViewModel(itemSpec('b'))",
    ]);
  });

  it('accepts keyed specs, builder-only specs and repeated resolutions', () => {
    const code = `${core}
class ItemViewModel extends ViewModel {
  constructor(readonly id: string) {
    super();
  }
}
const itemSpec = ViewModelSpec.arg(ItemViewModel, (id: string) => new ItemViewModel(id), {
  key: (id) => id,
});
const firstSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel(), { key: 'first' });
const secondSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel(), { key: 'second' });
const localSpec = viewModelSpec(() => new CounterViewModel());
class PageViewModel extends ViewModel {
  get first(): CounterViewModel {
    return this.viewModelBinding.watch(firstSpec);
  }
  get second(): CounterViewModel {
    return this.viewModelBinding.watch(secondSpec);
  }
  get local(): CounterViewModel {
    return this.viewModelBinding.read(localSpec);
  }
  get shared(): CounterViewModel {
    return this.viewModelBinding.read(counterSpec);
  }
  get sharedAgain(): CounterViewModel {
    return this.viewModelBinding.watch(counterSpec);
  }
  items(ids: readonly string[]): ItemViewModel[] {
    return ids.map((id) => this.viewModelBinding.read(itemSpec(id)));
  }
}
export { PageViewModel };
`;
    expect(lint('identity-collision', code)).toEqual([]);
  });
});

describe('selector-with-watch', () => {
  const code = `${reactNative}
export function Counter() {
  const counter = useViewModel(counterSpec);
  const count = useViewModelSelector(counterSpec, (vm) => vm.state.count);
  return [counter, count];
}
export function Plain() {
  return useViewModel(counterSpec).state.count;
}
`;

  it('reports useViewModel next to a selector for the same spec', () => {
    expect(reported('selector-with-watch', code, { extension: 'tsx' })).toEqual([
      'useViewModel(counterSpec)',
    ]);
  });

  it('resolves it with useReadViewModel', () => {
    const imports = `import { useEffect, useRef } from 'react';
import {
  useReadViewModel,
  useViewModel,`;
    const missing = code.replace(
      imports,
      `import { useEffect, useRef } from 'react';
import {
  useViewModel,`,
    );
    expect(fix('selector-with-watch', missing, { extension: 'tsx' })).toContain(
      `  useViewModelSelector, useReadViewModel,
} from '../../../src/react-native/index.js';`,
    );
    expect(fix('selector-with-watch', code, { extension: 'tsx' })).toContain(
      'const counter = useReadViewModel(counterSpec);',
    );
  });
});

describe('undisposed-binding', () => {
  it('reports owners that are never disposed', () => {
    const code = `${core}
const appRuntime = new ViewModelRuntime();
export const appBinding = appRuntime.createBinding();
export function leak(): void {
  const binding = appRuntime.createBinding();
  binding.read(counterSpec).increment();
}
export function temporary(): void {
  appRuntime.createBinding().read(counterSpec).increment();
}
export function runtimeLeak(): number {
  const runtime = new ViewModelRuntime();
  return runtime.countInstances();
}
class Host {
  private readonly binding = appRuntime.createBinding();

  read(): CounterViewModel {
    return this.binding.read(counterSpec);
  }
}
void Host;
`;
    expect(lint('undisposed-binding', code).map((message) => message.line)).toEqual([
      7, 11, 14, 18,
    ]);
  });

  it('accepts disposed, handed-over and runtime-owned bindings', () => {
    const code = `${core}
declare function beforeEach(callback: () => void): void;
declare function afterEach(callback: () => void): void;
declare function keep(value: unknown): void;
const appRuntime = new ViewModelRuntime();
let binding: ReturnType<ViewModelRuntime['createBinding']>;
beforeEach(() => {
  binding = appRuntime.createBinding();
});
afterEach(() => binding.dispose());
export function scoped(): void {
  const local = appRuntime.createBinding();
  try {
    local.read(counterSpec);
  } finally {
    local.dispose();
  }
}
export function handedOver(): void {
  keep(appRuntime.createBinding());
  const owner = appRuntime.createBinding();
  keep({ owner });
}
export function returned() {
  return appRuntime.createBinding();
}
export function runtimeOwned(): void {
  const runtime = new ViewModelRuntime();
  const child = runtime.createBinding();
  child.read(counterSpec);
  runtime.dispose();
}
export async function overridden(): Promise<void> {
  await counterSpec.runWithOverride(counterSpec, async (runtime) => {
    const scopedBinding = runtime.createBinding();
    scopedBinding.read(counterSpec);
  });
}
class Host {
  private readonly binding = appRuntime.createBinding();
  private static readonly shared = appRuntime.createBinding();

  dispose(): void {
    this.binding.dispose();
  }
}
void Host;
`;
    expect(lint('undisposed-binding', code)).toEqual([]);
  });
});

describe('temporary-spec', () => {
  it('reports specs that are not module-level or static', () => {
    const code = `${core}
export function userSpecFor(userId: string) {
  return viewModelSpec(UserViewModel, () => new UserViewModel(userId), { key: userId });
}
export class PageHost {
  private readonly pageSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel());
  static readonly stable = viewModelSpec(CounterViewModel, () => new CounterViewModel());

  read(runtime: ViewModelRuntime): void {
    const local = viewModelSpec(CounterViewModel, () => new CounterViewModel());
    const binding = runtime.createBinding();
    binding.read(viewModelSpec(CounterViewModel, () => new CounterViewModel()));
    binding.read(local);
    binding.read(this.pageSpec);
    binding.dispose();
  }
}
`;
    expect(lint('temporary-spec', code).map((message) => message.line)).toEqual([5, 8, 12, 14]);
  });

  it('accepts module-level, generic, and override replacement specs', () => {
    const code = `${core}
class Box<T> extends ViewModel {
  value: T | undefined;
}
export function boxSpec<T>() {
  return viewModelSpec(Box<T>, () => new Box<T>());
}
export const arrowBoxSpec = <T,>() => viewModelSpec(Box<T>, () => new Box<T>());
class FakeCounterViewModel extends CounterViewModel {}
export const restore = counterSpec.overrideWith(
  viewModelSpec(CounterViewModel, () => new FakeCounterViewModel()),
);
export const userSpec = ViewModelSpec.arg(UserViewModel, (id: string) => new UserViewModel(id));
export async function override(): Promise<void> {
  await ViewModelRuntime.runWithOverrides(
    [[counterSpec, viewModelSpec(CounterViewModel, () => new FakeCounterViewModel())]],
    async () => {},
  );
}
export const isolated = new ViewModelRuntime({
  overrides: [[counterSpec, viewModelSpec(CounterViewModel, () => new FakeCounterViewModel())]],
});
`;
    expect(lint('temporary-spec', code)).toEqual([]);
  });

  it('makes private fields static and extracts specs that capture nothing', () => {
    const code = `${core}
export class PageHost {
  private readonly pageSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel());

  read(runtime: ViewModelRuntime): void {
    const binding = runtime.createBinding();
    binding.read(this.pageSpec);
    // Inline specs are rebuilt on every call.
    binding.read(viewModelSpec(CounterViewModel, () => new CounterViewModel()));
    binding.dispose();
  }
}
`;
    expect(fix('temporary-spec', code)).toBe(`${core}
const counterViewModelSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel());

export class PageHost {
  private static readonly pageSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel());

  read(runtime: ViewModelRuntime): void {
    const binding = runtime.createBinding();
    binding.read(PageHost.pageSpec);
    // Inline specs are rebuilt on every call.
    binding.read(counterViewModelSpec);
    binding.dispose();
  }
}
`);
  });

  it('does not extract specs that capture local values', () => {
    const code = `${core}
export function userSpecFor(userId: string) {
  return viewModelSpec(UserViewModel, () => new UserViewModel(userId), { key: userId });
}
`;
    expect(fix('temporary-spec', code)).toBe(code);
  });
});

describe('cached-lookup', () => {
  it('reports cached queries on bindings and runtimes', () => {
    const code = `${core}
export function lookup(runtime: ViewModelRuntime): void {
  const binding = runtime.createBinding();
  binding.watchCached(CounterViewModel, { key: 'shared-counter' });
  binding.maybeReadCached(CounterViewModel);
  binding.readCachesByTag(CounterViewModel, 'counters');
  runtime.readCached(CounterViewModel, { key: 'shared-counter' });
  binding.read(counterSpec);
  binding.dispose();
}
`;
    expect(lint('cached-lookup', code).map((message) => message.line)).toEqual([6, 7, 8, 9]);
  });
});
