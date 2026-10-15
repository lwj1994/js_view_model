import { ErrorType, reportViewModelError } from './config.js';
import type { ViewModelDispose } from './types.js';

interface Construction {
  readonly rollback: ViewModelDispose[];
}
interface ConstructionSlot {
  active: Construction | undefined;
}
const KEY = Symbol.for('view_model.Construction.v1');
const local: ConstructionSlot = { active: undefined };
function slot(): ConstructionSlot {
  const global = globalThis as Record<PropertyKey, unknown>;
  const existing = global[KEY];
  if (existing !== undefined) return existing as ConstructionSlot;
  try {
    Object.defineProperty(global, KEY, { value: local });
  } catch {
    /* Frozen global. */
  }
  return local;
}
/** @internal */
export function isConstructingViewModel(): boolean {
  return slot().active !== undefined;
}
/** @internal */
export function registerConstructionRollback(dispose: ViewModelDispose): void {
  slot().active?.rollback.push(dispose);
}
/** @internal */
export function constructViewModel<T>(builder: () => T): T {
  const shared = slot();
  const previous = shared.active;
  const construction: Construction = { rollback: [] };
  shared.active = construction;
  try {
    return builder();
  } catch (error) {
    for (const rollback of construction.rollback.reverse()) {
      try {
        rollback();
      } catch (cleanupError) {
        reportViewModelError(cleanupError, ErrorType.dispose, 'construction rollback');
      }
    }
    throw error;
  } finally {
    shared.active = previous;
  }
}
