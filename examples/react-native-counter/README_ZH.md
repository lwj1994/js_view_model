# React Native Counter

[English](./README.md)

这个最小示例演示：

- 模块级稳定 Spec；
- 一个 unkeyed 实例在 Scope Binding 内私有共享；
- selector 只按一个 state 字段刷新；
- read hook 只用于取得 action；
- React Native `AppState` 自动驱动 Runtime pause/resume。

> 本示例需要当前正式版 `view_model` API。它只适用于 React Native 应用，
> 不适用于 React Web。

以下 `App.tsx` 文件名仅用于标记示意代码片段。此目录不包含完整可运行的 React Native
项目或原生构建配置。

## 所有权模型

`ViewModelRuntime` 是模块共享与依赖注入边界。`ViewModelScope` 是它的 React owner
adapter：Scope 向 hooks 提供一个稳定 Binding，并把 React commit/unmount 映射为
所有权。Scope 本身不是 DI 系统；非 React 模块可以使用同一 Runtime 的 plain Binding。

未传入 `runtime` prop 时，根 Scope 会创建并拥有自己的 Runtime。注入的 Runtime 始终
由调用方拥有，必须在真实的应用或测试关闭边界显式 dispose。

## `App.tsx`

```tsx
import { Button, SafeAreaView, Text } from 'react-native';
import { StateViewModel, viewModelSpec } from '@lwjlol/view_model/core';
import {
  ViewModelScope,
  useReadViewModel,
  useViewModelSelector,
} from '@lwjlol/view_model/react-native';

type CounterState = Readonly<{
  count: number;
}>;

class CounterViewModel extends StateViewModel<CounterState> {
  public constructor() {
    super({ count: 0 });
  }

  public readonly increment = (): void => {
    this.updateState((current) => ({
      count: current.count + 1,
    }));
  };

  public readonly decrement = (): void => {
    this.updateState((current) => ({
      count: current.count - 1,
    }));
  };
}

// Keep the Spec stable and outside React render.
const counterSpec = viewModelSpec(() => new CounterViewModel());

function CounterScreen() {
  const count = useViewModelSelector(counterSpec, (counter) => counter.state.count);
  const counter = useReadViewModel(counterSpec);

  return (
    <SafeAreaView>
      <Text accessibilityRole="header">Count: {count}</Text>
      <Button title="-1" onPress={counter.decrement} />
      <Button title="+1" onPress={counter.increment} />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <ViewModelScope>
      <CounterScreen />
    </ViewModelScope>
  );
}
```

selector 会 watch counter，但只有 `state.count` 变化时才重新 render。
`useReadViewModel` 拥有同一实例，让按钮能够调用 action，又不会因为普通 ViewModel
通知而重新 render。

Spec builder 与构造器必须保持纯净。React 可能在最终未 commit 的 render 中执行它们；
计时器、请求、原生订阅和其他受管资源应在 `onCreate` 中启动，再通过 `addDispose` 注册
清理，或在 `onDispose` 中释放。

## Scope 身份

同一个 `ViewModelScope` 下的两个 `CounterScreen` 会通过同一 Binding 解析这个稳定的
unkeyed Spec，因此共享同一个 count。把它们放到两个不同 Scope 下，即使这些 Scope
继承同一个 Runtime，每个 Scope Binding 也会得到自己的 unkeyed generation。

确实需要跨 Scope 共享时，在模块级创建稳定的 keyed variant：

```ts
const sharedCounterSpec = counterSpec.withKey('shared-counter');
```

key 允许同一 Runtime 中的多个 Binding 共享一个 generation，但不会保活它。不要把
页面局部状态设为 `aliveForever`。永久实例必须带显式 key，并且只能通过 Runtime dispose
或强制 recycle 结束。

## AppState 生命周期

React Native Scope 默认使用 `AppState`：

- `active` 恢复 Runtime；
- `inactive`、`background`、`null` 及其他状态暂停 Runtime。

Pause/resume 作用于整个 Runtime，而不只作用于提供生命周期源的 Scope。因此，共享父级
Runtime 的嵌套 Scope 无法只暂停自己的 ViewModel。需要独立暂停语义时应使用独立
Runtime；若该 Runtime 是注入的，还必须显式 dispose。

`lifecycle` prop 会替换默认 AppState source。若某个 screen 的独立 Runtime 同时受
AppState 与导航 focus 控制，应提供一个组合这两个条件的自定义 lifecycle source。

## 生命周期说明

- 单个 hook cleanup 只移除该 hook 的订阅，不释放 Scope Binding 的 owner entry。
- 根 Scope 会持续拥有 counter generation，直到 Scope 卸载或 generation 被 recycle。
- 若页面真正 unmount 时必须释放局部 unkeyed 模块，应让该页面拥有自己的嵌套 Scope。
- Screen blur 不等于 dispose。已挂载页面需要感知 focus 时，应显式建模 focus，或提供
  经过设计的 lifecycle source。
