# Vue 3 与 Taro 4

[English](../vue-taro.md)

## 可选入口

同一个包导出 `@lwjlol/view_model/vue` 与 `@lwjlol/view_model/taro-vue`。
两者重新导出 core，Taro 入口还重新导出 Vue 桥接。根入口、core、RN 与 Electron
入口不会导入 Vue 或 Taro。Vue `>=3.3 <4` 和 Taro `>=4 <5` 是由宿主提供的可选 peer。
请使用已配置 `@tarojs/plugin-framework-vue3` 且各 Taro 包版本一致的 Taro 4 项目；
桥接不会配置 Taro 编译器。

```sh
npm install @lwjlol/view_model
```

Vue 入口作为 Taro 的框架桥接，不支持 SSR、React Web 或 React Server Components。
适配测试覆盖 Vue 和 Taro 生命周期契约，不代表所有小程序平台和设备均已实测。

## 页面 setup

将声明放在独立模块中，不在组件 setup 内创建：

```ts
// counter.ts
import { StateViewModel, viewModelSpec } from '@lwjlol/view_model/core';

class Counter extends StateViewModel<Readonly<{ count: number }>> {
  constructor() {
    super({ count: 0 });
  }
  increment() {
    this.updateState((s) => ({ count: s.count + 1 }));
  }
}
export const counterSpec = viewModelSpec(Counter, () => new Counter());
```

```vue
<script setup lang="ts">
import { useTaroViewModelScope, useViewModel } from '@lwjlol/view_model/taro-vue';
import { counterSpec } from './counter';

useTaroViewModelScope();
const counter = useViewModel(counterSpec);
const increment = () => counter.value.increment();
</script>

<template>
  <view>
    <text>{{ counter.state.count }}</text>
    <button @tap="increment">+1</button>
  </view>
</template>
```

在 setup 中同步调用 composable（纯 Vue API 也可在活跃的 Vue effect scope 内使用）。
实例获取与 `onCreate` 发生在 setup 中，与 React 的 commit 订阅不同。构造函数保持纯粹，
资源在 `onCreate` 中创建；依赖 getter 只能用于 action/生命周期，不能用于模板或 selector。

## 响应式访问

- `useViewModel(spec, scope?)` 返回包含原始 ViewModel 的只读浅层 ref。
  通知触发 ref 消费者更新，不会代理类实例。
- `useReadViewModel(spec, scope?)` 忽略普通通知，recycle 后仍替换 ref 的值。
- `useViewModelSelector(spec, selector, equals = Object.is, scope?)` 返回选中值的
  只读浅层 ref；相等判断抑制未改变的选择结果。
- `useViewModelRuntime()` 与 `useViewModelBinding()` 解析当前 owner。

脚本中使用 `.value`，模板自动解包顶层 ref。保留 ref，不缓存 `ref.value`，因为
recycle 会替换实例。selector 应选择普通字段或不可变快照，不要用 `reactive()` 包裹 ViewModel。

## 所有权

`useViewModelScope({ runtime?, isolated? })` 为每个 Vue effect scope 创建一个 Binding，
并向后代提供 runtime。消费组件会自动创建自己的 Binding。没有注入或继承的 runtime 时，
scope 创建并拥有新 runtime。`isolated: true` 禁用继承，外部注入的 runtime 仍归调用方所有。
unkeyed 实例对每个 Binding 私有，显式 key 在同一 runtime 内共享。
向 composable 显式传入 scope 表示有意共享该 scope 的 Binding。

Effect scope 清理时释放 Binding 和自己拥有的 runtime。单个 composable 清理只移除订阅，
owner 在 Binding 销毁前仍保留实例。返回的 scope 还提供幂等 `dispose()` 与 `isDisposed`。
每个 effect scope 只配置一次 scope，并在消费 composable 前配置；选项在其生命周期内固定。

## Taro 生命周期

`useTaroViewModelScope({ runtime?, pauseOnHide? })` 用于页面 setup，额外在 `useUnload`
时释放页面 Binding。页面隐藏保留所有权，也不会暂停共享 runtime。子组件 Binding 在 Vue
卸载时释放。

独立页面可用 `useTaroViewModelScope({ pauseOnHide: true })` 创建独立 runtime，并将
hide/show 映射为 pause/resume。该选项不能同时传入 runtime，否则抛错，避免隐藏页面暂停兄弟页面。

需要应用级共享时，在 composition root 创建并导出一个 runtime：

```ts
// runtime.ts
import { ViewModelRuntime } from '@lwjlol/view_model/core';
export const appRuntime = new ViewModelRuntime();
```

```ts
// app setup
import { onScopeDispose } from 'vue';
import { useTaroAppLifecycle } from '@lwjlol/view_model/taro-vue';
import { appRuntime } from './runtime';

useTaroAppLifecycle(appRuntime);
onScopeDispose(() => appRuntime.dispose());
```

每个页面调用 `useTaroViewModelScope({ runtime: appRuntime })`。即使 Taro 平台不保留
app 到 page 的 Vue provide/inject 关系，显式注入也能工作。应用生命周期只在 app setup
注册一次；清理时移除自己的暂停 token，不影响其他 owner 的 token。暂停影响整个 runtime，
会合并 Binding 通知，不会停止 action 或异步工作。

## 验证

串行测试覆盖原始 ref、selector、read 模式、重复 recycle、暂停恢复、组件实例身份与清理、
页面卸载、独立页面显隐和应用暂停 token。构建保留 ESM/CJS 中共享的 core 与 Vue 入口身份。
生产接入前仍需针对业务项目实际目标端构建，并在设备上验证导航、前后台切换与资源释放。
