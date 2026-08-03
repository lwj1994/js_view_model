# 生命周期与 StrictMode

> v0.1 Alpha；仅适用于 React Native 与 Electron App。

## 实例生命周期

典型流程：

```text
稳定 Spec
  → render 阶段准备
  → 首个 hook commit 订阅后由 Scope Binding acquire / bind
  → Binding owner 引用与 parent → child 边保活
  → 平台 inactive 时 pause
  → 平台 active 时 resume
  → 单个 hook cleanup 时只退订 listener
  → Scope cleanup 时 dispose Binding / release
  → 最后一个 owner Binding 离开
  → dispose
```

构造失败、依赖环或 key 约束失败时，Runtime 必须回滚本次暂存创建，不能留下半初始化 generation。

## render 与 commit 分离

React render 必须保持纯净。render 可能被放弃、重放或并发执行，因此以下行为不能在 render 中正式提交：

- 增加 owner 引用；
- 触发业务 `onBind`；
- 建立不可回滚的 parent → child 边；
- 启动计时器、网络连接或原生订阅。

hooks 可以在 render 中计算稳定的解析计划，但只有 commit 后才正式 acquire。组件从未 commit 时，不应留下已绑定实例。

未被 commit acquire 的 provisional generation 会在当前任务结束后自动清扫。若并发
render 在清扫后才提交，hook 会依据 generation snapshot 重新解析并同步刷新，不会把
被放弃 render 的实例永久留在共享 Runtime 中。

`binding.prepare(spec)` 可能运行 Spec builder 与 ViewModel 构造器，因此二者也属于纯 render 路径。构造器只应初始化内存字段；计时器、网络、IPC、文件句柄和原生订阅必须推迟到 commit 后的生命周期，并注册对应 cleanup。

这里的 render-safe 只覆盖 Spec builder、构造器以及 parent 自身字段/state 的读取。
parent 的依赖 getter 会调用 `viewModelBinding.read/watch`，属于 commit 后的内部协作，
不可在组件 render、JSX 或 selector 中展开；否则 child 会在 render 阶段被解析。

## StrictMode

开发环境的 StrictMode 会额外调用 render，并可能执行 effect 的 setup → cleanup → setup，用来发现不纯 render 与缺少 cleanup 的 effect。

`view_model` 对此采用两条约束：

1. render 准备不等同于正式 owner；只有 hook commit 订阅后，Scope Binding 才 addRef/bind。
2. 单个 hook cleanup 只退订 listener，不减少 Binding owner；Scope cleanup 对 Binding 的 dispose 留出一次可取消的延迟窗口，同一次 StrictMode 探测中的重新挂载会取消释放。

因此业务 ViewModel 不应自行用“是否执行了两次构造”推断生产行为。副作用仍应放在明确的生命周期回调中，并保证 pause/resume 与 dispose 幂等。

## bind、pause、resume 与 dispose

- **bind**：实例获得第一个有效 owner source 时进入绑定状态。
- **pause**：应用、窗口或 Scope 暂时不可交互，但实例仍存在。
- **resume**：暂停原因全部解除后恢复。
- **dispose**：当前 generation 永久结束，必须释放计时器、订阅、文件句柄和原生资源。

多个 Scope 或 parent 可以同时拥有同一 keyed 实例。单个 source 离开不应提前触发最终 unbind/dispose；最后一个 source 离开才可释放。

pause 也可能有多个来源，例如 React Native AppState 与上层手动暂停。每个 source 使用独立且稳定的 pause token：任一 token 仍处于 inactive，Runtime 就保持 paused；source cleanup 只移除自己的 token，不能意外唤醒其他 source。实现与业务回调都不应假设一次 resume 就能抵消所有 pause source。

## React Native

默认适配 `AppState`：

- `active` → resume；
- `inactive`、`background` 及其他非 active 状态 → pause。

页面失焦不等于组件卸载。如果使用 React Navigation，并希望页面被遮挡时暂停，应把导航 focus 状态转换为 Scope 生命周期源，而不是依赖 unmount。

## Electron renderer

默认窗口生命周期把以下条件同时满足视为 active：

- window 处于 focus；
- document visibility 不是 hidden。

blur 或 hidden 会 pause；重新 focus 且 visible 才 resume。窗口关闭导致 React tree 卸载时，Scope 会 dispose Binding 并统一 release。

Electron main 没有 React commit，也没有 DOM visibility。它应使用 plain `ViewModelBinding`，并在服务停止、窗口协调器退出或 app shutdown 时显式 dispose Binding/Runtime。

## recycle

recycle 会越过普通 owner 引用，强制 dispose 某个 generation。它可能在仍挂载的组件中触发生命周期变化，也可能让 parent 的 getter 下一次解析到新 generation。

Runtime 会先完成旧实例及其零 owner 独占依赖树的 dispose，再通知仍存活的 owner
解析新 generation，避免新旧实例短暂同时占用同一个 IPC、端口或原生资源。

调用前确认：

- 实例是否使用显式 key 跨 Scope 共享；
- 是否有 parent → child 边；
- 是否仍有异步任务持有旧引用；
- 所有调用方是否都接受同时失效。

如果答案不明确，请换用新 key，而不是 recycle。
