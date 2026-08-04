# Testing and validation

## Core test pattern

Create a fresh Runtime and Binding for each test. Dispose both even when the
assertion fails. Prefer stable explicit-type Specs such as
`viewModelSpec(TestViewModel, () => new TestViewModel())` and test through public
Binding APIs.

Automatic disposal after the final Binding owner leaves is queued in a
microtask. Flush at least the required microtasks before asserting
`viewModel.isDisposed`; do not assume `binding.dispose()` synchronously runs
final disposal.

Test these semantics when relevant:

- explicit-type unkeyed Binding-private identity;
- keyed sharing across Bindings and across independently declared explicit
  Specs with the same type + key;
- builder-only compatibility Specs retaining independent fallback tokens;
- `aliveForever` retention and Runtime shutdown;
- `read` versus `watch` propagation;
- state equality and `{ previous, current }` diffs;
- parent-child lifetime, dependency notification, and existing/later root owner
  source propagation through multiple levels;
- direct and multiple-parent source reference counting so bind/unbind callbacks
  run only on logical first/last source transitions;
- cycle rejection and construction rollback;
- whole-cascade synchronous transaction deduplication per Binding/callback pair,
  diamond parent deduplication, and a fresh transaction after an async boundary;
- cached/tag required, optional, and batch lookup behavior without accidental
  construction, plus read/watch ownership and notification differences;
- Binding-owned `listen`, `listenState`, and `listenStateSelect` early disposal,
  selection equality, Binding cleanup, and generation recycle cleanup;
- multiple pause tokens and coalesced owner updates;
- forceful recycle and getter-based generation recovery;
- resource cleanup and idempotent disposal.

For cached lookup tests, create the target through an ordinary Spec path first.
Assert that a miss does not call the builder: required forms throw,
`maybeReadCached`/`maybeWatchCached` return `undefined`, and tag-batch forms
return an empty array. Keep cached APIs classified as advanced lookup rather
than replacing normal Spec-based dependency resolution.

For notification transaction tests, trigger the cascade through public
`notifyListeners` or state updates where possible. The same callback associated
with two distinct Bindings should run once for each Binding, while repeated
delivery for the same Binding/callback pair should run once in that synchronous
transaction.

## React tests

Use the platform entry under test and wrap renderer creation, updates, recycle,
and unmount in React `act`. Inject a deterministic lifecycle source or RN
AppState test double. Flush Scope cleanup microtasks before final lifecycle
assertions because StrictMode-safe disposal is intentionally deferred.

Include StrictMode and abandoned Suspense render coverage when a change touches
prepare/acquire boundaries. Constructors may run for provisional generations;
`onCreate`, `onBind`, and business resource work must not.

## Repository validation

Run tests serially because Runtime counters and lifecycle ordering are global
to the test process:

```sh
npm run check
npm audit --audit-level=low
```

`npm run check` covers formatting, TypeScript, serial Vitest tests, ESM/CJS
build output, and package-entry identity smoke tests. Do not replace it with a
parallel Vitest invocation.
