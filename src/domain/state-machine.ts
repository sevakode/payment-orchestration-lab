import { InvalidPaymentTransitionError } from "./errors.js";
import type { Payment, PaymentStatus } from "./payment.js";

const ALLOWED_TRANSITIONS: Readonly<Record<PaymentStatus, ReadonlySet<PaymentStatus>>> = {
  CREATED: new Set(["ROUTING"]),
  ROUTING: new Set(["PROCESSING", "FAILED"]),
  PROCESSING: new Set(["SUCCEEDED", "FAILED"]),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
};

export type PaymentTransitionPatch = Partial<Pick<Payment, "providerId" | "failureCode">>;

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}

export function transitionPayment(
  payment: Payment,
  to: PaymentStatus,
  now: string,
  patch: PaymentTransitionPatch = {},
): Payment {
  if (!canTransition(payment.status, to)) {
    throw new InvalidPaymentTransitionError(payment.status, to);
  }

  return {
    ...payment,
    ...patch,
    status: to,
    version: payment.version + 1,
    updatedAt: now,
  };
}
