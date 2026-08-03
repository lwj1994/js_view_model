# React Native 集成

[English](../react-native.md) · [文档索引](./README.md)

> `view_model/react-native` 是 v0.1 alpha 的公开 React Native 入口。它面向 React Native 应用，不适用于 React DOM 或通用 Web rendering。

应用 DI 图属于 `ViewModelRuntime`。`ViewModelScope` 是该对象图的 React Native owner adapter：它创建 `ViewModelBinding`、将 platform lifecycle event 连接到 Runtime，并向 hooks 提供 Runtime 与 Binding。

## 公开入口

从 platform entry 导入 React Native API 与 core API：

```ts
import {
  StateViewModel,
  ViewModel,
  ViewModelRuntime,
  ViewModelScope,
  useReadViewModel,
  useViewModel,
  useViewModelSelector,
  viewModelSpec,
} from 'view_model/react-native';
```

本库有意不提供公开 `view_model/react` 入口。共享 React implementation 是内部实现，不承诺支持 React Web、SSR、React Server Components 或 browser hydration。

## 先选择 Runtime 边界

对于只有一个 React root 的简单应用，root Scope 可以创建并持有自己的 Runtime：

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

真正 unmount 时，Scope 会 dispose 其 Binding，然后 dispose 自己创建的 Runtime。

如果 React 与非 React owner 需要共享应用级 DI，应在 composition root 创建 Runtime 并注入：

```tsx
import { ViewModelRuntime, ViewModelScope } from 'view_model/react-native';

export const applicationRuntime = new ViewModelRuntime();

export default function App() {
  return (
    <ViewModelScope runtime={applicationRuntime}>
      <RootNavigator />
    </ViewModelScope>
  );
}
```

注入的 Runtime 由调用方持有。Scope 会释放自己的 Binding，但不会 dispose 该 Runtime。test、embedded React Native surface 与显式 application shutdown path 必须自行 dispose 它。

这样，bootstrap Binding、background coordinator 与 React Scope 就能参与同一个应用对象图：

```ts
const bootstrap = applicationRuntime.createBinding({ id: 'application-bootstrap' });
const session = bootstrap.read(sessionSpec);

await session.restore();
bootstrap.dispose();
```

若要与 React Scope 共享 `sessionSpec`，它必须有显式 key。即使 Binding 使用同一个 Runtime，unkeyed Spec 仍对各 Binding 私有。

## 定义稳定模块

Spec token 参与 runtime identity，因此 Spec 必须是模块顶层的稳定对象：

```ts
import { StateViewModel, viewModelSpec } from 'view_model/react-native';

interface CounterState {
  readonly count: number;
}

class CounterViewModel extends StateViewModel<CounterState> {
  public constructor() {
    super({ count: 0 });
  }

  public increment = (): void => {
    this.updateState((current) => ({ count: current.count + 1 }), 'counter.increment');
  };
}

export const counterSpec = viewModelSpec(() => new CounterViewModel(), {
  debugLabel: 'CounterViewModel',
});
```

不要在 component 或 hook 内创建 `counterSpec`。新的 Spec 会创建新 token，因此也会形成新 identity。

## 在 Scope 内使用 hooks

### `useViewModel`

当 component 读取较宽范围的 ViewModel 数据，并且应在每次普通通知后更新时，使用 `useViewModel`：

```tsx
import { Button, Text, View } from 'react-native';
import { useViewModel } from 'view_model/react-native';

function CounterPanel() {
  const counter = useViewModel(counterSpec);

  return (
    <View>
      <Text>{counter.state.count}</Text>
      <Button title="Increment" onPress={counter.increment} />
    </View>
  );
}
```

hook 会在 render 中 prepare，并在 commit 中 acquire Scope Binding。它订阅普通 ViewModel 通知与 generation replacement。

### `useReadViewModel`

command-only component 应使用 `useReadViewModel`：

```tsx
import { Button } from 'react-native';
import { useReadViewModel } from 'view_model/react-native';

function IncrementButton() {
  const counter = useReadViewModel(counterSpec);
  return <Button title="Increment" onPress={counter.increment} />;
}
```

该 hook 仍会解析、acquire 并保活 generation。它忽略普通 ViewModel 通知，但 force recycle 会改变 lifecycle snapshot，并使其解析 replacement generation。

### `useViewModelSelector`

当 component 只需要大型 model 的一部分时，优先使用 `useViewModelSelector`：

```tsx
const count = useViewModelSelector(counterSpec, (counter) => counter.state.count);
```

默认 equality 是 `Object.is`。结构化 selection 应传第三个参数：

```tsx
const summary = useViewModelSelector(
  cartSpec,
  (cart) => ({
    count: cart.state.items.length,
    total: cart.state.total,
  }),
  (previous, next) => previous.count === next.count && previous.total === next.total,
);
```

selector 会作为 React snapshot/render 工作的一部分执行，因此必须保持纯净。它可以读取 selected ViewModel 已经暴露的字段，但不能：

- 修改 state；
- 启动异步工作；
- 安装 subscription；
- 解析 parent ViewModel 的 child dependency getter。

如果 UI 需要 child-derived data，应让 parent ViewModel 将这些数据发布在自己的 state 或字段上。

### 高级 context hooks

`useViewModelRuntime()` 与 `useViewModelBinding()` 会向 infrastructure integration 暴露当前 context 对象。普通 component 代码应优先使用上面的三个 resolution hook。不要在 render 中调用 imperative Binding method。

## Scope 持有什么

每个 Scope 都会创建一个稳定 Binding。nested Scope：

- 默认复用 parent Runtime；
- 创建不同 Binding；
- 将 unkeyed Spec 与 parent Scope 隔离；
- 可以通过共同 Runtime 共享 keyed Spec。

单个 hook cleanup 只会移除该 hook 的 listener，不会释放 Binding 已 acquire 的 entry。generation 会一直由 owner 持有到 Scope dispose 或 generation 被强制 recycle。

因此，Scope 是显式 React owner 边界，不是逐 component service locator。

若要同时隔离 identity 与 pause state，应向 nested Scope 注入不同 Runtime：

```tsx
const editorRuntime = new ViewModelRuntime();

<ViewModelScope runtime={editorRuntime}>
  <EditorSurface />
</ViewModelScope>;
```

创建 `editorRuntime` 的代码必须在 surface 永久结束时 dispose 它。

## AppState 集成

React Native Scope 默认适配 `AppState`：

| AppState 值                                 | Runtime 状态 |
| ------------------------------------------- | ------------ |
| `active`                                    | active       |
| 其他所有值，包括 `inactive` 与 `background` | paused       |

source 使用一个稳定 pause token。若多个 lifecycle source pause 同一个 Runtime，只有移除所有 token 后才会 resume。

Pause 是 Runtime-wide 的。它会对所有已 activate generation 调用 `onPause`/`onResume`，并延迟 Binding-delivered React update。它不会停止 action、state mutation 或 direct `subscribe` callback。

test 与自定义 React Native host 可以注入本库使用的最小 AppState shape：

```tsx
const testAppState = {
  currentState: 'active',
  addEventListener(_type: 'change', listener: (state: string) => void) {
    appStateListeners.add(listener);
    return {
      remove() {
        appStateListeners.delete(listener);
      },
    };
  },
};

<ViewModelScope appState={testAppState}>
  <Application />
</ViewModelScope>;
```

## 自定义 lifecycle source

`ViewModelScope` 接受符合下列 contract 的 `lifecycle` 对象：

```ts
interface ViewModelLifecycleSource {
  isActive(): boolean;
  subscribe(listener: (active: boolean) => void): () => void;
}
```

显式 `lifecycle` 会替代该 Scope 默认的 AppState source；两者不会自动组合。需要同时考虑两个条件的 custom source 必须自行组合。

```tsx
const lifecycle = {
  isActive: () => applicationActive && navigationFocused,
  subscribe(listener: (active: boolean) => void) {
    const emit = () => listener(applicationActive && navigationFocused);
    const removeAppState = subscribeToAppState(emit);
    const removeFocus = subscribeToNavigationFocus(emit);

    return () => {
      removeFocus();
      removeAppState();
    };
  },
};
```

installation failure 会被回滚：adapter 会在重新抛出错误前移除自己的 pause token。返回的 cleanup 必须取消所有 native listener。

## Navigation focus 不等于 dispose

React Navigation 通常会让 blurred screen 保持 mounted。除非业务模型确实需要新的 owner 边界，否则 blur 不应被视为 generation dispose。

这里存在重要的 Runtime 级影响：若将 navigation-focus lifecycle 赋给一个共享 application Runtime 的 nested Scope，该 screen blur 时会 pause 整个 application Runtime，而不只是该 Scope。

应从下列设计中明确选择：

1. 当只应改变 screen-specific work 时，保留一个 application Runtime，并将 screen focus 作为普通 ViewModel input。
2. 当 screen 的整个对象图应独立 pause 时，为它提供独立 Runtime。
3. 只有 screen blur 本就应成为 application-wide pause condition 时，才使用 shared Runtime navigation lifecycle。

返回一个 blurred-but-mounted screen 时，通常应 resume 同一 generation。不要只为表达 focus change 而 recycle。

## 应用全局模块

需要由多个 Scope 或 plain Binding owner 共享的 module 应使用显式 key：

```ts
export const sessionSpec = viewModelSpec(() => new SessionViewModel(), {
  key: 'primary-session',
  debugLabel: 'SessionViewModel',
});
```

该 module 只在提供给这些 owner 的 `applicationRuntime` 内是应用全局的。另一个 Runtime 会使用相同 Spec 与 key 解析出另一个 generation。

`aliveForever` 是可选项，并且只要 application owner Binding 仍存在，通常没有必要使用。若使用，它必须有显式 key，并且仍会在 recycle 或 Runtime dispose 时结束。

## React render safety

hooks 可能在 render 期间执行 Spec builder 与 ViewModel constructor。二者都必须保持纯净。subscription 与 native resource 应放到 `onCreate`：

```ts
class NetworkViewModel extends ViewModel {
  protected override onCreate(): void {
    const unsubscribe = networkStatus.subscribe((status) => {
      this.handleStatus(status);
    });

    this.addDispose(unsubscribe);
  }

  private handleStatus(_status: NetworkStatus): void {
    this.notifyListeners('network.status');
  }
}
```

被放弃的 render 不会调用 `onCreate`，因为没有 Binding commit 该 generation。

## StrictMode

开发环境中的 StrictMode 可能使用 `setup -> cleanup -> setup` 探测 effect。Scope dispose 与 lifecycle-token release 会延迟到可取消的 microtask，使对应 setup 能保留当前 Binding 与 inactive state。

被放弃的 render 仍可能多次求值 constructor。业务代码不能将 constructor 次数当成 lifecycle event。

## 测试

component test 应：

- 需要隔离时，每个 test 创建 fresh Runtime；
- 注入确定性的 AppState 或 lifecycle source；
- 用 platform `ViewModelScope` 包裹 tested tree；
- dispose 注入的 Runtime 前先 unmount tree；
- 串行运行本仓库测试。

非 React module test 通常更适合 plain Binding：

```ts
const runtime = new ViewModelRuntime();
const binding = runtime.createBinding({ id: 'counter-test' });

const counter = binding.read(counterSpec);
counter.increment();

binding.dispose();
runtime.dispose();
```

## 检查清单

- 从 `view_model/react-native` 导入，永远不要使用 `view_model/react`。
- 明确 Runtime 由 Scope 持有还是应用持有。
- 使用一个共享 Runtime 与显式 key 实现应用全局 DI。
- 将 Scope 视为一个 React owner Binding，而不是 DI 容器。
- 在模块顶层保持 Spec 稳定。
- 窄范围 rendering 使用 selector，command 使用 `useReadViewModel`。
- builder、constructor 与 selector 必须保持纯净。
- lifecycle pause 会影响整个 Runtime。
- 所有注入的 Runtime 都应在其 owner Binding 结束后显式 dispose。

完整示例见 [examples/react-native-counter](../../examples/react-native-counter/README.md)。
