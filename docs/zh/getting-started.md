# 快速开始

[English](../getting-started.md)

`view_model` 是一个面向有状态应用模块的 TypeScript Runtime，提供依赖注入、通知与自动生命周期管理。它支持：

- 通过 `@lwjlol/view_model/core` 支持平台无关的 TypeScript 代码与 Electron main；
- 通过 `@lwjlol/view_model/react-native` 支持 React Native；
- 通过 `@lwjlol/view_model/electron` 支持 Electron renderer。

它不提供通用 React Web、SSR 或 React Server Components 入口。尤其不存在公开的 `@lwjlol/view_model/react` 导出。

核心 Runtime 不依赖 React。`ViewModelScope` 只是 React adapter：它创建或接收 `ViewModelRuntime`，持有一个 `ViewModelBinding`，并把平台生命周期事件连接到该 Runtime。即使完全没有 UI，也可以创建和使用应用 service 与全局依赖图。

## 安装

在 React Native 或 Electron 应用中安装已发布的正式包：

```sh
npm install @lwjlol/view_model@0.3.1
```

相关 peer dependency 由宿主应用提供：React Native 应用提供 React 与 React Native；Electron renderer 提供 React 与 Electron。Electron main 可以在不依赖 React 的情况下使用 core 入口。

## 1. 选择正确入口

model、Spec、Runtime 与非 React 宿主使用 core 入口：

```ts
import {
  StateViewModel,
  ViewModel,
  ViewModelRuntime,
  viewModelSpec,
  type ViewModelSpec,
} from '@lwjlol/view_model/core';
```

Scope 与 hook 使用平台入口：

```ts
import {
  ViewModelScope,
  useReadViewModel,
  useViewModel,
  useViewModelSelector,
} from '@lwjlol/view_model/react-native';
```

```ts
import {
  ViewModelScope,
  useReadViewModel,
  useViewModel,
  useViewModelSelector,
} from '@lwjlol/view_model/electron';
```

平台入口会重新导出 core API；但从 `@lwjlol/view_model/core` 导入 model，从平台入口导入 UI adapter，更容易在 review 时识别进程与平台边界。

## 2. 定义 ViewModel 与稳定 Spec

`StateViewModel<State>` 保存一个 state snapshot，并在 snapshot 变化时通知 owner。

```ts
import { StateViewModel, viewModelSpec } from '@lwjlol/view_model/core';

type CounterState = Readonly<{
  count: number;
}>;

export class CounterViewModel extends StateViewModel<CounterState> {
  public constructor() {
    super({ count: 0 });
  }

  public readonly increment = (): boolean =>
    this.updateState((current) => ({ count: current.count + 1 }), 'counter.increment');
}

export const counterSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel(), {
  debugLabel: 'Counter',
});
```

Spec 应保存在模块作用域。推荐 overload 显式传入 ViewModel class：unkeyed identity 是同一 Binding 内的 type，keyed identity 是同一 Runtime 内的 type + key。因此，显式 type 与 key 相同的独立 Spec 会共享。稳定声明还能让最终生效的 builder 与 options 保持确定，并避免在 render 中反复分配 factory wrapper。

builder-only overload 会为每个 Spec 分配私有 token。它仅作为兼容 fallback 保留；即使文本 key 相同，分别创建的 builder-only Spec 也不会共享。

builder 与 constructor 必须保持纯净。它们可以初始化内存字段，但不能打开 socket、启动 timer、订阅原生 API、执行 IPC 或解析另一个 ViewModel。React 可能在一次最终被放弃的 render 中运行 builder。资源获取属于 `onCreate`。

## 3. 不依赖 React 使用 core

`ViewModelRuntime` 是单个 JavaScript realm 内的应用容器。`ViewModelBinding` 是它所解析的每个 ViewModel 的 owner。

```ts
import { ViewModelRuntime } from '@lwjlol/view_model/core';

const runtime = new ViewModelRuntime();

function renderHost(): void {
  const counter = binding.watch(counterSpec);
  console.log(`count: ${counter.state.count}`);
}

const binding = runtime.createBinding({
  id: 'application-host',
  onUpdate: renderHost,
});

renderHost();
binding.read(counterSpec).increment();

// Shut down the owner before shutting down its container.
binding.dispose();
runtime.dispose();
```

两种解析模式有不同的通知行为：

- `binding.read(spec)` 解析并保活实例，但在 Binding 层忽略 ViewModel 的普通通知。
- `binding.watch(spec)` 解析并保活实例，并把普通通知转发给 Binding 的 `onUpdate` callback。

两种模式都会参与 owner 与生命周期管理。`read` 不表示“临时”或“不受管理”。

示例从 `renderHost` 中再次调用 `binding.watch(counterSpec)`。该调用对当前 identity 幂等，也使宿主能在显式 recycle 后解析新的 generation。

长期存在的 plain Binding 必须 dispose。应用容器、后台 service、测试、Electron main 进程或其他宿主停止时，也应 dispose Runtime。

## 4. 使用应用级依赖容器

ViewModel 不只用于 screen state。即使不存在 React tree，稳定的 Runtime 与 Binding 也能持有应用 service。

```ts
import { ViewModel, ViewModelRuntime, viewModelSpec } from '@lwjlol/view_model/core';

class SessionViewModel extends ViewModel {
  public async requireAccessToken(): Promise<string> {
    // Read or refresh the application session here.
    return 'token';
  }
}

export const sessionSpec = viewModelSpec(SessionViewModel, () => new SessionViewModel(), {
  key: 'primary-session',
  debugLabel: 'Session',
});

export const applicationRuntime = new ViewModelRuntime();
export const applicationBinding = applicationRuntime.createBinding({
  id: 'application',
});

export const session = applicationBinding.read(sessionSpec);
```

只要 `applicationBinding` 仍然存活，它就是 session 的 owner。仅仅因为 Binding 具有应用生命周期，并不需要使用 `aliveForever`。

React Native 或 Electron renderer Scope 可以接收同一个 Runtime，并解析同一个 keyed Spec：

```tsx
<ViewModelScope runtime={applicationRuntime}>
  <App />
</ViewModelScope>
```

注入 Runtime 后，调用方拥有它，最终也必须负责 dispose。Scope 只 dispose 自己的 Binding，不会 dispose 被注入的 Runtime。

共享只能发生在同一个 Runtime 与 JavaScript realm 内。Electron main 与 renderer 不能共享 Runtime、Binding 或 ViewModel 对象；它们之间应使用窄化的 preload/IPC API 与可序列化数据。

## 5. React Native adapter

在 render 外定义 model 与 Spec，然后用 Scope 包围 React owner 边界。

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
    this.updateState((state) => ({ count: state.count + 1 }), 'counter.increment');
  };
}

const counterSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel());

function Counter(): React.JSX.Element {
  const count = useViewModelSelector(counterSpec, (counter) => counter.state.count);
  const actions = useReadViewModel(counterSpec);

  return (
    <View>
      <Text>Count: {count}</Text>
      <Button title="Increment" onPress={actions.increment} />
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

默认 React Native Scope 只把 `AppState.currentState === 'active'` 视为 active。其他所有状态都会暂停 Runtime。

## 6. Electron renderer adapter

hook 用法相同，但从 Electron 入口导入：

```tsx
import { createRoot } from 'react-dom/client';
import { ViewModelScope } from '@lwjlol/view_model/electron';

createRoot(document.getElementById('root')!).render(
  <ViewModelScope>
    <App />
  </ViewModelScope>,
);
```

默认 renderer 生命周期仅在窗口 focused 且 document 未 hidden 时把 Runtime 视为 active。Electron main 不使用这个 Scope；它使用 `@lwjlol/view_model/core` 与 plain Binding。

## 7. 选择最窄的 hook

```tsx
const wholeViewModel = useViewModel(counterSpec);
const actionsOnly = useReadViewModel(counterSpec);
const count = useViewModelSelector(counterSpec, (counter) => counter.state.count);
```

- `useViewModel` 在 ViewModel 发出任意普通通知时重新 render。
- `useReadViewModel` 保活实例，但不因普通通知重新 render。recycle 改变 generation 时仍会重新 render。
- `useViewModelSelector` 在选中结果按 `Object.is` 或可选自定义 equality function 判断发生变化时重新 render。

不要通过 `useReadViewModel` render 持续变化的 state，否则 UI 会过期。selector 必须纯净，并且可能执行多次。它不能修改 state、启动工作或解析 parent ViewModel 的依赖 getter。

## 8. 理解 owner 规则

同一个 Scope 中的多个 hook 共享一个 Binding owner。卸载一个 hook 会移除它的 listener，但不会释放 Binding 的 owner entry。实例通常会一直保留，直到 Scope 的 Binding 被 dispose 或实例被显式 recycle。

这会产生两个实际结果：

1. 应用根 Scope 适合应用生命周期模块。
2. 需要在卸载时释放的 screen 必须拥有合适的 owner 边界；仅从仍挂载的 Scope 中移除最后一个组件 hook 并不够。

嵌套 Scope 默认继承 parent Runtime，但会创建不同的 Binding。它们的 unkeyed 实例互相隔离。显式 ViewModel type 与 key 相同时，keyed 实例可以跨独立 Spec 共享。builder-only Spec 只有复用同一个私有 token 时才共享，应只把它视为兼容 fallback。

## 9. 重要生命周期限制

- `update(action, mutation)` 把 action 关联到 `mutation` 内发出的通知；它本身不会调用 `notifyListeners`。
- `onCreate` 在首次 acquire 后运行，而不是在 construction 期间运行。
- `onBind` 与 `onUnbind` 描述逻辑 Binding ID，而不是单个 hook。
- Runtime pause 作用于整个 Runtime。继承 Runtime 的嵌套 Scope 不能只暂停自己的 ViewModel。
- Pause 不会冻结 action 或 state change。它调用 `onPause`，并延迟、合并 Binding 与 hook update，直到所有 pause 原因都 resume。
- `recycle` 即使在仍有 owner 使用时也会强制 dispose generation。它是该 Runtime identity 内的全局失效操作，不是局部组件 reset。

继续阅读：

- [ViewModel 与 state](./view-models.md)
- [依赖注入](./dependency-injection.md)
- [身份与生命周期](./identity-and-lifetime.md)
- [测试](./testing.md)
