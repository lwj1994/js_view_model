# 核心概念

> 本文对应 v0.1 Alpha。`view_model` 仅服务 React Native 与 Electron App，不支持普通 Web。

## Runtime、Scope、Binding 与 Spec

四个概念共同决定实例身份与生命周期：

1. `ViewModelRuntime` 保存实例、依赖图与生命周期状态，是最大的共享边界。
2. `ViewModelScope` 是 React 树中的 owner 边界。每个 Scope 有自己的 binding。
3. `ViewModelBinding` 负责通过 `watch/read` 获取实例、建立引用和在销毁时释放引用。
4. `ViewModelSpec` 描述如何创建 ViewModel，以及它是否有 key、是否永久存活等身份信息。

`ViewModelScope` 默认可继承父 Scope 的 Runtime，但会创建新的 Binding。因此：

- 同一 Scope 内，稳定的 unkeyed Spec 会命中同一实例。
- 不同 Scope 的 unkeyed Spec 互相隔离。
- 同一 Runtime 中，带相同显式 key 的 Spec 可以跨 Scope 共享。
- 两个独立 Runtime 不会共享任何实例。

## 稳定 Spec

Spec 是身份的一部分，不只是 factory 包装。推荐模块顶层常量：

```ts
export const cartSpec = viewModelSpec(() => new CartViewModel());
```

以下写法会在每次 render 中创建新身份，应避免：

```tsx
function Cart() {
  const cart = useViewModel(viewModelSpec(() => new CartViewModel()));

  // ...
}
```

动态参数通常应进入显式 key，或者先由业务层形成稳定 Spec。不要用对象字面量、随机数或随 render 变化的值作为 key。

## unkeyed、keyed 与 aliveForever

### unkeyed

unkeyed 实例默认属于创建它的 Scope 私有空间，适合页面、窗口局部功能或可重复挂载的 UI 子树。

### keyed

显式 key 让身份在 Runtime 内稳定，可用于多个 Scope 共享的登录会话、账户缓存或设备连接：

```ts
const sessionSpec = viewModelSpec(() => new SessionViewModel(), { key: 'primary-session' });
```

keyed 不等于永久存活。没有 owner 时，它仍可按正常策略释放。

### aliveForever

`aliveForever` 表示实例不因普通 owner 引用归零而自动释放。它必须有显式 key：

```ts
const telemetrySpec = viewModelSpec(() => new TelemetryViewModel(), {
  key: 'telemetry',
  aliveForever: true,
});
```

永久实例仍应通过 Runtime dispose 或显式 recycle 结束。它不是绕开生命周期设计的默认选项。

## watch 与 read

`watch` 与 `read` 都会：

- 按 Spec 解析或创建实例；
- 建立当前 Binding → ViewModel 的 owner 引用；
- 在 Binding dispose 时释放引用；
- 建立 parent → child 生命周期边；
- 感知实例被 dispose/recycle。

只有 `watch` 会订阅 ViewModel 自身更新并向 owner 传播。`read` 适合 action 调用、命令式协作或不需要随 child 更新的依赖。

在 React 中，首个 hook 的 commit 订阅会让当前 Scope Binding acquire；单个 hook cleanup 只退订自己的 listener，不释放 Binding owner。实例会保留到 Scope dispose，或被显式 recycle。因此“组件暂时不再读取”不等于“立即销毁实例”。

React hooks 对应关系：

```ts
const whole = useViewModel(spec);
const commands = useReadViewModel(spec);
const title = useViewModelSelector(spec, (vm) => vm.state.title);
```

selector 可提供自定义 `equals`，只有选中结果发生有意义变化时才刷新组件。

## 父子 ViewModel 与 getter DI

不要在构造器中直接拉取依赖。ViewModel 完成创建和绑定后，通过 getter 按需解析：

```ts
const authSpec = viewModelSpec(() => new AuthViewModel(), { key: 'auth' });

class OrdersViewModel extends ViewModel {
  private get auth() {
    return this.viewModelBinding.read(authSpec);
  }

  async refresh() {
    const token = await this.auth.requireToken();
    // ...
  }
}
```

一旦 parent 解析 child，Runtime 会记录 parent generation → child generation 的 owner 边。外部 Scope 暂时减少引用时，child 仍由 parent 保活。

依赖 getter 是 ViewModel 内部的惰性 DI 入口，不是 UI 的组合读取 API。只能从 commit
后的 ViewModel action、生命周期回调或内部协作代码访问；不要从组件 render、JSX、
`useViewModelSelector` 的 selector 或其他 render 派生计算中读取。UI 需要的数据应由
parent 汇总到自己的字段/state，再由 hook 订阅。

依赖图必须无环。直接或间接循环都应改为：

- 把共同能力提取成第三个 ViewModel；
- 通过事件或普通函数传递结果；
- 由更高层 coordinator 单向编排。

## generation

同一身份被 recycle 后再次解析，得到的是新的 generation。旧 generation 的 Binding、依赖树和通知不能污染新实例。业务代码不应长期保存旧 ViewModel 引用；应通过稳定 Spec 与当前 Binding 重新解析。

## recycle 的影响范围

`recycle` 会强制结束目标 generation，即使它仍被多个 owner 使用。对于跨 Scope keyed 实例，这意味着所有调用方都会受到影响。

更安全的“重建”方式通常是：

1. 生成新的、业务可解释的 key；
2. 让新 Scope/owner 解析新 Spec；
3. 等旧 owner 自然释放旧 generation。

只有注销账户、主动断开设备等全局失效动作，才适合 recycle 共享实例。
