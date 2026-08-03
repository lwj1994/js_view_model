# React Native Counter

这个最小示例演示：

- 模块级稳定 Spec；
- unkeyed 实例在当前 Scope 内私有共享；
- selector 只订阅 count；
- read hook 只获取 action；
- AppState 自动 pause/resume。

> 需要 v0.1 Alpha 的 `view_model`。本示例只适用于 React Native，不是 React Web 示例。

## App.tsx

```tsx
import { Button, SafeAreaView, Text } from 'react-native';
import { StateViewModel, viewModelSpec } from 'view_model/core';
import { ViewModelScope, useReadViewModel, useViewModelSelector } from 'view_model/react-native';

type CounterState = {
  count: number;
};

class CounterViewModel extends StateViewModel<CounterState> {
  constructor() {
    super({ count: 0 });
  }

  increment = () => {
    this.updateState((current) => ({
      count: current.count + 1,
    }));
  };

  decrement = () => {
    this.updateState((current) => ({
      count: current.count - 1,
    }));
  };
}

// Spec 必须在 render 外稳定存在。
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

把两个 `CounterScreen` 放在同一个 `ViewModelScope` 下，它们会共享这个稳定 unkeyed Spec 的实例。把它们放进两个独立 Scope，则各自拥有 count。

单个 `CounterScreen` 卸载只会移除它的 hook listener；实例由当前 Scope Binding 保留，直到 Scope 自身卸载并 dispose。需要页面离开即释放时，应让页面拥有自己的 `ViewModelScope`。

若确实需要跨 Scope 共享，应使用业务上稳定且可解释的显式 key：

```ts
const sharedCounterSpec = viewModelSpec(() => new CounterViewModel(), { key: 'shared-counter' });
```

不要为了“方便”把页面级实例设为 `aliveForever`。永久实例必须提供 key，并只能通过 Runtime dispose 或 recycle 结束。
