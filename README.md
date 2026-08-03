# view_model

[![CI](https://github.com/lwj1994/js_view_model/actions/workflows/ci.yml/badge.svg)](https://github.com/lwj1994/js_view_model/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

面向 **React Native** 与 **Electron** 客户端的 ViewModel、模块组合、依赖注入与自动生命周期运行时。

> [!WARNING]
> **v0.1 Alpha**：API 仍可能调整，请先在非关键项目中验证并锁定版本。
>
> 本库只支持 React Native 和 Electron App，不支持普通 React Web、SSR、React Server Components 或通用 DOM 应用。

`view_model` 把一组有依赖关系的 ViewModel 放进明确的 Scope 中：实例在首次提交使用时由 Scope 的 Binding acquire，在该 Binding 存活期间保活；普通实例在最后一个 owner Binding 释放后自动销毁。React 绑定遵守 render/commit 边界，并针对 StrictMode 的重复挂载做了生命周期协调。

## 支持范围

| 运行环境                            | 入口                      | 状态       |
| ----------------------------------- | ------------------------- | ---------- |
| 平台无关 TypeScript / Electron main | `view_model/core`         | Alpha      |
| React Native                        | `view_model/react-native` | Alpha      |
| Electron renderer                   | `view_model/electron`     | Alpha      |
| 普通 React Web / SSR                | 无                        | **不支持** |

库不会发布通用的 `view_model/react` 入口。Electron renderer 虽然使用 React hooks，但它依赖桌面窗口的 focus、blur 与 visibility 生命周期，不代表支持浏览器 Web 应用。

## 当前从 GitHub 源码使用

v0.1 Alpha 本轮只推送 GitHub，**尚未发布到 npm**。先 clone、安装依赖并构建：

```sh
git clone https://github.com/lwj1994/js_view_model.git
cd js_view_model
npm install
npm run build
npm pack
```

然后在目标 App 中安装 `npm pack` 生成的本地 `.tgz`：

```sh
npm install /absolute/path/to/js_view_model/view_model-0.1.0.tgz
```

未来 npm 正式发布后，才可使用：

```sh
npm install view_model
```

React Native 项目应已有 `react` 与 `react-native`；Electron renderer 项目应已有 `react` 及自己的 renderer（示例使用 `react-dom`），Electron 应由宿主应用提供。具体 peer dependency 范围以当前源码的 `package.json` 为准。

## 三个入口

```ts
import {
  ViewModel,
  StateViewModel,
  ViewModelBinding,
  ViewModelRuntime,
  viewModelSpec,
  type ViewModelSpec,
} from 'view_model/core';

import {
  ViewModelScope,
  useReadViewModel,
  useViewModel,
  useViewModelSelector,
} from 'view_model/react-native';

import {
  ViewModelScope,
  createElectronRendererLifecycleSource,
  useReadViewModel,
  useViewModel,
  useViewModelSelector,
} from 'view_model/electron';
```

平台入口会重新导出 core API。建议业务代码仍从 `view_model/core` 导入 ViewModel 与 Spec，从平台入口导入 Scope 与 hooks，让运行边界一眼可见。

## React Native 快速开始

把 Spec 定义在模块顶层，使它在所有 render 中保持稳定：

```tsx
import { Button, Text, View } from 'react-native';
import { StateViewModel, viewModelSpec } from 'view_model/core';
import { ViewModelScope, useReadViewModel, useViewModelSelector } from 'view_model/react-native';

class CounterViewModel extends StateViewModel<{ count: number }> {
  constructor() {
    super({ count: 0 });
  }

  increment = () => {
    this.updateState((current) => ({ count: current.count + 1 }));
  };
}

const counterSpec = viewModelSpec(() => new CounterViewModel());

function Counter() {
  const count = useViewModelSelector(counterSpec, (counter) => counter.state.count);
  const counter = useReadViewModel(counterSpec);

  return (
    <View>
      <Text>{count}</Text>
      <Button title="加一" onPress={counter.increment} />
    </View>
  );
}

export default function App() {
  return (
    <ViewModelScope>
      <Counter />
    </ViewModelScope>
  );
}
```

`ViewModelScope` 默认监听 React Native `AppState`：`active` 时恢复，`inactive` 或 `background` 时暂停。完整示例见 [examples/react-native-counter](./examples/react-native-counter/README.md)。

## Electron renderer 快速开始

每个 renderer/window 建议拥有自己的顶层 Scope。默认生命周期源会把窗口 focus 且页面可见视为 active：

```tsx
import { createRoot } from 'react-dom/client';
import { StateViewModel, viewModelSpec } from 'view_model/core';
import { ViewModelScope, useReadViewModel, useViewModelSelector } from 'view_model/electron';

class WindowCounter extends StateViewModel<{ count: number }> {
  constructor() {
    super({ count: 0 });
  }

  increment = () => {
    this.updateState((current) => ({ count: current.count + 1 }));
  };
}

const counterSpec = viewModelSpec(() => new WindowCounter());

function App() {
  const count = useViewModelSelector(counterSpec, (counter) => counter.state.count);
  const counter = useReadViewModel(counterSpec);

  return <button onClick={counter.increment}>count: {count}</button>;
}

createRoot(document.getElementById('root')!).render(
  <ViewModelScope>
    <App />
  </ViewModelScope>,
);
```

Electron main 不使用 React hooks，可直接使用 `ViewModelRuntime` 与普通 `ViewModelBinding`。完整 renderer 与 main 示例见 [examples/electron](./examples/electron/README.md)。

## 核心语义

### 1. Spec 必须稳定

`ViewModelSpec` 同时描述构造方式与实例身份。优先在模块顶层创建：

```ts
const profileSpec = viewModelSpec(() => new ProfileViewModel());
```

不要在组件 render 中直接调用 `viewModelSpec(...)`。每次 render 产生新 Spec 会改变身份，导致错误的实例创建与生命周期抖动。确实需要动态 Spec 时，必须用稳定缓存，并认真设计 key。

### 2. unkeyed 与 keyed

- 没有 key 的 Spec 使用当前 Scope 的私有身份；同一 Scope 内共享，跨 Scope 隔离。
- 显式 key 在同一 `ViewModelRuntime` 内共享，可以跨 Scope 获取同一实例。
- 不同 Runtime 永远隔离，即使 Spec 和 key 相同。
- `aliveForever` 实例必须提供显式 key；否则无法安全定义其全局身份。

### 3. watch、read 与 selector

| API                                             | 保活实例 | VM 更新时刷新调用方 | 适用场景                                    |
| ----------------------------------------------- | -------- | ------------------- | ------------------------------------------- |
| `useViewModel(spec)`                            | 是       | 是                  | 组件需要整个 VM 的更新                      |
| `useReadViewModel(spec)`                        | 是       | 否                  | 只调用 action、命令或读取一次               |
| `useViewModelSelector(spec, selector, equals?)` | 是       | selector 结果变化时 | 组件只依赖一小段数据                        |
| `binding.watch(spec)`                           | 是       | 向 owner 传播更新   | ViewModel 依赖另一个 ViewModel 并关注其变化 |
| `binding.read(spec)`                            | 是       | 不传播普通 VM 更新  | 只建立依赖与生命周期边                      |

`read` 不是“不参与生命周期”。它仍会建立 owner 关系，并感知实例被释放或强制回收；区别只在于是否订阅 ViewModel 自身更新。

### 4. 父子 ViewModel 使用 getter 注入

ViewModel 通过自己的 binding 解析依赖。把解析放在 getter 中，可以让实例在所属 generation 内按需创建，并自动建立 parent → child 保活边：

```ts
const sessionSpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'app-session',
  aliveForever: true,
});

class InboxViewModel extends ViewModel {
  private get session() {
    return this.viewModelBinding.read(sessionSpec);
  }

  async refresh() {
    const token = await this.session.requireToken();
    // ...
  }
}
```

只要 parent generation 存活，它解析过的 child 就不会先于 parent 自动释放。依赖图必须无环。

依赖 getter 只用于 ViewModel 的 action、生命周期或内部协作，**不要在 React render、
JSX 或 selector 中直接读取**。UI 应读取 parent 自己公开的 state/字段，并通过 action
驱动协作；render 中展开依赖 getter 会让 child 在 commit 前被解析。

### 5. 自动生命周期

React hook 在 commit 订阅时让当前 Scope Binding acquire 实例。单个 hook cleanup 只取消自己的 listener，不释放 Binding 对实例的 owner 引用；这样同一 Scope 内的后续读取仍会命中原实例。Scope 卸载并 dispose Binding 时才统一 release 它拥有的实例，最后一个 owner Binding 离开后实例进入自动释放流程。Scope 的暂停/恢复也会传递给它拥有的实例。

开发环境 StrictMode 可能执行额外 render，并进行 effect 的 setup → cleanup → setup 探测。本库不会把 render 阶段的准备当成正式 owner；commit 后才建立引用，Scope Binding 的最终释放会留出一次可取消窗口，从而避免探测过程错误销毁实例。

并发调度或 Suspense 放弃的 render 所留下的 provisional generation 会自动清扫；若稍后
才 commit，generation snapshot 会驱动 hook 重新解析，避免长寿命 Runtime 累积未绑定实例。

`prepare` 可能在 render 中执行 Spec builder 和构造器，所以 builder/constructor 必须保持纯净。网络请求、计时器、IPC 与原生订阅应从 commit 后触发的生命周期开始，并在 dispose 时清理。

### 6. 谨慎 recycle

`recycle` 是强制回收，不是局部重建。对 keyed 共享实例调用它会影响所有 Scope 和所有 parent owner。需要新 generation 时，优先使用新的显式 key；只有明确接受影响所有 owner 时才 recycle。

更完整的说明：

- [核心概念](./docs/concepts.md)
- [生命周期与 StrictMode](./docs/lifecycle.md)
- [React Native 集成](./docs/react-native.md)
- [Electron 集成](./docs/electron.md)
- [API 导览](./docs/api.md)

## Alpha 阶段约束

- API 与行为可能在 `0.1.x` 内调整。
- 暂不承诺普通 Web、SSR 或跨 Electron 进程共享对象。
- Electron main、preload、renderer 是不同 JavaScript realm；跨进程数据应通过安全的 IPC DTO 传递。
- ViewModel 依赖 getter 不可在 React render/selector 中直接读取，只用于 commit 后的 action 与内部协作。
- 建议为生命周期、依赖图与 recycle 行为编写测试，不要只测试最终 UI。

## License

[MIT](./LICENSE)
