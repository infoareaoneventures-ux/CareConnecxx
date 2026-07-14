interface TriggerSnapshot {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

interface TriggerTransaction {
  get(ref: unknown): Promise<TriggerSnapshot>;
  update(ref: unknown, data: Record<string, unknown>): void;
}

interface TransactionalStore {
  runTransaction<T>(handler: (transaction: TriggerTransaction) => Promise<T>): Promise<T>;
}

interface UpdatableRef {
  update(data: Record<string, unknown>): Promise<unknown>;
}

export async function claimProactiveTrigger(
  store: TransactionalStore,
  triggerRef: unknown,
  claimedAt: string,
): Promise<boolean> {
  return store.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(triggerRef);
    if (!snapshot.exists) return false;
    const trigger = snapshot.data() ?? {};
    if (trigger.firedAt || trigger.cancelledAt) return false;

    transaction.update(triggerRef, {
      firedAt: claimedAt,
      deliveryState: "firing",
      deliveryClaimedAt: claimedAt,
    });
    return true;
  });
}

export async function settleProactiveTriggerDelivery(
  triggerRef: UpdatableRef,
  completedAt: string,
  error?: unknown,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : error == null ? null : String(error);
  await triggerRef.update({
    deliveryState: errorMessage ? "failed_ambiguous" : "delivered",
    deliveryCompletedAt: completedAt,
    deliveryError: errorMessage ? errorMessage.slice(0, 500) : null,
  });
}
