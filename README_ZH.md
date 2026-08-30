# view_model：状态管理、依赖注入与模块架构

[![CI](https://github.com/lwj1994/js_view_model/actions/workflows/ci.yml/badge.svg)](https://github.com/lwj1994/js_view_model/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40lwjlol%2Fview_model.svg)](https://www.npmjs.com/package/@lwjlol/view_model)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.md)

**不只是状态管理。view_model 同时是一套面向 React Native 与 Electron 的 TypeScript 应用级依赖注入、功能模块组合与自动生命周期管理架构。**

npm 包名为 [`@lwjlol/view_model`](https://www.npmjs.com/package/@lwjlol/view_model)。

`view_model` 不只管理页面状态。功能、repository、service、coordinator、设备连接或领域能力都可以成为受管理的 ViewModel。模块通过 `viewModelBinding` 按需解析彼此，在明确的 `ViewModelRuntime` 内共享实例，并在最后一个 owner 离开后释放资源。

```sh
npm install @lwjlol/view_model@0.2.0
```

## Skill 安装

```sh
npx skills add https://github.com/lwj1994/js_view_model --skill js-view-model
```

该 skill 用于实现与审查 `view_model` 架构，源码位于 [`skill/js-view-model`](./skill/js-view-model/SKILL.md)。

> [!IMPORTANT]
> 本包只支持 React Native 与 Electron App，不支持普通 React Web、SSR、React Server Components 或通用 DOM 应用。

---

## 核心目录

- [架构概览](#架构概览)
- [两个核心角色](#两个核心角色)
- [应用级 DI](#应用级-di不只是-ui-store)
- [为什么 React 需要 Scope](#为什么-react-需要-scope)
- [ViewModel 间依赖](#viewmodel-间依赖)
- [支持入口](#支持入口)
- [快速开始](#快速开始)
- [核心规则](#核心规则)
- [文档](#文档)

---

## 架构概览

TypeScript 实现与 Flutter 包保持相同的受管理模块方向，同时用显式 Runtime 表达 JavaScript realm 边界：

```text
Application / Consumer Layer
├── React Native ViewModelScope + hooks
├── Electron renderer ViewModelScope + hooks
└── Plain TypeScript host (bootstrap, service, Electron main, test)
                 │ read / watch / listen
                 ▼
ViewModelRuntime + ViewModelBinding
├── Runtime: identity, keyed sharing, dependency graph, pause state
├── Binding: owner, resolver, notification adapter
└── Scope: React adapter that owns one stable Binding
                 │ acquire / release
                 ▼
Managed ViewModel Generations
└── Per-generation dependency Binding → lazily resolved children
```

核心机制：

1. `watch(spec)` 与 `read(spec)` 都会解析并拥有 generation；只有 `watch` 传播普通 ViewModel 通知。
2. Runtime 是单个 JavaScript realm 内的应用 DI 与共享边界；Binding 表示该 Runtime 中的一个 owner。
3. unkeyed identity 对 Binding 私有。显式 ViewModel type 与 key 可在同一 Runtime 的多个 Binding 间共享一个 generation。
4. 每个 parent generation 按需拥有 dependency Binding。解析 child 会建立受管理的 parent edge，并传播当前 root owner source。
5. 最后一条 owner edge 离开后，非 `aliveForever` generation 自动 dispose；`recycle` 会越过全部 owner 强制销毁。

## 两个核心角色

`ViewModel` 与 `StateViewModel<TState>` 是受管理侧：应用模块获得通知、依赖访问、生命周期 hook 与注册式 cleanup。`ViewModelRuntime` 与 `ViewModelBinding` 是管理侧：它们解析 identity、持有 generation、传播 update 并释放资源。

React `ViewModelScope` 只是管理侧的平台 adapter，不会让本库退化为 UI-only store；plain TypeScript host 通过 `runtime.createBinding()` 使用同一个 Runtime。

## 应用级 DI，不只是 UI Store

核心 Runtime 不依赖 React。应用可在 composition root 创建一个长期 Runtime，让启动逻辑、后台服务、Electron main、测试或任意 TypeScript host 通过 plain Binding 使用同一套 DI：

```ts
import {
  StateViewModel,
  ViewModel,
  ViewModelRuntime,
  viewModelSpec,
} from '@lwjlol/view_model/core';

type SessionState = Readonly<{ token: string | null }>;

interface Order {
  readonly id: string;
}

declare const ordersApi: {
  list(token: string): Promise<readonly Order[]>;
};

class SessionViewModel extends StateViewModel<SessionState> {
  public constructor() {
    super({ token: null });
  }

  public requireToken(): string {
    const token = this.state.token;
    if (token === null) throw new Error('Authentication required.');
    return token;
  }
}

export const sessionSpec = viewModelSpec(SessionViewModel, () => new SessionViewModel(), {
  key: 'application-session',
  debugLabel: 'Session',
});

class OrdersRepository extends ViewModel {
  private get session(): SessionViewModel {
    return this.viewModelBinding.read(sessionSpec);
  }

  public async load(): Promise<readonly Order[]> {
    return ordersApi.list(this.session.requireToken());
  }
}

export const ordersRepositorySpec = viewModelSpec(OrdersRepository, () => new OrdersRepository());

export const appRuntime = new ViewModelRuntime();
const applicationBinding = appRuntime.createBinding({ id: 'application' });

await applicationBinding.read(ordersRepositorySpec).load();

// Release the application owner before disposing the Runtime at shutdown.
export function shutdownApplication(): void {
  applicationBinding.dispose();
  appRuntime.dispose();
}
```

长期存在的 application Binding 是真实 owner，因此不需要 `aliveForever`。session 的显式 key 只用于让独立的 plain 与 React Binding 有意共享该 generation。只有明确需要零 owner retention 时才使用 `aliveForever`。

同一个 `appRuntime` 可注入 React Native 或 Electron renderer 的 `ViewModelScope`。相同的显式 ViewModel type 与 key 随后能在 plain host 与 React Scope 间解析到同一 generation。这里的“应用级”严格指单个 JavaScript realm 内的显式 Runtime；ViewModel 对象不会跨 Electron 进程共享。

## 为什么 React 需要 Scope

`ViewModelScope` 是 React owner 适配层，不是 DI 容器本身。它负责：

1. 向 hooks 提供当前 Runtime 与一个稳定 Binding；
2. 把 React render/commit/unmount 转换为安全的 prepare/acquire/release；
3. 定义 unkeyed 实例的私有身份边界与整组 owner 的释放时机。

没有 Scope，hook 无法判断实例属于哪个 Runtime，也无法知道 owner 何时结束。非 React 代码不需要 Scope，直接调用 `runtime.createBinding()`。

嵌套 Scope 默认继承父 Runtime，但会创建独立 Binding。因此 unkeyed 实例相互隔离，显式 ViewModel type + 显式 key 的身份仍可共享。传入外部 Runtime 的 Scope 不拥有该 Runtime，最终 dispose 由调用方负责。

一个容易误解的规则：lifecycle pause/resume 作用于整个 Runtime。若两个 Scope 共享 Runtime，任一 Scope 的 lifecycle source inactive 都会暂停该 Runtime 中全部已激活 ViewModel。页面或窗口需要独立暂停时，应使用独立 Runtime，或把 focus 建模为普通业务状态。

## ViewModel 间依赖

受管理 child module 应通过 parent 上的不缓存 getter 解析。getter 声明本身不会创建对象；attach 后访问 getter 才会调用 `viewModelBinding.read/watch(spec)`、建立 parent-owned lifecycle edge，并能在显式 `recycle` 后解析新的 generation。

### 让 ViewModel 实例留在自己的 Binding 边界内

不要通过 component props、constructor 参数、global、registry、callback payload 或临时 cache 传递已经解析出的 ViewModel 实例。Runtime 看不到这种引用：它不会 acquire owner，不会建立 parent dependency edge，也无法知道接收方何时应 release 实例。原 owner 存活时，代码可能看似正常；Scope dispose 或 `recycle` 后，接收方却可能继续持有过期或已经 disposed 的 generation。

应传递稳定的 `ViewModelSpec`、业务 key/ID、不可变 DTO 或 plain port。React consumer 从自己的 Scope 解析 Spec；plain host 从自己的 Binding 解析；parent ViewModel 通过不缓存的 `viewModelBinding.read/watch` getter 解析。不同 Binding 确实需要同一个 generation 时，应使用同一个 Runtime 与显式 key，不能把手工传递实例当作 managed sharing 的替代方案。

## 支持入口

| 运行环境                            | 入口                              | 状态       |
| ----------------------------------- | --------------------------------- | ---------- |
| 平台无关 TypeScript / Electron main | `@lwjlol/view_model/core`         | 支持       |
| React Native                        | `@lwjlol/view_model/react-native` | 支持       |
| Electron renderer                   | `@lwjlol/view_model/electron`     | 支持       |
| 普通 React Web / SSR                | 无                                | **不支持** |

平台入口会重导出 core API。建议从 `@lwjlol/view_model/core` 导入 ViewModel 与 Spec，从对应平台入口导入 Scope 与 hooks，让运行边界清晰可见。本库刻意不提供 `@lwjlol/view_model/react`。

React Native App 必须提供兼容的 `react` 与 `react-native` peer。Electron renderer App 必须提供 React 与自己的 renderer，Electron 由宿主 App 提供。精确版本范围以当前 `package.json` 为准。

## 快速开始

### React Native

Spec 应定义在模块作用域，避免 render 期间分配，并让 builder 与 options 保持稳定：

```tsx
import { Button, Text, View } from 'react-native';
import { StateViewModel, viewModelSpec } from '@lwjlol/view_model/core';
import {
  ViewModelScope,
  useReadViewModel,
  useViewModelSelector,
} from '@lwjlol/view_model/react-native';

class CounterViewModel extends StateViewModel<Readonly<{ count: number }>> {
  public constructor() {
    super({ count: 0 });
  }

  public readonly increment = (): void => {
    this.updateState(({ count }) => ({ count: count + 1 }), 'counter.increment');
  };
}

const counterSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel(), {
  debugLabel: 'Counter',
});

function Counter(): React.JSX.Element {
  const count = useViewModelSelector(counterSpec, (counter) => counter.state.count);
  const counter = useReadViewModel(counterSpec);

  return (
    <View>
      <Text>{count}</Text>
      <Button title="Increment" onPress={counter.increment} />
    </View>
  );
}

export default function App(): React.JSX.Element {
  return (
    <ViewModelScope>
      <Counter />
    </ViewModelScope>
  );
}
```

默认 React Native Scope 把 `AppState === 'active'` 映射为 resume，其他所有状态映射为 pause。

### Electron renderer

每个 renderer/window 通常应拥有自己的顶层 Scope 与 Runtime。默认 lifecycle 只有在窗口 focus 且 document 可见时才视为 active：

```tsx
import { createRoot } from 'react-dom/client';
import { StateViewModel, viewModelSpec } from '@lwjlol/view_model/core';
import {
  ViewModelScope,
  useReadViewModel,
  useViewModelSelector,
} from '@lwjlol/view_model/electron';

class WindowCounter extends StateViewModel<number> {
  public constructor() {
    super(0);
  }

  public readonly increment = (): void => {
    this.updateState((count) => count + 1, 'counter.increment');
  };
}

const counterSpec = viewModelSpec(WindowCounter, () => new WindowCounter());

function App(): React.JSX.Element {
  const count = useViewModelSelector(counterSpec, (counter) => counter.state);
  const counter = useReadViewModel(counterSpec);
  return <button onClick={counter.increment}>Count: {count}</button>;
}

createRoot(document.getElementById('root')!).render(
  <ViewModelScope>
    <App />
  </ViewModelScope>,
);
```

Electron main 不使用 hooks。使用 `ViewModelRuntime` 与 plain Binding，再通过收窄的 preload IPC API 暴露可序列化 DTO/事件。

## 核心规则

- 优先使用 `viewModelSpec(MyViewModel, () => new MyViewModel(), options)`。在一个 Runtime 内，显式 identity 是 **ViewModel type + effective key**；省略 key 时它属于 Binding 私有。相同 type 与 key 的独立显式 Spec 共享一个 generation。
- Spec 应在模块作用域保持稳定，避免 render 期间分配，并让 builder/options 一致。builder-only 形式作为兼容 fallback 仍然保留，其每个 Spec 都会获得独立 identity token。
- `watch` 与 `read` 都会创建/解析实例并建立生命周期 owner；只有 `watch` 传播普通 ViewModel 通知。
- 一次完整的同步通知级联共享同一 transaction。同一 callback 投递会按 Binding 去重，不同 Binding 仍分别收到 update；异步通知会开启新 transaction。
- unkeyed 实例属于 Binding 私有。显式 key 让同一显式 ViewModel type identity 在同一 Runtime 的多个 Binding 间共享。`aliveForever` 必须带显式 key。
- builder 与 constructor 必须纯净。计时器、IPC、原生订阅等资源从 `onCreate` 启动，并用 `addDispose` 登记清理。
- child module 应通过不缓存的 `viewModelBinding.read/watch` getter 解析。getter 只能在 commit 后由 ViewModel action、生命周期或内部协作访问，不得从 React render 或 selector 展开。
- 禁止在 owner 之间直接传递已解析的 ViewModel 实例。应传递 Spec、key/ID、不可变 DTO 或 plain port，再由接收方通过自己的 Binding 解析，让 ownership、dependency edge、recycle 与 disposal 始终受 Runtime 管理。
- 绑定到 parent 的 root Binding ownership source 会传播给它已解析的 child，后续 bind/unbind 变化也会实时同步。
- cached/tag Binding API（`readCached`、`watchCached`、它们的 `maybe` variant，以及 `readCachesByTag`/`watchCachesByTag`）是高级的只读取查询工具。它们不会创建缺失 generation，tag 也不参与 identity。
- Binding-owned 副作用订阅应使用 `binding.listen`、`listenState` 或 `listenStateSelect`。返回的 disposer 可提前清理；Binding dispose 或 generation recycle 也会自动移除它们。
- `recycle` 是越过全部 owner 的 Runtime 级强制销毁。除非明确需要全局失效，否则优先使用新的显式 key。
- 单个 hook cleanup 只移除自己的 listener；Scope Binding 会继续保有实例，直到 Scope dispose 或 generation 被 recycle。

## 文档

- [文档索引](./docs/zh/README.md)
- [快速开始与应用级 DI](./docs/zh/getting-started.md)
- [Runtime、Binding、Scope 与架构](./docs/zh/concepts.md)
- [ViewModel 与 StateViewModel](./docs/zh/view-models.md)
- [模块组合与依赖注入](./docs/zh/dependency-injection.md)
- [身份、owner 与 recycle](./docs/zh/identity-and-lifetime.md)
- [生命周期、StrictMode 与暂停恢复](./docs/zh/lifecycle.md)
- [React Native 集成](./docs/zh/react-native.md)
- [Electron 集成](./docs/zh/electron.md)
- [测试与包验证](./docs/zh/testing.md)
- [API 参考](./docs/zh/api.md)
- [与 Flutter `view_model` 的差异](./docs/zh/flutter-comparison.md)

英文与中文模块保持一一对应，并在每篇文档首行互链。

## License

[MIT](./LICENSE)
