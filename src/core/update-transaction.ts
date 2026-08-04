import type { ViewModelListener } from './types.js';

const UPDATE_TRANSACTION_SLOT = Symbol.for('view_model.UpdateTransaction.v1');

interface QueuedCallback {
  readonly owner: object;
  readonly callback: ViewModelListener;
}

interface ViewModelUpdateTransaction {
  readonly callbackPairs: Map<object, Set<ViewModelListener>>;
  readonly callbacks: QueuedCallback[];
  readonly notifiedParents: Set<object>;
}

interface ViewModelUpdateTransactionSlot {
  active: ViewModelUpdateTransaction | undefined;
}

const localTransactionSlot: ViewModelUpdateTransactionSlot = { active: undefined };

function transactionSlot(): ViewModelUpdateTransactionSlot {
  const sharedGlobal = globalThis as Record<PropertyKey, unknown>;
  const existing = sharedGlobal[UPDATE_TRANSACTION_SLOT];
  if (existing !== undefined) {
    return existing as ViewModelUpdateTransactionSlot;
  }

  const created: ViewModelUpdateTransactionSlot = { active: undefined };
  try {
    Object.defineProperty(sharedGlobal, UPDATE_TRANSACTION_SLOT, {
      configurable: false,
      enumerable: false,
      value: created,
      writable: false,
    });
    return created;
  } catch {
    // A frozen global object cannot share the slot across module copies.
    return localTransactionSlot;
  }
}

/**
 * Runs one complete synchronous notification cascade in a shared transaction.
 * Nested calls reuse the current transaction; a later microtask starts a new one.
 */
export function runInViewModelUpdateTransaction<TResult>(body: () => TResult): TResult {
  const slot = transactionSlot();
  if (slot.active !== undefined) {
    return body();
  }

  const transaction: ViewModelUpdateTransaction = {
    callbackPairs: new Map(),
    callbacks: [],
    notifiedParents: new Set(),
  };
  slot.active = transaction;

  let result: TResult | undefined;
  let bodyError: unknown;
  let bodyFailed = false;
  const callbackErrors: unknown[] = [];

  try {
    try {
      result = body();
    } catch (error) {
      bodyFailed = true;
      bodyError = error;
    }

    // Callbacks may synchronously enqueue more callbacks. Keep the transaction
    // active and drain by index so the new work joins the same cascade.
    for (let index = 0; index < transaction.callbacks.length; index += 1) {
      const queued = transaction.callbacks[index];
      if (queued === undefined) continue;
      try {
        queued.callback();
      } catch (error) {
        callbackErrors.push(error);
      }
    }
  } finally {
    slot.active = undefined;
  }

  if (bodyFailed && callbackErrors.length === 0) {
    throw bodyError;
  }
  if (bodyFailed || callbackErrors.length > 0) {
    const errors = bodyFailed ? [bodyError, ...callbackErrors] : callbackErrors;
    throw new AggregateError(errors, 'ViewModel 更新事务回调发生错误。');
  }

  return result as TResult;
}

/**
 * Queues one callback per owner/callback identity pair in the current
 * transaction. The same callback used by two bindings therefore runs twice.
 */
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
  transaction.callbacks.push({ owner, callback });
}

/** Returns true only for the first propagation to this parent in a transaction. */
export function markViewModelParentNotified(parent: object): boolean {
  const transaction = transactionSlot().active;
  if (transaction === undefined) return true;
  if (transaction.notifiedParents.has(parent)) return false;
  transaction.notifiedParents.add(parent);
  return true;
}

/** @internal */
export function isViewModelUpdateTransactionActive(): boolean {
  return transactionSlot().active !== undefined;
}
