import { ViewModelSpecError } from './errors.js';
import type { ViewModelDispose } from './types.js';

/** An explicit factory override. Use matching Spec/argument-family types. */
export type ViewModelOverride = readonly [source: object, replacement: object];
export type ViewModelOverrideContext = ReadonlyMap<object, object>;
interface OverrideEntry {
  readonly replacement: object;
}
interface OverrideState {
  readonly entries: Map<object, OverrideEntry[]>;
  readonly proxies: Map<object, object>;
}
const KEY = Symbol.for('view_model.Overrides.v1');
const local: OverrideState = { entries: new Map(), proxies: new Map() };
function state(): OverrideState {
  const global = globalThis as Record<PropertyKey, unknown>;
  const existing = global[KEY];
  if (existing !== undefined) return existing as OverrideState;
  try {
    Object.defineProperty(global, KEY, { value: local });
  } catch {
    /* Frozen global. */
  }
  return local;
}

/** Manual realm-wide override, deliberately not an async-local mechanism. @internal */
export function installViewModelOverride(source: object, replacement: object): ViewModelDispose {
  const entries = state().entries;
  const stack = entries.get(source) ?? [];
  const entry = { replacement };
  stack.push(entry);
  entries.set(source, stack);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    if (stack.length === 0 && entries.get(source) === stack) entries.delete(source);
  };
}
/** @internal */
export function setViewModelProxy(source: object, replacement?: object): void {
  if (replacement === undefined) state().proxies.delete(source);
  else state().proxies.set(source, replacement);
}
/** @internal */
export function snapshotViewModelOverrides(
  context?: ViewModelOverrideContext,
  inheritGlobal = true,
): Map<object, object> {
  const result = inheritGlobal ? new Map(state().proxies) : new Map<object, object>();
  if (inheritGlobal)
    for (const [source, stack] of state().entries)
      result.set(source, stack[stack.length - 1]!.replacement);
  for (const [source, replacement] of context ?? []) result.set(source, replacement);
  return result;
}
/** Resolve the entire proxy chain with identity-based cycle detection. @internal */
export function resolveViewModelOverride<T extends object>(
  source: T,
  context?: ViewModelOverrideContext,
  inheritGlobal = true,
): T {
  const visited = new Set<object>();
  let current: object = source;
  while (true) {
    if (visited.has(current)) throw new ViewModelSpecError('ViewModel Spec override cycle.');
    visited.add(current);
    const stack = inheritGlobal ? state().entries.get(current) : undefined;
    const replacement =
      context?.get(current) ??
      stack?.[stack.length - 1]?.replacement ??
      (inheritGlobal ? state().proxies.get(current) : undefined);
    if (replacement === undefined) return current as T;
    current = replacement;
  }
}
