# ESLint 规则

[English](../lint.md) · [文档索引](./README.md)

`@lwjlol/view_model/eslint` 是一个可选的类型感知 ESLint 插件，检查 ViewModel
的所有权、Spec 与依赖组合，对应 Flutter 的 `view_model_lint` analyzer 插件。它只在
ESLint 进程中加载，不会进入应用 bundle。建议在每个使用 `view_model` 的应用或业务
package 中启用。

## 启用插件

规则需要 typescript-eslint 的类型信息。在项目中安装相应工具：

```sh
npm install --save-dev eslint @typescript-eslint/parser typescript
```

然后在 `eslint.config.mjs` 中加入推荐配置，保留已有配置：

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
  { files: ['**/*.{ts,tsx}'], ...viewModel.configs.recommended },
];
```

CommonJS 配置使用 `require('@lwjlol/view_model/eslint')`，返回同一个插件。需要
ESLint 9 及以上、`@typescript-eslint/parser` 8 及以上、TypeScript 5 及以上。在没有
类型信息的文件上运行时，每条规则都会抛出带配置提示的错误。

在 package 根目录运行检查，CI 中使用同一命令：

```sh
npx eslint . --max-warnings 0
```

十条规则默认以 warning 启用，`view-model/cached-lookup` 需要手动开启。

## 规则

| 规则                                                | 默认 | 修复 | 检查内容                                      |
| --------------------------------------------------- | ---- | ---- | --------------------------------------------- |
| [`dependency-cycle`](#dependency-cycle)             | warn |      | ViewModel 互相解析                            |
| [`cached-instance`](#cached-instance)               | warn | ✓    | 已解析的 ViewModel 存进字段或模块级变量       |
| [`alive-forever-key`](#alive-forever-key)           | warn | ✓    | `aliveForever` 没有 key                       |
| [`unmanaged-construction`](#unmanaged-construction) | warn |      | 在 Spec builder 之外构造 ViewModel            |
| [`listen-in-render`](#listen-in-render)             | warn |      | 每次 render 或 getter 访问都注册一次监听      |
| [`instance-handoff`](#instance-handoff)             | warn |      | 通过构造函数或 props 传递 ViewModel           |
| [`identity-collision`](#identity-collision)         | warn |      | 不带 key 的多次解析共享同一个实例             |
| [`selector-with-watch`](#selector-with-watch)       | warn | ✓    | 同一 Spec 同时使用 `useViewModel` 与 selector |
| [`undisposed-binding`](#undisposed-binding)         | warn |      | 创建的 Binding 或 Runtime 从未 dispose        |
| [`temporary-spec`](#temporary-spec)                 | warn | ✓    | Spec 不是模块级或 static 变量                 |
| [`cached-lookup`](#cached-lookup)                   | off  |      | 用缓存查询代替 Spec                           |

所有规则 ID 都带 `view-model/` 前缀。修复会作为 IDE 快速修复出现，
`npx eslint . --fix` 会批量应用。每个修复只改动能确定安全的内容；没有安全改法的
诊断不提供修复。

## 共享声明

下面的示例使用这些声明：

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

两个或多个 ViewModel 通过各自的 `viewModelBinding` 互相解析。解析其中任何一个都会
递归，直到运行时环检测抛错。

**错误示例**

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

**正确示例**

保持依赖单向。把双方都需要的状态下沉到更底层的模块。

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

规则按类型比较。它跟踪 TypeScript program 中所有源文件里、通过
`this.viewModelBinding` 调用的 `read`、`watch`、`listen`、`listenState` 与
`listenStateSelect`，包括继承来的成员；其他 package 的声明文件没有函数体可跟踪。
如果 key 有意让实例互不相同，请带上原因抑制该警告。运行时环检测仍然生效。

## `cached-instance`

`read`、`watch`、解析类 hook 或单结果缓存查询的结果被存进字段、模块级变量，或
赋给某个属性（例如 React ref）。`recycle` 或 dispose 之后，它仍指向已经销毁的旧
generation。

修复：`readonly` 字段，或从未被重新赋值的 private 字段，改为 getter。模块级变量没有
自动修复。

**错误示例**

```tsx
class CheckoutViewModel extends ViewModel {
  public readonly counter = this.viewModelBinding.read(counterSpec);
}

const appRuntime = new ViewModelRuntime();
const appBinding = appRuntime.createBinding({ id: 'application' });
export const appCounter = appBinding.read(counterSpec);
```

**正确示例**

每次访问都在 getter 中解析。在一次调用内使用局部变量没有问题。

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

`aliveForever: true` 会在最后一个 owner 离开后继续保留实例。没有 key 就再也找不到
这个实例，运行时也会拒绝它。

修复：为 `authSpec` 加上 `key: 'auth'`，为单参数 family 加上 `key: (arg) => arg`。
多参数 family 的组合 key 需要由应用决定，因此不提供自动修复。

**错误示例**

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

**正确示例**

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

如果只是要在多个 owner 之间共享一个实例，通常一个 key 就够了。最后一个 owner 离开
后实例会被 dispose，不需要 `aliveForever`。

## `unmanaged-construction`

ViewModel 在 Spec builder 之外被构造。没有 Binding 持有它，因此它永远不会收到生命
周期回调，也不会被自动 dispose。

**错误示例**

```tsx
export function main(): void {
  const counter = new CounterViewModel();
  counter.increment();
}
```

**正确示例**

```tsx
export function main(): void {
  const runtime = new ViewModelRuntime();
  const binding = runtime.createBinding();
  binding.read(counterSpec).increment();
  binding.dispose();
  runtime.dispose();
}
```

像 `counterSpec` 那样，在直接传给 `viewModelSpec`、`new ViewModelSpec` 或
`ViewModelSpec.arg`–`arg4` 的函数中构造 ViewModel。测试与 override 替换也一样。

## `listen-in-render`

`listen`、`listenState`、`listenStateSelect`，或 ViewModel 自身的 `subscribe`、
`listenState`、`addListener`，直接在函数组件、React hook、class 组件的 `render`、
getter 或 Binding 的 `onUpdate` 中执行。监听不会去重，每次 render 或访问都会再加
一个。

**错误示例**

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

**正确示例**

只注册一次：ViewModel 在 `onCreate` 中注册，组件在返回 disposer 的 effect 中注册。

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

组件是 PascalCase 命名的函数，包括被 `memo` 或 `forwardRef` 包裹的函数。只有在导入
了 React 或 React 平台入口的文件中，`use*` 函数才被视为 hook；Vue composable 每次
setup 只运行一次，不会被报告。在 `onPress` 等回调中注册的监听不会被报告，但每次回调
执行仍会增加一个监听。

## `instance-handoff`

构造函数参数或组件 prop 的类型是 ViewModel，已解析的实例因此被交给一个从未绑定它的
owner。接收方可能让已 dispose 或已 recycle 的 generation 继续存活。Vue
`defineProps<T>()` 的类型参数也按同样方式检查。

**错误示例**

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

**正确示例**

传递普通数据，或者让接收方通过自己的 Binding 解析同一个 Spec。

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

实例身份由显式 ViewModel 类型加 key 决定。在同一个 Binding 中，某个类型所有不带 key
的解析都返回最先创建的实例。两个不同的显式类型 Spec，或者同一个参数 family 用不同
参数调用，会静默共享这个实例。

**错误示例**

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

`second` 与 `first` 是同一个对象，`b.id` 是 `'a'`。

**正确示例**

给每个实例一个 key。参数 family 从参数推导 key。

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

一个 Binding 指 ViewModel 自身的 `viewModelBinding`、同一个组件中的 hook，或持有
Binding 的同一个变量或字段。在循环、回调或方法参数中变化的参数，会与自身冲突。组件
props 与 Flutter `build` 的 context 一样视为在同一 owner 内固定，因此来自 props 的
`useViewModel(userSpec(userId))` 不会被报告；但如果该 prop 之后改变，不带 key 的
family 仍会保留第一个实例。仅传 builder 的 Spec 拥有私有身份，永远不会冲突。

## `selector-with-watch`

`useViewModelSelector` 只在选中的值变化时更新。如果同一个组件还用 `useViewModel`
解析同一个 Spec，每次通知都会让组件更新，selector 也就失去了作用。

修复：把 `useViewModel` 改为 `useReadViewModel`，需要时自动补上导入。

**错误示例**

```tsx
export function useCounterTitle(): [string, () => void] {
  const counter = useViewModel(counterSpec);
  const count = useViewModelSelector(counterSpec, (vm) => vm.state.count);
  return [`Count ${count}`, () => counter.increment()];
}
```

**正确示例**

```tsx
export function useCounterTitle(): [string, () => void] {
  const counter = useReadViewModel(counterSpec);
  const count = useViewModelSelector(counterSpec, (vm) => vm.state.count);
  return [`Count ${count}`, () => counter.increment()];
}
```

## `undisposed-binding`

`ViewModelBinding` 在 `dispose()` 之前会一直绑定它解析过的每个 ViewModel，
`ViewModelRuntime` 也会一直保留它创建的每个 generation。如果创建的 Binding 或
Runtime 是临时值，或者保存在局部变量、实例字段里却从未 dispose、也从未交给其他
owner，这些实例就会泄漏。在测试中，它们还会泄漏到后续测试。

**错误示例**

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

**正确示例**

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

模块级声明或 static 字段是应用生命周期的 owner，不会被报告。dispose Runtime 会同时
dispose 它创建的 Binding，`runWithOverride` 提供的 Runtime 也会被自动 dispose。传给
其他调用、作为返回值或存到其他对象上的 Binding，视为已经交给新的 owner。如果由
`close()` 之类的包装方法负责 dispose，请带上原因抑制该警告。

## `temporary-spec`

Spec 只应创建一次：在模块级变量或 static 字段的初始化表达式中。局部变量、实例字段、
函数返回值或调用处内联的 Spec，每次求值都会重新创建。在 React 中，内联 Spec 每次
render 都是新对象；仅传 builder 的 Spec 甚至每次都是新的身份。override 也无法再
替换它。

修复：private 实例字段改为 `static`，`this.spec` 改为 `ClassName.spec`；不捕获任何
作用域变量的 Spec 移到其所在语句之前的模块级 `const`。

**错误示例**

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

**正确示例**

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

调用参数 family（例如 `userSpec(userId)`）是预期用法，不会被报告。传给
`overrideWith`、`setProxy`、`runWithOverride`、`ViewModelRuntime.runWithOverrides`
或 Runtime `overrides` 选项的替换 Spec 也会被接受。

## `cached-lookup`

需要手动开启。Binding 或 Runtime 上的 `readCached`、`watchCached`、
`maybeReadCached`、`readCachesByTag` 等缓存查询，只能找到其他 owner 已经创建的
实例。结果取决于创建顺序，未命中时会抛错或返回 `undefined`。在推荐配置旁开启：

```js
export default [
  // ...the configuration above
  { files: ['**/*.{ts,tsx}'], rules: { 'view-model/cached-lookup': 'warn' } },
];
```

**错误示例**

```tsx
export function sharedCounter(binding: ViewModelBinding): CounterViewModel {
  return binding.watchCached(CounterViewModel, { key: 'shared-counter' });
}
```

**正确示例**

通过带 key 的 Spec 共享。每个解析它的 owner 都拿到同一个实例，先到者负责创建。

```tsx
const sharedCounterSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel(), {
  key: 'shared-counter',
});

export function sharedCounter(binding: ViewModelBinding): CounterViewModel {
  return binding.watch(sharedCounterSpec);
}
```

## 抑制诊断

先修复所有权或 Spec 问题。对有意为之的例外，加上带原因的局部指令：

```ts
// eslint-disable-next-line view-model/cached-instance -- kept for the application lifetime
```

要在整个 package 中关闭某条规则，在推荐配置之后把它设为 `'off'`。

## 与 Flutter 的对应关系

| ESLint 规则                         | Flutter `view_model_lint`           | JavaScript 差异                                                   |
| ----------------------------------- | ----------------------------------- | ----------------------------------------------------------------- |
| `view-model/dependency-cycle`       | `view_model_dependency_cycle`       | 也跟踪自身 Binding 的 `listen*`，它同样会解析并持有 child         |
| `view-model/cached-instance`        | `view_model_cached_instance`        | 包含解析类 hook，以及 React ref 等被赋值的属性                    |
| `view-model/alive-forever-key`      | `view_model_alive_forever_key`      | 单参数 family 的修复保持 Map 身份语义：`(arg) => arg`             |
| `view-model/unmanaged-construction` | `view_model_unmanaged_construction` | builder 是直接传给 Spec 构造的内联函数                            |
| `view-model/listen-in-render`       | `view_model_listen_in_build`        | render 指函数组件、React hook 与 class 的 `render`                |
| `view-model/instance-handoff`       | `view_model_instance_handoff`       | 也检查组件 props 与 Vue `defineProps<T>()`                        |
| `view-model/identity-collision`     | `view_model_identity_collision`     | 仅传 builder 的 Spec 永远不会冲突                                 |
| `view-model/selector-with-watch`    | `view_model_selector_with_watch`    | 同一组件对同一 Spec 使用 `useViewModel` 与 `useViewModelSelector` |
| `view-model/undisposed-binding`     | `view_model_undisposed_binding`     | 也检查 `ViewModelRuntime`；dispose Runtime 会覆盖其 Binding       |
| `view-model/temporary-spec`         | `view_model_temporary_spec`         | static 修复会改写 `this.spec`；提取修复不会把代码移到使用处之后   |
| `view-model/cached-lookup`          | `view_model_cached_lookup`          | 也检查 Runtime 上的缓存查询                                       |

Flutter 需要单独的 `view_model_lint:fix` 命令，因为 `dart fix` 不能应用插件修复；
ESLint 通过 `--fix` 应用这些修复。
