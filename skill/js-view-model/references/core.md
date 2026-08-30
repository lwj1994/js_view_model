# Core architecture and API

Use this reference for TypeScript core modules, application-wide DI, identity,
ownership, notifications, and lifecycle.

## Contents

- [Supported entries](#supported-entries)
- [Architecture model](#architecture-model)
- [ViewModel styles](#viewmodel-styles)
- [Spec and identity](#spec-and-identity)
- [Runtime and Binding](#runtime-and-binding)
- [Advanced cached and tag lookup](#advanced-cached-and-tag-lookup)
- [Binding-owned listeners](#binding-owned-listeners)
- [Application-wide DI](#application-wide-di)
- [Parent-child module composition](#parent-child-module-composition)
- [Notifications](#notifications)
- [Lifecycle and resources](#lifecycle-and-resources)
- [Pause and resume](#pause-and-resume)
- [Recycle](#recycle)
- [Errors and unsupported APIs](#errors-and-unsupported-apis)

## Supported entries

```ts
import {
  StateViewModel,
  ViewModel,
  ViewModelBinding,
  ViewModelRuntime,
  ViewModelSpec,
  type ViewModelCacheLookup,
  type ViewModelCacheTarget,
  type ViewModelType,
  viewModelSpec,
} from '@lwjlol/view_model/core';
```

`@lwjlol/view_model` is an alias of the core entry. React Native and Electron platform
entries re-export core. There is no public `@lwjlol/view_model/react` entry.

## Architecture model

```text
Application composition root
└── ViewModelRuntime (DI sharing, generations, graph, pause state)
    ├── plain ViewModelBinding (bootstrap/service/Electron main/test)
    ├── React Scope Binding (screen/window/tree owner)
    └── managed ViewModel generation
        └── private dependency Binding
            └── lazily resolved child generations
```

The Runtime is the DI sharing boundary. A Binding is an owner. A React Scope
creates a Binding and exposes it to hooks; it does not replace the Runtime or
make DI UI-only.

## ViewModel styles

Use `ViewModel` for command modules, services, repositories, coordinators, or
mutable fields. Notify explicitly:

```ts
class ConnectionViewModel extends ViewModel {
  public status: 'idle' | 'connected' = 'idle';

  public connect(): void {
    this.update('connection.connect', () => {
      this.status = 'connected';
      this.notifyListeners();
    });
  }
}
```

`update(action, mutation)` does not notify automatically. It only supplies the
action used by nested `notifyListeners()` calls and restores the previous action
after the synchronous mutation returns.

Use `StateViewModel<TState>` for immutable snapshots:

```ts
type CartState = Readonly<{ ids: readonly string[]; total: number }>;

class CartViewModel extends StateViewModel<CartState> {
  public constructor() {
    super({ ids: [], total: 0 });
  }

  public add(id: string, price: number): boolean {
    return this.updateState(
      (state) => ({ ids: [...state.ids, id], total: state.total + price }),
      'cart.add',
    );
  }
}
```

`setState` and `updateState` return `false` without notifying when equality says
the snapshots are equal. Equality defaults to `Object.is`; pass a constructor
equality function only when the state model requires one.

`subscribe` observes ViewModel versions. `subscribeState` observes
`{ previous, current }` state diffs. Both return an unsubscribe callback and are
direct subscriptions, not Binding-owned subscriptions.

## Spec and identity

Prefer an explicit ViewModel class as the runtime identity and declare Specs
once at module scope:

```ts
export const cartSpec = viewModelSpec(CartViewModel, () => new CartViewModel(), {
  debugLabel: 'Cart',
});
```

Inside one Runtime, explicit identity is the ViewModel type plus its effective
key:

- Omitting `key` selects a Binding-private effective key. The same explicit
  type resolves one generation per Binding, including through separate explicit
  Spec objects.
- An explicit key selects one generation per type + key across Bindings in the
  same Runtime.
- Independent explicit Specs with the same type and key share. The builder that
  wins the first cache miss constructs the generation, so do not give that
  identity conflicting builders or lifetime options.
- The winning explicit-type builder must return that type or a subclass.
  Abstract ViewModel identity classes with protected constructors are valid.
- `withKey(key)` preserves the explicit type identity while deriving a keyed
  variant.
- Independent Runtimes never share an object.
- A key does not retain an instance. `aliveForever` controls zero-owner
  retention and requires an explicit key.

The builder-only form `viewModelSpec(() => new CartViewModel(), options)` is a
compatibility fallback. Every builder-only Spec receives an independent token;
separate builder-only declarations do not share even when their class and key
look identical. `withKey` preserves that fallback token.

TypeScript generic parameters are erased, so only the explicit class argument
provides type identity at runtime. `debugLabel` and `tag` are metadata and never
participate in identity.

Use a stable primitive or symbol key with business meaning. Keep Specs at module
scope to avoid render-time allocations and keep builders/options stable. Do not
use random or render-varying keys.

## Runtime and Binding

Create a Runtime at an intentional isolation boundary:

```ts
const runtime = new ViewModelRuntime();
const binding = runtime.createBinding({
  id: 'sync-service',
  onUpdate: () => scheduleSync(),
});

const service = binding.read(serviceSpec);

binding.dispose();
runtime.dispose();
```

`read(spec)` resolves and owns the instance but ignores ordinary ViewModel
notifications. `watch(spec)` resolves, owns, and propagates ordinary
notifications to `onUpdate`; its optional listener belongs to the current
Binding entry and has no per-listener disposer. Prefer the Binding-owned
`listen*` APIs when a side-effect subscription needs explicit or automatic
cleanup.

Binding and Runtime disposal are idempotent. An externally injected Runtime is
always owned by the caller. Automatic instance disposal after the last owner
leaves is scheduled in a microtask; Runtime disposal and recycle are forceful
and synchronous aside from user work started by application code.

## Advanced cached and tag lookup

Normal dependencies should retain a Spec and resolve with `read(spec)` or
`watch(spec)`. Cached APIs are advanced lookup-only tools for cross-owner cases
where another path has already created a generation:

```ts
const exact = binding.readCached(DeviceViewModel, { key: deviceId });
const optional = binding.maybeWatchCached(DeviceViewModel, {
  key: deviceId,
  tag: 'connected-device',
});
const connected = binding.readCachesByTag(DeviceViewModel, 'connected-device');
```

The full family is:

- `readCached` / `watchCached`: require a hit or throw `ViewModelSpecError`;
- `maybeReadCached` / `maybeWatchCached`: return `undefined` on a miss;
- `readCachesByTag` / `watchCachesByTag`: return every matching generation, or
  an empty array.

Targets may be an explicit `ViewModelType` or a Spec. A class target follows
explicit type identity; a builder-only compatibility identity can only be
targeted through its Spec. A singular lookup accepts `{ key?, tag? }`: an exact
key is tried first, and a supplied tag can provide fallback selection. Prefer an
exact key when multiple generations may exist.

Declare `tag` in `ViewModelSpecOptions` only as query metadata. It does not
affect identity or create another generation. Cached misses never run a builder.
Hits still establish normal Binding/parent ownership and source propagation;
read variants ignore ordinary notifications, while watch variants propagate
them.

## Binding-owned listeners

Use Binding-owned listeners for imperative side effects without enabling broad
`watch` propagation:

```ts
const stopNotifications = binding.listen(deviceSpec, onDeviceChanged);
const stopState = binding.listenState(counterSpec, onCounterStateChanged);
const stopSelection = binding.listenStateSelect(
  counterSpec,
  (state) => state.status,
  onStatusChanged,
);
```

`listen` observes ordinary ViewModel notifications. `listenState` receives
`{ previous, current }` state diffs. `listenStateSelect` emits selected diffs
only when its equality function, `Object.is` by default, says the selection
changed.

Each method resolves and owns its Spec with read-style propagation and returns
an idempotent disposer for early cleanup. The Binding also removes these
subscriptions automatically when it is disposed or when that generation is
disposed/recycled. In contrast, direct `vm.subscribe` and `vm.subscribeState`
remain manually owned by their caller.

## Application-wide DI

Create a shared Runtime at the application composition root. Plain hosts and
platform React Scopes can use that same Runtime:

```ts
export const appRuntime = new ViewModelRuntime();

export const sessionSpec = viewModelSpec(SessionViewModel, () => new SessionViewModel(), {
  key: 'session',
  aliveForever: true,
});

const bootstrap = appRuntime.createBinding({ id: 'bootstrap' });
const session = bootstrap.read(sessionSpec);
```

Inject `appRuntime` into a platform Scope when the UI should resolve the same
keyed session. Non-React services create their own Bindings. Each Binding
expresses a real owner lifetime and must be disposed when that host stops.

This is application-wide DI, not an implicit global singleton. One Runtime
cannot cross an Electron process/realm boundary, and unkeyed modules remain
private to each Binding even when Bindings share a Runtime.

## Parent-child module composition

Pass Specs or ordinary ports through constructors, but resolve managed child
instances only after the parent is attached:

Never pass a resolved ViewModel object as a dependency through props,
constructors, globals, registries, callback payloads, or manual caches. An
ordinary JavaScript reference is invisible to the Runtime and therefore does
not acquire ownership, create a parent edge, propagate root owner sources, or
define a release boundary. The receiver can retain a stale disposed generation
after the original owner is disposed or the generation is recycled.

Pass a stable Spec plus any business key/ID and resolve it from the receiver's
own Binding. Pass immutable DTOs, plain functions, or narrow ports when managed
identity is unnecessary. When separate Bindings intentionally share a managed
generation, use the same Runtime and an explicit key.

```ts
class CheckoutViewModel extends ViewModel {
  private get cart(): CartViewModel {
    return this.viewModelBinding.read(cartSpec);
  }

  private get payments(): PaymentsViewModel {
    return this.viewModelBinding.read(paymentsSpec);
  }

  public async submit(): Promise<void> {
    await this.payments.pay(this.cart.state);
  }
}
```

Every parent generation has a stable private dependency Binding. Resolving a
child establishes a parent-to-child ownership edge, so the child cannot be
automatically disposed before that parent generation.

Root ownership is source-aware. Existing root Binding sources that own the
parent propagate to every resolved child, and later root bind/unbind changes are
mirrored through the child graph in real time. Direct and multiple-parent paths
are reference-counted independently, so `onBind(id)` runs for the first logical
source and `onUnbind(id)` for the last.

Use a getter rather than a cached field. Recycle can dispose a child while the
parent is still owned; the next getter access can then resolve a fresh
generation.

Use parent `read` for imperative collaboration. Use parent `watch` when child
notifications should call `parent.onDependencyNotify(child)` and then notify
the parent. Propagation is transaction-deduplicated across valid diamond graphs.
Do not notify the parent again unconditionally inside `onDependencyNotify`.

The dependency graph must be acyclic. Do not resolve dependencies in a builder
or constructor. Do not expand dependency getters from React render, JSX, or a
selector.

## Notifications

- `ViewModel.notifyListeners(action?)` increments `version` and notifies direct
  subscribers plus Runtime owners.
- `StateViewModel.setState/updateState` first emits a state diff, then the
  ordinary ViewModel notification.
- `read` owners ignore ordinary notifications but still observe generation
  disposal/recycle where the adapter supports it.
- `watch` owners propagate ordinary notifications.
- Direct `vm.subscribe` and `vm.subscribeState` callbacks run synchronously and
  are not suppressed by Runtime pause.
- One complete synchronous notification cascade shares an update transaction,
  including nested `notifyListeners` calls and parent propagation. The same
  callback is queued once per Binding/callback pair, but the same function used
  by two Bindings runs once for each Binding.
- Parent propagation is deduplicated per parent generation in that transaction,
  so valid diamond graphs notify each parent once.
- A microtask or later asynchronous notification starts a new transaction.
- Listener errors are aggregated after other listeners have had a chance to
  run.

## Lifecycle and resources

Builders and constructors may initialize in-memory fields only. React can run
them during an abandoned render.

Use these synchronous hooks:

- `onCreate`: first successful acquire; start managed resources.
- `onBind(bindingId)`: first owner source for a logical Binding id.
- `onUnbind(bindingId)`: final owner source for that logical Binding id.
- `onPause` / `onResume`: Runtime pause transitions.
- `onDependencyNotify(child)`: watched child propagation.
- `onDispose`: final cleanup logic for an activated generation.

Register cleanup with `addDispose`; callbacks run in reverse registration order
after `onDispose`. Do not depend on async lifecycle return values—the runtime
does not await them. Do not resolve new dependencies during disposal.

An uncommitted provisional generation never runs `onCreate` or `onDispose`.
This is why resource acquisition in a constructor is invalid even when
`onDispose` appears to release it.

## Pause and resume

`runtime.pause(token)` and `runtime.resume(token)` aggregate distinct stable
tokens. The Runtime resumes only after its final pause token is removed. The
no-argument overload uses one shared default token; repeated no-argument calls
are idempotent, not reference-counted.

Pause affects every activated ViewModel in the Runtime. It invokes `onPause`
and defers/coalesces Binding and hook update callbacks until resume. It does not
prevent actions, state mutations, or direct subscriptions from running.

## Recycle

`runtime.recycle(viewModel)` force-disposes that one generation.

`runtime.recycle(spec)` force-disposes every Runtime handle matching the Spec's
identity and effective key. For a keyed Spec this is normally one shared
generation. For an unkeyed Spec it can be one private generation per Binding
and therefore return a count greater than one.

Recycle ignores all owners and also disposes `aliveForever` instances. Mounted
adapters are notified only after the old generation and its exclusively owned
dependency tree finish disposal. Existing object references are disposed; use
stable Specs and getter re-resolution rather than cached child references.

Prefer a new explicit key for an independent generation. Use recycle only when
every owner should observe global invalidation.

## Errors and unsupported APIs

Core exports typed errors for disposed ViewModels, Runtimes, Bindings, invalid
Specs, dependency cycles, and unmanaged ViewModel access. Preserve these errors
instead of swallowing lifecycle failures; several listener/cleanup failures can
arrive as `AggregateError`.

Do not use Flutter-only concepts: `argN` Specs, proxy or override APIs,
annotations/generation, ChangeNotifier integration, global
configuration/reset, DevTools, widget mixins, or route/ticker pause providers.
