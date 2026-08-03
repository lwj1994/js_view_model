# React Native 集成

> `view_model/react-native` 处于 v0.1 Alpha，仅用于 React Native App。

## 顶层 Scope

通常在应用根组件放置一个 Scope：

```tsx
import { ViewModelScope } from 'view_model/react-native';

export default function App() {
  return (
    <ViewModelScope>
      <RootNavigator />
    </ViewModelScope>
  );
}
```

嵌套 Scope 默认继承 Runtime，但拥有新的 Binding：

- unkeyed Spec 在不同 Scope 中隔离；
- keyed Spec 可以在这些 Scope 间共享；
- Scope 卸载时只释放它拥有的 source，不会错误销毁仍由其他 Scope/parent 保活的实例。

如果一个 React Native surface、测试用例或独立业务容器需要完全隔离，可传入独立 `ViewModelRuntime`。

## AppState

默认使用 React Native `AppState`。active 时 Scope resume，其他状态 pause。

测试或特殊宿主可以注入兼容对象：

```tsx
const appState = {
  currentState: 'active',
  addEventListener(type, listener) {
    // 注册宿主生命周期。
    return { remove() {} };
  },
};

<ViewModelScope appState={appState}>
  <App />
</ViewModelScope>;
```

## hooks

### useViewModel

```tsx
const counter = useViewModel(counterSpec);
```

组件订阅整个 ViewModel。任意普通通知都可能刷新组件，适合小型 VM 或组件确实依赖多个字段的场景。

### useReadViewModel

```tsx
const counter = useReadViewModel(counterSpec);

return <Button onPress={counter.increment} title="加一" />;
```

组件仍然拥有并保活实例，但不因 VM 普通通知刷新。适合只拿 action。

### useViewModelSelector

```tsx
const total = useViewModelSelector(cartSpec, (cart) => cart.state.total);
```

只有 selector 结果变化时刷新。第三个 `equals` 参数可处理结构化结果：

```tsx
const summary = useViewModelSelector(
  cartSpec,
  (cart) => ({ count: cart.state.count, total: cart.state.total }),
  (a, b) => a.count === b.count && a.total === b.total,
);
```

selector 应保持纯净，不要在其中发请求、修改 VM 或创建不稳定订阅。

## 页面 focus

React Navigation 中，页面 blur 后通常仍处于 mounted 状态。若某个页面 VM 在 blur 时需要暂停，有两种做法：

- 让该页面拥有独立 Scope，并把导航 focus 转换为该 Scope 的生命周期；
- 把“页面是否可交互”作为普通业务输入交给 ViewModel。

不要把 blur 当 dispose。返回页面时通常应 resume 原 generation，而不是无条件重建。

页面级 Scope 可以通过 `lifecycle` 覆盖默认 AppState source；通常让应用根 Scope
继续处理 AppState，再由嵌套页面 Scope 处理导航 focus：

```tsx
<ViewModelScope lifecycle={navigationLifecycle}>
  <Screen />
</ViewModelScope>
```

`navigationLifecycle` 实现与 Electron lifecycle source 相同的结构：提供
`isActive()`，并由 `subscribe(listener)` 返回 cleanup。多个 source 使用独立 token
聚合，页面重新 focus 不会错误解除应用后台产生的 pause。

## 示例

完整 Counter 示例见 [examples/react-native-counter](../examples/react-native-counter/README.md)。
