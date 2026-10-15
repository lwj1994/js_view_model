import { ErrorType, reportViewModelError } from './config.js';
import type { ViewModelListener } from './types.js';

// The v2 protocol coalesces refresh requests, never dependency or business events.
const UPDATE_TRANSACTION_SLOT = Symbol.for('view_model.UpdateTransaction.v2');
interface ViewModelUpdateTransaction {
  readonly updatedBindings: Set<object>;
  readonly callbackPairs: Map<object, Set<ViewModelListener>>;
  readonly callbacks: ViewModelListener[];
}
interface TransactionSlot {
  active: ViewModelUpdateTransaction | undefined;
}
const local: TransactionSlot = { active: undefined };
function transactionSlot(): TransactionSlot {
  const global = globalThis as Record<PropertyKey, unknown>;
  const existing = global[UPDATE_TRANSACTION_SLOT];
  if (existing !== undefined) return existing as TransactionSlot;
  try {
    Object.defineProperty(global, UPDATE_TRANSACTION_SLOT, { value: local });
  } catch {
    /* Frozen globals use the module-local slot. */
  }
  return local;
}

/** One synchronous cascade; asynchronous continuations always start a new transaction. */
export function runInViewModelUpdateTransaction<TResult>(body: () => TResult): TResult {
  const slot = transactionSlot();
  if (slot.active !== undefined) return body();
  const transaction: ViewModelUpdateTransaction = {
    updatedBindings: new Set(),
    callbackPairs: new Map(),
    callbacks: [],
  };
  slot.active = transaction;
  try {
    return body();
  } finally {
    try {
      // Host subscriptions read the final snapshot, after every synchronous
      // dependency and business event. This is not a dependency-tracking phase.
      for (let index = 0; index < transaction.callbacks.length; index += 1) {
        try {
          transaction.callbacks[index]?.();
        } catch (error) {
          reportViewModelError(error, ErrorType.listener, 'host update');
        }
      }
    } finally {
      slot.active = undefined;
    }
  }
}

/** A root onUpdate is a refresh request at the first event, not a business listener. */
export function markViewModelBindingUpdated(binding: object): boolean {
  const transaction = transactionSlot().active;
  if (transaction === undefined) return true;
  if (transaction.updatedBindings.has(binding)) return false;
  transaction.updatedBindings.add(binding);
  return true;
}

/** Deduplicate host subscriptions by owner AND callback; do not use for business listeners. */
export function enqueueViewModelUpdateCallback(owner: object, callback: ViewModelListener): void {
  const transaction = transactionSlot().active;
  if (transaction === undefined) {
    callback();
    return;
  }
  const callbacks = transaction.callbackPairs.get(owner) ?? new Set<ViewModelListener>();
  if (callbacks.has(callback)) return;
  callbacks.add(callback);
  transaction.callbackPairs.set(owner, callbacks);
  transaction.callbacks.push(callback);
}

/** @internal */
export function isViewModelUpdateTransactionActive(): boolean {
  return transactionSlot().active !== undefined;
}
