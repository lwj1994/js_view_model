# AGENTS.md

`js_view_model` 是只面向 React Native 与 Electron App 的 TypeScript 状态管理、
模块组合、依赖注入与自动生命周期框架；不要新增普通 React Web 支持入口。

## 目录

- `src/core/`：ViewModel、Spec、Runtime、Binding、依赖图与生命周期。
- `src/react/`：RN/Electron 共用的内部 React 绑定，不作为公共 Web 入口导出。
- `src/react-native/`：React Native Scope 与 AppState 适配。
- `src/electron/`：Electron renderer Scope 与窗口生命周期适配。
- `scripts/`：构建后 package exports 与 ESM/CJS 身份冒烟验证。
- `tests/`：核心、React 与平台测试。

## 工作规则

- 优先使用稳定的模块级 `ViewModelSpec`，通过 `watch/read` 解析。
- unkeyed 实例在 Binding/Scope 内私有；只有显式 key 才跨 Scope 共享。
- `aliveForever` 必须带显式 key；`recycle` 是影响所有 owner 的强制回收。
- parent ViewModel 通过 getter 和自己的 `viewModelBinding` 解析 child，不长期缓存 child。
- 依赖 getter 仅供 commit 后的 ViewModel action/生命周期使用，不得在 React render 或 selector 中读取。
- React render 只能 `prepare` 纯对象；owner、`onCreate` 与 `onBind` 必须在 commit 后建立。
- 保持 RN/Electron 平台入口，禁止新增 `view_model/react` 或 Web 支持承诺。
- 文档与代码注释优先中文。

## 验证

提交前运行：

```sh
npm run check
npm audit --audit-level=low
```

`npm run check` 会在 build 后同时验证 ESM/CJS 与平台入口的跨条件身份协议。

测试必须保持串行，避免 Runtime 全局计数与生命周期时序互相干扰；根脚本已经使用
`vitest --no-file-parallelism`。
