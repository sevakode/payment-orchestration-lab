import { describe, expect, it } from "vitest";

import { InvalidPaymentTransitionError } from "../src/domain/errors.js";
import { createPayment, normalizePaymentRequest } from "../src/domain/payment.js";
import { transitionPayment } from "../src/domain/state-machine.js";

describe("payment state machine", () => {
  it("rejects an invalid direct transition from CREATED to SUCCEEDED", () => {
    const payment = createPayment(
      "synthetic-payment-1",
      normalizePaymentRequest({
        idempotencyKey: "state-test-0001",
        amountMinor: 1_000,
        currency: "USD",
        merchantReference: "synthetic-state-test",
      }),
      "synthetic-fingerprint",
      "2026-01-01T00:00:00.000Z",
    );

    expect(() => transitionPayment(
      payment,
      "SUCCEEDED",
      "2026-01-01T00:00:01.000Z",
    )).toThrow(InvalidPaymentTransitionError);
  });
});
