# Testing and validation

## Core test pattern

Create a fresh Runtime and Binding for each test. Dispose both even when the
assertion fails. Test through stable Specs and public `read/watch` APIs.

Automatic disposal after the final Binding owner leaves is queued in a
microtask. Flush at least the required microtasks before asserting
`viewModel.isDisposed`; do not assume `binding.dispose()` synchronously runs
final disposal.

Test these semantics when relevant:

- unkeyed private identity and keyed cross-Binding sharing;
- `aliveForever` retention and Runtime shutdown;
- `read` versus `watch` propagation;
- state equality and `{ previous, current }` diffs;
- parent-child lifetime and dependency notification;
- cycle rejection and construction rollback;
- multiple pause tokens and coalesced owner updates;
- forceful recycle and getter-based generation recovery;
- resource cleanup and idempotent disposal.

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
