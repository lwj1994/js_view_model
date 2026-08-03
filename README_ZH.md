# view_model

[![CI](https://github.com/lwj1994/js_view_model/actions/workflows/ci.yml/badge.svg)](https://github.com/lwj1994/js_view_model/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.md)

面向 **React Native** 与 **Electron** 的应用级依赖注入、功能模块组合、状态管理与自动生命周期框架。

`view_model` 不只管理页面状态。功能、repository、service、coordinator、设备连接或领域能力都可以成为受管理的 ViewModel。模块通过 `viewModelBinding` 按需解析彼此，在明确的 `ViewModelRuntime` 内共享实例，并在最后一个 owner 离开后释放资源。

> [!WARNING]
> **v0.1 Alpha：** API 仍可能调整。请锁定版本，并先在非关键项目中验证。
>
> 本包只支持 React Native 与 Electron App，不支持普通 React Web、SSR、React Server Components 或通用 DOM 应用。

## 应用级 DI，不只是 UI Store

核心 Runtime 不依赖 React。应用可在 composition root 创建一个长期 Runtime，让启动逻辑、后台服务、Electron main、测试或任意 TypeScript host 通过 plain Binding 使用同一套 DI：

```ts
import { StateViewModel, ViewModel, ViewModelRuntime, viewModelSpec } from 'view_model/core';

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

export const sessionSpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'application-session',
  aliveForever: true,
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

export const ordersRepositorySpec = viewModelSpec(() => new OrdersRepository());

export const appRuntime = new ViewModelRuntime();
const bootstrapBinding = appRuntime.createBinding({ id: 'application-bootstrap' });

await bootstrapBinding.read(ordersRepositorySpec).load();

// Release this host when bootstrap ownership ends. Dispose the application
// runtime at the real process/application shutdown boundary.
bootstrapBinding.dispose();
```

示例使用 `aliveForever`，只是为了让 session 跨越一次有意的零 owner 交接。若某个 application Binding 始终拥有 session，应保留 key 以便跨 Binding 共享，同时省略 `aliveForever`。

同一个 `appRuntime` 可注入 React Native 或 Electron renderer 的 `ViewModelScope`。同一个 keyed Spec 随后能在 plain host 与 React Scope 间解析到相同 generation。这里的“应用级”严格指单个 JavaScript realm 内的显式 Runtime；ViewModel 对象不会跨 Electron 进程共享。

## 为什么 React 需要 Scope

`ViewModelScope` 是 React owner 适配层，不是 DI 容器本身。它负责：

1. 向 hooks 提供当前 Runtime 与一个稳定 Binding；
2. 把 React render/commit/unmount 转换为安全的 prepare/acquire/release；
3. 定义 unkeyed 实例的私有身份边界与整组 owner 的释放时机。

没有 Scope，hook 无法判断实例属于哪个 Runtime，也无法知道 owner 何时结束。非 React 代码不需要 Scope，直接调用 `runtime.createBinding()`。

嵌套 Scope 默认继承父 Runtime，但会创建独立 Binding。因此 unkeyed 实例相互隔离，`(Spec token, key)` 身份仍可共享。传入外部 Runtime 的 Scope 不拥有该 Runtime，最终 dispose 由调用方负责。

一个容易误解的规则：lifecycle pause/resume 作用于整个 Runtime。若两个 Scope 共享 Runtime，任一 Scope 的 lifecycle source inactive 都会暂停该 Runtime 中全部已激活 ViewModel。页面或窗口需要独立暂停时，应使用独立 Runtime，或把 focus 建模为普通业务状态。

## 支持入口

| 运行环境                            | 入口                      | 状态       |
| ----------------------------------- | ------------------------- | ---------- |
| 平台无关 TypeScript / Electron main | `view_model/core`         | Alpha      |
| React Native                        | `view_model/react-native` | Alpha      |
| Electron renderer                   | `view_model/electron`     | Alpha      |
| 普通 React Web / SSR                | 无                        | **不支持** |

平台入口会重导出 core API。建议从 `view_model/core` 导入 ViewModel 与 Spec，从对应平台入口导入 Scope 与 hooks，让运行边界清晰可见。本库刻意不提供 `view_model/react`。

## 从源码安装

v0.1 Alpha 当前只从 GitHub 分发，尚未发布到 npm。先在本地构建并打包：

```sh
git clone https://github.com/lwj1994/js_view_model.git
cd js_view_model
npm install
npm run build
npm pack
```

在目标 App 中安装生成的压缩包：

```sh
npm install /absolute/path/to/js_view_model/view_model-0.1.0.tgz
```

未来正式发布到 npm 后，安装方式才会变为：

```sh
npm install view_model
```

React Native App 必须提供兼容的 `react` 与 `react-native` peer。Electron renderer App 必须提供 React 与自己的 renderer，Electron 由宿主 App 提供。精确版本范围以当前 `package.json` 为准。

## React Native 快速开始

Spec 应定义在模块作用域，保证跨 render 的身份稳定：

```tsx
import { Button, Text, View } from 'react-native';
import { StateViewModel, viewModelSpec } from 'view_model/core';
import { ViewModelScope, useReadViewModel, useViewModelSelector } from 'view_model/react-native';

class CounterViewModel extends StateViewModel<Readonly<{ count: number }>> {
  public constructor() {
    super({ count: 0 });
  }

  public readonly increment = (): void => {
    this.updateState(({ count }) => ({ count: count + 1 }), 'counter.increment');
  };
}

const counterSpec = viewModelSpec(() => new CounterViewModel(), {
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

## Electron renderer 快速开始

每个 renderer/window 通常应拥有自己的顶层 Scope 与 Runtime。默认 lifecycle 只有在窗口 focus 且 document 可见时才视为 active：

```tsx
import { createRoot } from 'react-dom/client';
import { StateViewModel, viewModelSpec } from 'view_model/core';
import { ViewModelScope, useReadViewModel, useViewModelSelector } from 'view_model/electron';

class WindowCounter extends StateViewModel<number> {
  public constructor() {
    super(0);
  }

  public readonly increment = (): void => {
    this.updateState((count) => count + 1, 'counter.increment');
  };
}

const counterSpec = viewModelSpec(() => new WindowCounter());

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

- 每个 `ViewModelSpec` 必须在模块作用域保持稳定。Runtime identity 是稳定的 **Spec token + key**，不是 ViewModel class 或单独的 key。
- `watch` 与 `read` 都会创建/解析实例并建立生命周期 owner；只有 `watch` 传播普通 ViewModel 通知。
- unkeyed 实例属于 Binding 私有。key 让同一 Spec identity 在同一 Runtime 的多个 Binding 间共享。`aliveForever` 必须带显式 key。
- builder 与 constructor 必须纯净。计时器、IPC、原生订阅等资源从 `onCreate` 启动，并用 `addDispose` 登记清理。
- child module 应通过不缓存的 `viewModelBinding.read/watch` getter 解析。getter 只能在 commit 后由 ViewModel action、生命周期或内部协作访问，不得从 React render 或 selector 展开。
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

## 安装 Codex Skill

仓库包含用于实现与审查 `view_model` 架构的可复用 skill：

```sh
npx skills add https://github.com/lwj1994/js_view_model --skill js-view-model
```

源码位于 [`skill/js-view-model`](./skill/js-view-model/SKILL.md)。

## License

[MIT](./LICENSE)
