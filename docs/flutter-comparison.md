# Differences from Flutter `view_model`

[简体中文](./zh/flutter-comparison.md) · [Documentation index](./README.md)

This TypeScript package shares the architectural direction of
[`lwj1994/flutter_view_model`](https://github.com/lwj1994/flutter_view_model):
functional modules can be managed ViewModels, bindings own instances,
dependencies resolve lazily through ViewModel getters, and ordinary instances
dispose automatically.

It is not an API port. TypeScript runtime identity, React scheduling, and
React Native/Electron lifecycle constraints require different contracts.

## Concept mapping

| Flutter `view_model`          | TypeScript `view_model`                  | Important difference                                                                     |
| ----------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `class X with ViewModel`      | `class X extends ViewModel`              | TypeScript uses inheritance, not a Dart mixin.                                           |
| `StateViewModel<T>`           | `StateViewModel<TState>`                 | Equality defaults to `Object.is`; there is no global equality configuration.             |
| `ViewModelSpec<T>`            | `ViewModelSpec<T>` / `viewModelSpec()`   | Identity is stable Spec token + key because TypeScript generics do not exist at runtime. |
| `ViewModelBinding` host mixin | `runtime.createBinding()`                | Plain hosts explicitly own and dispose a Binding.                                        |
| Widget mixins                 | Platform `ViewModelScope` + hooks        | Scope maps React commit/unmount to one Binding owner.                                    |
| `watch(spec)`                 | `binding.watch` / `useViewModel`         | Both own; watch also propagates ordinary notifications.                                  |
| `read(spec)`                  | `binding.read` / `useReadViewModel`      | Read still owns and still reacts to generation replacement where adapters require it.    |
| Selector widgets              | `useViewModelSelector`                   | Selector receives the ViewModel; equality defaults to `Object.is`.                       |
| `listenState`                 | `subscribeState`                         | Direct subscription returns cleanup and is not automatically owned by a Binding.         |
| Keyed sharing                 | Explicit key                             | Sharing exists only for the same Spec token + key in one Runtime.                        |
| Child getter DI               | `this.viewModelBinding.read/watch(spec)` | Getter access is forbidden in builders, constructors, React render, and selectors.       |
| `recycle(vm)`                 | `runtime.recycle(vmOrSpec)`              | An unkeyed Spec target can recycle several Binding-private generations.                  |
| Pause/resume providers        | Runtime pause tokens                     | Pause is Runtime-wide, not route/ticker or Scope-local.                                  |

## Identity is Spec token + key

Flutter can use the resolved generic type as part of runtime identity. JavaScript
cannot because TypeScript generic types are erased. This package gives each
base Spec a runtime token:

```ts
const first = viewModelSpec(() => new SessionViewModel(), { key: 'session' });
const second = viewModelSpec(() => new SessionViewModel(), { key: 'session' });

binding.read(first) !== binding.read(second);
```

Use `withKey` when a parameterized variant must preserve the base token:

```ts
const userSpec = viewModelSpec(() => new UserViewModel());
const adaSpec = userSpec.withKey('ada');
const graceSpec = userSpec.withKey('grace');
```

Do not translate Flutter's `T + key` explanation into TypeScript documentation
or code reviews.

## `update` does not notify

Flutter's convenience update API may automatically publish a change. The
TypeScript method has a narrower purpose: it attaches an action value to
notifications emitted synchronously inside the mutation.

```ts
this.update('cart.add', () => {
  this.items.push(item);
  this.notifyListeners();
});
```

Omitting `notifyListeners()` changes the field silently. `StateViewModel`
actions normally use `setState` or `updateState`, which do notify when equality
reports a new snapshot.

## Scope exists because React has render and commit phases

Flutter widget mixins and this package's React Scope/hooks solve similar owner
problems through different host lifecycles. React render can be replayed or
abandoned, so builders may prepare pure objects during render while ownership,
`onCreate`, and `onBind` start only after commit.

Scope is not required for application DI. Electron main, startup code,
background services, and tests use a plain Binding from the same core Runtime.

## APIs intentionally not carried over

This TypeScript package currently has no:

- `tag` or cached lookup API;
- `ViewModelSpec.arg/arg2/arg3/arg4`;
- proxy/override or code-generation annotations;
- `ChangeNotifierViewModel`;
- global `initialize`, `reset`, equality, logging, or error configuration;
- DevTools protocol;
- Flutter route/ticker lifecycle providers;
- Widget mixins.

Do not emulate these with undocumented imports. Build from the currently
exported core and platform APIs, or propose an explicit library change.

## Platform boundary

The TypeScript package serves React Native and Electron only. Electron main,
preload, and renderer remain separate realms; transfer serializable DTOs and
events over IPC. The internal shared React layer is not a public Web entry and
does not imply ordinary React Web, SSR, or RSC support.
