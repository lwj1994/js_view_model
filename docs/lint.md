# ESLint rules

[简体中文](./zh/lint.md) · [Documentation index](./README.md)

`@lwjlol/view_model/eslint` is an optional, type-aware ESLint plugin that checks
ViewModel ownership, specs, and dependency composition. It mirrors the Flutter
`view_model_lint` analyzer plugin. ESLint loads it in the lint process only, so it
adds nothing to an application bundle. Enable it in every application or
business package that uses `view_model`.

## Enable the plugin

The rules need typescript-eslint type information. Install the tooling next to
the package:

```sh
npm install --save-dev eslint @typescript-eslint/parser typescript
```

Then add the recommended config to `eslint.config.mjs`, preserving your existing
configuration:

```js
import tsParser from '@typescript-eslint/parser';
import viewModel from '@lwjlol/view_model/eslint';

export default [
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  viewModel.configs.recommended,
];
```

The recommended config applies to `**/*.{ts,tsx,mts,cts}`. To lint other files
that have type information, such as Vue single-file components, spread it with
your own `files`. A CommonJS config uses `require('@lwjlol/view_model/eslint')`,
which returns the same plugin. ESLint 9 or newer, `@typescript-eslint/parser` 8 or newer, and
TypeScript 5 or newer are required. A file linted without type information makes
every rule throw with a configuration hint.

Run the check from the package root, and use the same command in CI:

```sh
npx eslint . --max-warnings 0
```

Ten rules are enabled as warnings. `view-model/cached-lookup` is opt-in.

## Rules

| Rule                                                | Default | Fix | Catches                                                 |
| --------------------------------------------------- | ------- | --- | ------------------------------------------------------- |
| [`dependency-cycle`](#dependency-cycle)             | warn    |     | ViewModels that resolve each other                      |
| [`cached-instance`](#cached-instance)               | warn    | ✓   | A resolved ViewModel kept in a field or module variable |
| [`alive-forever-key`](#alive-forever-key)           | warn    | ✓   | `aliveForever` without a key                            |
| [`unmanaged-construction`](#unmanaged-construction) | warn    |     | A ViewModel constructed outside a spec builder          |
| [`listen-in-render`](#listen-in-render)             | warn    |     | A listener registered on every render or getter access  |
| [`instance-handoff`](#instance-handoff)             | warn    |     | A ViewModel passed through a constructor or props       |
| [`identity-collision`](#identity-collision)         | warn    |     | Unkeyed resolutions that share one instance             |
| [`selector-with-watch`](#selector-with-watch)       | warn    | IDE | `useViewModel` next to a selector for the same spec     |
| [`undisposed-binding`](#undisposed-binding)         | warn    |     | A created Binding or Runtime that is never disposed     |
| [`temporary-spec`](#temporary-spec)                 | warn    | ✓   | A spec that is not a module-level or static variable    |
| [`cached-lookup`](#cached-lookup)                   | off     |     | A cached query used instead of a spec                   |

Every rule ID is prefixed with `view-model/`. Fixes marked ✓ appear as IDE quick
fixes and are applied in bulk by `npx eslint . --fix`. Each one edits only what it
can prove; a diagnostic without a safe edit has no fix. `selector-with-watch`
offers an IDE suggestion only, because whether the component still needs every
update is the author's decision.

## Shared declarations

The examples below use these declarations:

```tsx
import {
  StateViewModel,
  ViewModel,
  ViewModelBinding,
  ViewModelRuntime,
  ViewModelSpec,
  viewModelSpec,
} from '@lwjlol/view_model/core';
import {
  useReadViewModel,
  useViewModel,
  useViewModelBinding,
  useViewModelSelector,
} from '@lwjlol/view_model/react-native';
import { useEffect } from 'react';

type CounterState = Readonly<{ count: number }>;

class CounterViewModel extends StateViewModel<CounterState> {
  public constructor() {
    super({ count: 0 });
  }

  public increment(): void {
    this.setState({ count: this.state.count + 1 });
  }
}

class UserViewModel extends ViewModel {
  public constructor(public readonly userId: string) {
    super();
  }
}

const counterSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel());

const userSpec = ViewModelSpec.arg(UserViewModel, (userId: string) => new UserViewModel(userId), {
  key: (userId) => userId,
});
```

## `dependency-cycle`

Two or more ViewModels resolve each other through their own `viewModelBinding`.
Resolving any of them recurses until the runtime cycle check throws.

**Bad**

```tsx
class SessionViewModel extends ViewModel {
  public get cart(): CartViewModel {
    return this.viewModelBinding.read(cartSpec);
  }
}

class CartViewModel extends ViewModel {
  public get session(): SessionViewModel {
    return this.viewModelBinding.read(sessionSpec);
  }
}

const sessionSpec = viewModelSpec(SessionViewModel, () => new SessionViewModel());
const cartSpec = viewModelSpec(CartViewModel, () => new CartViewModel());
```

**Good**

Keep dependencies pointing one way. Move state that both sides need into the
lower-level module.

```tsx
class SessionViewModel extends ViewModel {
  public userId: string | undefined;
}

class CartViewModel extends ViewModel {
  public get session(): SessionViewModel {
    return this.viewModelBinding.read(sessionSpec);
  }
}

const sessionSpec = viewModelSpec(SessionViewModel, () => new SessionViewModel());
const cartSpec = viewModelSpec(CartViewModel, () => new CartViewModel());
```

The rule compares types. It follows `read`, `watch`, `listen`, `listenState`, and
`listenStateSelect` on `this.viewModelBinding`, including inherited members, in
every source file of the TypeScript program; declaration files of other packages
have no bodies to follow. If keys make the instances distinct on purpose,
suppress the warning with a reason. Runtime cycle validation still applies.

## `cached-instance`

The result of `read`, `watch`, a resolving hook, or a single cached query is
stored in a field, a module-level variable, or an assigned property such as a
React ref. After `recycle` or disposal, it still points at the old, disposed
generation.

Fix: a `readonly` or private field that is never reassigned becomes a getter. A
module-level variable has no automatic fix. In tests, expose the instance through
a getter or helper instead of a `let` assigned in `beforeEach`.

**Bad**

```tsx
class CheckoutViewModel extends ViewModel {
  public readonly counter = this.viewModelBinding.read(counterSpec);
}

const appRuntime = new ViewModelRuntime();
const appBinding = appRuntime.createBinding({ id: 'application' });
export const appCounter = appBinding.read(counterSpec);
```

**Good**

Resolve in a getter on every access. A local variable inside one call is fine.

```tsx
class CheckoutViewModel extends ViewModel {
  public get counter(): CounterViewModel {
    return this.viewModelBinding.read(counterSpec);
  }

  public submit(): void {
    const counter = this.counter;
    counter.increment();
  }
}

const appRuntime = new ViewModelRuntime();
const appBinding = appRuntime.createBinding({ id: 'application' });
export function appCounter(): CounterViewModel {
  return appBinding.read(counterSpec);
}
```

## `alive-forever-key`

`aliveForever: true` keeps an instance after its last owner leaves. Without a
key, nothing can find that instance again, and the runtime rejects it.

Fix: adds `key: 'auth'` for `authSpec`, named after the spec variable, or
`key: (arg) => arg` for a single-argument family whose argument is always a valid
key. A spec with no variable name, or a family with several or nullable
arguments, needs a key chosen by the application, so it has no automatic fix.

**Bad**

```tsx
class AuthViewModel extends ViewModel {}

const authSpec = viewModelSpec(AuthViewModel, () => new AuthViewModel(), {
  aliveForever: true,
});

const userCacheSpec = ViewModelSpec.arg(
  UserViewModel,
  (userId: string) => new UserViewModel(userId),
  { aliveForever: () => true },
);
```

**Good**

```tsx
class AuthViewModel extends ViewModel {}

const authSpec = viewModelSpec(AuthViewModel, () => new AuthViewModel(), {
  key: 'auth',
  aliveForever: true,
});

const userCacheSpec = ViewModelSpec.arg(
  UserViewModel,
  (userId: string) => new UserViewModel(userId),
  { key: (userId) => userId, aliveForever: () => true },
);
```

To share one instance between owners, a key alone is usually enough. The
instance is disposed after the last owner leaves, so `aliveForever` is not needed.

## `unmanaged-construction`

A ViewModel is constructed outside a spec builder. No Binding owns it, so it
never receives lifecycle callbacks or automatic disposal.

**Bad**

```tsx
export function main(): void {
  const counter = new CounterViewModel();
  counter.increment();
}
```

**Good**

```tsx
export function main(): void {
  const runtime = new ViewModelRuntime();
  const binding = runtime.createBinding();
  binding.read(counterSpec).increment();
  binding.dispose();
  runtime.dispose();
}
```

Construct the ViewModel in a function passed directly to `viewModelSpec`,
`new ViewModelSpec`, or `ViewModelSpec.arg`–`arg4`, as `counterSpec` does. This
also applies to tests and override replacements.

## `listen-in-render`

`listen`, `listenState`, `listenStateSelect`, or a ViewModel's own `subscribe`,
`listenState`, or `addListener` runs directly in a function component, a React
hook, a class component's `render`, a getter, or a Binding's `onUpdate`. Listeners
are not deduplicated, so every render or access adds another one.

**Bad**

```tsx
export function CounterLogger() {
  const binding = useViewModelBinding();
  binding.listenState(counterSpec, (previous, current) => {
    console.log(previous.count, current.count);
  });
  return null;
}

class BadgeViewModel extends ViewModel {
  public get counter(): CounterViewModel {
    this.viewModelBinding.listen(counterSpec, () => this.notifyListeners());
    return this.viewModelBinding.read(counterSpec);
  }
}
```

**Good**

Register once: in `onCreate` for a ViewModel, or in an effect that returns the
disposer for a component.

```tsx
export function CounterLogger() {
  const binding = useViewModelBinding();
  useEffect(
    () =>
      binding.listenState(counterSpec, (previous, current) => {
        console.log(previous.count, current.count);
      }),
    [binding],
  );
  return null;
}

class BadgeViewModel extends ViewModel {
  protected override onCreate(): void {
    this.viewModelBinding.listen(counterSpec, () => this.notifyListeners());
  }

  public get counter(): CounterViewModel {
    return this.viewModelBinding.read(counterSpec);
  }
}
```

A component is a function with a PascalCase name, including one wrapped in
`memo` or `forwardRef`. A `use*` function is a hook only in a file that imports
React or a React platform entry; Vue composables run once per setup and are not
reported. A listener registered in a callback such as `onPress` is not reported,
but it still adds a listener each time the callback runs.

## `instance-handoff`

A constructor parameter or a component prop has a ViewModel type, so a resolved
instance moves to an owner that never bound it. The receiver can keep a disposed
or recycled generation alive. Vue `defineProps<T>()` type arguments are checked
the same way.

**Bad**

```tsx
export function CounterLabel({ counter }: { counter: CounterViewModel }) {
  return <>{counter.state.count}</>;
}

class ReportViewModel extends ViewModel {
  public constructor(private readonly counter: CounterViewModel) {
    super();
  }
}
```

**Good**

Pass plain data, or let the receiver resolve the same spec through its own
Binding.

```tsx
export function CounterLabel({ count }: { count: number }) {
  return <>{count}</>;
}

export function CounterBadge() {
  const count = useViewModelSelector(counterSpec, (counter) => counter.state.count);
  return <>{count}</>;
}

class ReportViewModel extends ViewModel {
  private get counter(): CounterViewModel {
    return this.viewModelBinding.read(counterSpec);
  }
}
```

## `identity-collision`

Instance identity is the explicit ViewModel type plus the key. Within one
Binding, every unkeyed resolution of a type returns the first instance created.
Two different explicit-type specs, or one argument family called with different
arguments, silently share that instance.

**Bad**

```tsx
class ItemViewModel extends ViewModel {
  public constructor(public readonly id: string) {
    super();
  }
}

const itemSpec = ViewModelSpec.arg(ItemViewModel, (id: string) => new ItemViewModel(id));
const firstCounterSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel());
const secondCounterSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel());

export function Dashboard() {
  const first = useViewModel(firstCounterSpec);
  const second = useViewModel(secondCounterSpec);
  const a = useReadViewModel(itemSpec('a'));
  const b = useReadViewModel(itemSpec('b'));
  return <>{[first.state.count, second.state.count, a.id, b.id].join(' ')}</>;
}
```

`second` is the same object as `first`, and `b.id` is `'a'`.

**Good**

Give each instance a key. For an argument family, derive the key from the
arguments.

```tsx
class ItemViewModel extends ViewModel {
  public constructor(public readonly id: string) {
    super();
  }
}

const itemSpec = ViewModelSpec.arg(ItemViewModel, (id: string) => new ItemViewModel(id), {
  key: (id) => id,
});
const firstCounterSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel(), {
  key: 'first-counter',
});
const secondCounterSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel(), {
  key: 'second-counter',
});

export function Dashboard() {
  const first = useViewModel(firstCounterSpec);
  const second = useViewModel(secondCounterSpec);
  const a = useReadViewModel(itemSpec('a'));
  const b = useReadViewModel(itemSpec('b'));
  return <>{[first.state.count, second.state.count, a.id, b.id].join(' ')}</>;
}
```

A Binding is a ViewModel's own `viewModelBinding`, the hooks of one component,
or one variable or field holding a Binding. Arguments that vary inside a loop, a
callback, or a method parameter collide with themselves. Parameters of a
component, hook, Vue `setup`, or composable are treated like Flutter's `build`
context and are not reported, so `useViewModel(userSpec(userId))` from props
passes. Every component under one `ViewModelScope` shares its Binding, though, so
siblings that resolve an unkeyed family with different props, or one component
whose prop changes, still get the first instance. Give the family a key when
instances must differ. Builder-only specs have a private identity and never
collide.

## `selector-with-watch`

`useViewModelSelector` updates only when the selected value changes. If the same
React component also resolves that spec with `useViewModel`, every notification
rerenders the component anyway, which defeats the selector. Vue tracks reads per
effect, so Vue files are not reported.

Suggestion: `useViewModel` becomes `useReadViewModel`, which is imported when
needed. Apply it only when the component renders nothing from the ViewModel
except through selectors.

**Bad**

```tsx
export function useCounterTitle(): [string, () => void] {
  const counter = useViewModel(counterSpec);
  const count = useViewModelSelector(counterSpec, (vm) => vm.state.count);
  return [`Count ${count}`, () => counter.increment()];
}
```

**Good**

```tsx
export function useCounterTitle(): [string, () => void] {
  const counter = useReadViewModel(counterSpec);
  const count = useViewModelSelector(counterSpec, (vm) => vm.state.count);
  return [`Count ${count}`, () => counter.increment()];
}
```

## `undisposed-binding`

A `ViewModelBinding` keeps every ViewModel it resolved bound until `dispose()`
runs, and a `ViewModelRuntime` keeps every generation it created. A created
Binding or Runtime that is a temporary, or is held by a local variable or
instance field that is never disposed and never handed to another owner, leaks
those instances. In tests they also leak into later tests.

**Bad**

```tsx
const appRuntime = new ViewModelRuntime();

export function incrementOnce(): void {
  const binding = appRuntime.createBinding();
  binding.read(counterSpec).increment();
}

export function countOnce(): number {
  return new ViewModelRuntime().createBinding().read(counterSpec).state.count;
}
```

**Good**

```tsx
import { afterEach, beforeEach } from 'vitest';

const appRuntime = new ViewModelRuntime();
// A module-level owner lives as long as the application.
export const appBinding = appRuntime.createBinding({ id: 'application' });

export function incrementOnce(): void {
  const binding = appRuntime.createBinding();
  try {
    binding.read(counterSpec).increment();
  } finally {
    binding.dispose();
  }
}

let testRuntime: ViewModelRuntime;
beforeEach(() => {
  testRuntime = new ViewModelRuntime();
});
afterEach(() => testRuntime.dispose());
```

A module-level declaration or a static field is an application-lifetime owner
and is not reported. Disposing a Runtime, when that call is visible in the same
file, disposes the Bindings it created, and the Runtime that `runWithOverride`
supplies is disposed for you. A Binding passed
to another call, returned, or stored on another object counts as handed over.
If a wrapper method such as `close()` disposes it, suppress the warning with a
reason.

## `temporary-spec`

A spec must be created once: during module evaluation, as in a module-level
variable, object, array, or default export, or in a static initializer. A spec in
a local variable, an instance field, a function result, or inline at a call is
rebuilt on every evaluation. In React, an inline spec is a new object on every
render; a builder-only one is even a new identity. An override can no longer
replace it either. Specs created inside test callbacks such as `describe`, `it`,
`test`, or `beforeEach` are not reported, matching the
[testing guide](./testing.md)'s per-test Specs.

Fixes: a private instance field becomes `static` and `this.spec` becomes
`ClassName.spec`, when every use is such an access and everything the spec reads
is declared before the class; a spec that captures nothing from its scope moves to
a module-level `const` declared before its statement.

**Bad**

```tsx
export function userSpecFor(userId: string) {
  return viewModelSpec(UserViewModel, () => new UserViewModel(userId), { key: userId });
}

export function Counter() {
  const counter = useViewModel(viewModelSpec(CounterViewModel, () => new CounterViewModel()));
  return <>{counter.state.count}</>;
}

class CounterHost {
  private readonly spec = viewModelSpec(CounterViewModel, () => new CounterViewModel());
}
```

**Good**

```tsx
class Box<T> extends ViewModel {
  public value: T | undefined;
}

// A generic function that only returns the spec stands in for a generic variable.
export function boxSpec<T>() {
  return viewModelSpec(Box<T>, () => new Box<T>());
}

class FakeCounterViewModel extends CounterViewModel {}

export function installFakeCounter(): () => void {
  // A replacement passed straight to an override API is reached through counterSpec.
  return counterSpec.overrideWith(
    viewModelSpec(CounterViewModel, () => new FakeCounterViewModel()),
  );
}

export function User({ userId }: { userId: string }) {
  return <>{useViewModel(userSpec(userId)).userId}</>;
}
```

Calling an argument family, as in `userSpec(userId)`, is the intended use and is
not reported. Replacements passed to `overrideWith`, `setProxy`,
`runWithOverride`, `ViewModelRuntime.runWithOverrides`, or a Runtime's
`overrides` option are accepted.

## `cached-lookup`

Opt-in. A cached query such as `readCached`, `watchCached`, `maybeReadCached`,
or `readCachesByTag`, on a Binding or a Runtime, only finds an instance that
another owner already created. The result depends on creation order, and a miss
throws or returns `undefined`. Enable it next to the recommended config:

```js
export default [
  // ...the configuration above
  { files: ['**/*.{ts,tsx}'], rules: { 'view-model/cached-lookup': 'warn' } },
];
```

**Bad**

```tsx
export function sharedCounter(binding: ViewModelBinding): CounterViewModel {
  return binding.watchCached(CounterViewModel, { key: 'shared-counter' });
}
```

**Good**

Share through a keyed spec. Every owner that resolves it gets the same instance,
and whichever comes first creates it.

```tsx
const sharedCounterSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel(), {
  key: 'shared-counter',
});

export function sharedCounter(binding: ViewModelBinding): CounterViewModel {
  return binding.watch(sharedCounterSpec);
}
```

## Suppressing a diagnostic

Fix the ownership or spec problem first. For an intentional exception, add a
local directive with the reason:

```ts
// eslint-disable-next-line view-model/cached-instance -- kept for the application lifetime
```

To turn a rule off for a whole package, set it to `'off'` after the recommended
config.

## Flutter counterparts

| ESLint rule                         | Flutter `view_model_lint`           | JavaScript difference                                                 |
| ----------------------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| `view-model/dependency-cycle`       | `view_model_dependency_cycle`       | Also follows own-Binding `listen*`, which resolves and owns the child |
| `view-model/cached-instance`        | `view_model_cached_instance`        | Includes resolving hooks and assigned properties such as React refs   |
| `view-model/alive-forever-key`      | `view_model_alive_forever_key`      | Fix only for a named spec or a key-typed single argument              |
| `view-model/unmanaged-construction` | `view_model_unmanaged_construction` | Builders are inline functions passed to a spec construction           |
| `view-model/listen-in-render`       | `view_model_listen_in_build`        | Render means function components, React hooks, and class `render`     |
| `view-model/instance-handoff`       | `view_model_instance_handoff`       | Also component props and Vue `defineProps<T>()`                       |
| `view-model/identity-collision`     | `view_model_identity_collision`     | Builder-only specs never collide; Vue `setup` counts as `build`       |
| `view-model/selector-with-watch`    | `view_model_selector_with_watch`    | React hooks only; the edit is an IDE suggestion, not `--fix`          |
| `view-model/undisposed-binding`     | `view_model_undisposed_binding`     | Also `ViewModelRuntime`; Runtime disposal covers its Bindings         |
| `view-model/temporary-spec`         | `view_model_temporary_spec`         | Module evaluation and test callbacks count as creating a spec once    |
| `view-model/cached-lookup`          | `view_model_cached_lookup`          | Also Runtime cached queries                                           |

Flutter needs a separate `view_model_lint:fix` command because `dart fix` cannot
apply plugin fixes; ESLint applies the three autofixes with `--fix`.
