import { shiftPaymentOperationKey, updateShiftPaymentOperation } from "./paymentOperation";

export async function resetShiftPaymentForRetry(input: {
  appointmentId: string;
  shiftRef: { update(data: Record<string, unknown>): Promise<unknown> };
  shift: Record<string, any>;
}): Promise<{ retryCount: number; nextPaymentAttemptAt: string }> {
  const generation = Math.max(1, Number(input.shift.paymentGeneration ?? 1));
  const retryCount = Math.max(0, Number(input.shift.retryCount ?? 0)) + 1;
  const nextPaymentAttemptAt = new Date().toISOString();

  await updateShiftPaymentOperation(
    shiftPaymentOperationKey(input.appointmentId, generation),
    "retry",
    { nextAttemptAt: nextPaymentAttemptAt, lastErrorCode: null },
  );
  await input.shiftRef.update({
    status: "approved",
    nextPaymentAttemptAt,
    retryCount,
  });

  return { retryCount, nextPaymentAttemptAt };
}
