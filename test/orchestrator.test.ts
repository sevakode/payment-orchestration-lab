import { describe, expect, it } from "vitest";

import { IdempotencyConflictError } from "../src/domain/errors.js";
import { FakePaymentProvider } from "../src/infrastructure/fake-provider.js";
import { createHarness, usdRequest } from "./helpers.js";

function provider(
  id: string,
  priority: number,
  script: ConstructorParameters<typeof FakePaymentProvider>[0]["script"] = [],
  healthy = true,
): FakePaymentProvider {
  return new FakePaymentProvider({
    id,
    priority,
    supportedCurrencies: ["USD"],
    minAmountMinor: 100,
    maxAmountMinor: 100_000,
    healthy,
    script,
  });
}

describe("PaymentOrchestrator", () => {
  it("returns one payment and makes one provider call for duplicate idempotent requests", async () => {
    const onlyProvider = provider("provider-a", 10, [
      { kind: "success", providerReference: "synthetic-ref-1" },
    ]);
    const { database, orchestrator } = createHarness([onlyProvider]);

    const [first, concurrentDuplicate] = await Promise.all([
      orchestrator.createPayment(usdRequest),
      orchestrator.createPayment(usdRequest),
    ]);
    const laterDuplicate = await orchestrator.createPayment(usdRequest);

    expect(concurrentDuplicate.id).toBe(first.id);
    expect(laterDuplicate.id).toBe(first.id);
    expect(first.status).toBe("SUCCEEDED");
    expect(onlyProvider.callCount).toBe(1);
    expect(database.allPayments()).toHaveLength(1);
    expect(
      database.allOutboxEvents().filter((record) => record.event.type === "payment.created"),
    ).toHaveLength(1);
  });

  it("rejects reuse of an idempotency key with a different payload", async () => {
    const onlyProvider = provider("provider-a", 10);
    const { orchestrator } = createHarness([onlyProvider]);

    await orchestrator.createPayment(usdRequest);

    await expect(orchestrator.createPayment({
      ...usdRequest,
      amountMinor: usdRequest.amountMinor + 1,
    })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("cascades to the next deterministic route after a retryable failure", async () => {
    const firstProvider = provider("provider-first", 10, [
      { kind: "failure", code: "SYNTHETIC_TIMEOUT", retryable: true },
    ]);
    const secondProvider = provider("provider-second", 20, [
      { kind: "success", providerReference: "synthetic-ref-2" },
    ]);
    const { orchestrator } = createHarness([secondProvider, firstProvider]);

    const payment = await orchestrator.createPayment(usdRequest);

    expect(payment.status).toBe("SUCCEEDED");
    expect(payment.providerId).toBe("provider-second");
    expect(payment.attempts.map((attempt) => attempt.providerId)).toEqual([
      "provider-first",
      "provider-second",
    ]);
    expect(payment.attempts.map((attempt) => attempt.status)).toEqual(["FAILED", "SUCCEEDED"]);
    expect(firstProvider.callCount).toBe(1);
    expect(secondProvider.callCount).toBe(1);
  });

  it("treats a thrown provider error as retryable and continues the cascade", async () => {
    const unavailableProvider = provider("provider-unavailable", 10, [
      new Error("Synthetic network failure"),
    ]);
    const backupProvider = provider("provider-backup", 20, [
      { kind: "success", providerReference: "synthetic-ref-backup" },
    ]);
    const { orchestrator } = createHarness([unavailableProvider, backupProvider]);

    const payment = await orchestrator.createPayment(usdRequest);

    expect(payment.status).toBe("SUCCEEDED");
    expect(payment.providerId).toBe("provider-backup");
    expect(payment.attempts[0]).toMatchObject({
      providerId: "provider-unavailable",
      status: "FAILED",
      failureCode: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    expect(backupProvider.callCount).toBe(1);
  });

  it("stops the cascade after a non-retryable provider decline", async () => {
    const decliningProvider = provider("provider-decline", 10, [
      { kind: "failure", code: "SYNTHETIC_DECLINE", retryable: false },
    ]);
    const unusedBackup = provider("provider-unused", 20);
    const { orchestrator } = createHarness([decliningProvider, unusedBackup]);

    const payment = await orchestrator.createPayment(usdRequest);

    expect(payment.status).toBe("FAILED");
    expect(payment.failureCode).toBe("PROVIDER_REJECTED");
    expect(payment.attempts).toHaveLength(1);
    expect(decliningProvider.callCount).toBe(1);
    expect(unusedBackup.callCount).toBe(0);
  });

  it("fails without calling a provider when no healthy route is eligible", async () => {
    const unhealthyProvider = provider("provider-down", 10, [], false);
    const { orchestrator } = createHarness([unhealthyProvider]);

    const payment = await orchestrator.createPayment(usdRequest);

    expect(payment.status).toBe("FAILED");
    expect(payment.failureCode).toBe("NO_HEALTHY_ROUTE");
    expect(payment.attempts).toHaveLength(0);
    expect(unhealthyProvider.callCount).toBe(0);
  });
});
