import { describe, expect, it } from "vitest";

import { DeterministicPaymentRouter } from "../src/application/deterministic-router.js";
import { normalizePaymentRequest } from "../src/domain/payment.js";
import { FakePaymentProvider } from "../src/infrastructure/fake-provider.js";

function makeProvider(options: {
  readonly id: string;
  readonly priority: number;
  readonly currencies?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly healthy?: boolean;
}): FakePaymentProvider {
  return new FakePaymentProvider({
    id: options.id,
    priority: options.priority,
    supportedCurrencies: options.currencies ?? ["USD"],
    minAmountMinor: options.minimum ?? 100,
    maxAmountMinor: options.maximum ?? 100_000,
    healthy: options.healthy ?? true,
  });
}

describe("DeterministicPaymentRouter", () => {
  it("filters by health, currency and limits, then sorts by priority and provider id", () => {
    const router = new DeterministicPaymentRouter([
      makeProvider({ id: "provider-z", priority: 10 }),
      makeProvider({ id: "provider-a", priority: 10 }),
      makeProvider({ id: "provider-down", priority: 1, healthy: false }),
      makeProvider({ id: "provider-eur", priority: 1, currencies: ["EUR"] }),
      makeProvider({ id: "provider-small", priority: 1, maximum: 4_999 }),
    ]);
    const request = normalizePaymentRequest({
      idempotencyKey: "routing-test-0001",
      amountMinor: 5_000,
      currency: "usd",
      merchantReference: "synthetic-routing-test",
    });

    expect(router.routesFor(request).map((candidate) => candidate.id)).toEqual([
      "provider-a",
      "provider-z",
    ]);
  });
});
