import { DeterministicPaymentRouter } from "./application/deterministic-router.js";
import { PaymentOrchestrator } from "./application/payment-orchestrator.js";
import { FakePaymentProvider } from "./infrastructure/fake-provider.js";
import { InMemoryDatabase } from "./infrastructure/in-memory-database.js";
import { DeduplicatingEventConsumer, OutboxRelay } from "./infrastructure/outbox.js";
import { SystemClock, UuidGenerator } from "./infrastructure/system.js";

async function main(): Promise<void> {
  const primary = new FakePaymentProvider({
    id: "provider-primary",
    priority: 10,
    supportedCurrencies: ["USD", "EUR"],
    minAmountMinor: 100,
    maxAmountMinor: 100_000,
    script: [{ kind: "failure", code: "SYNTHETIC_TIMEOUT", retryable: true }],
  });
  const backup = new FakePaymentProvider({
    id: "provider-backup",
    priority: 20,
    supportedCurrencies: ["USD"],
    minAmountMinor: 100,
    maxAmountMinor: 250_000,
    script: [{ kind: "success", providerReference: "synthetic-charge-42" }],
  });

  const database = new InMemoryDatabase();
  const clock = new SystemClock();
  const orchestrator = new PaymentOrchestrator(
    database,
    new DeterministicPaymentRouter([backup, primary]),
    clock,
    new UuidGenerator(),
  );
  const request = {
    idempotencyKey: "demo-order-0001",
    amountMinor: 4_250,
    currency: "USD",
    merchantReference: "synthetic-order-42",
  } as const;

  const payment = await orchestrator.createPayment(request);
  const duplicate = await orchestrator.createPayment(request);
  const consumer = new DeduplicatingEventConsumer();
  const relay = new OutboxRelay(database, consumer, clock);
  const relayResult = await relay.relayOnce();

  console.log(JSON.stringify({
    payment: {
      id: payment.id,
      status: payment.status,
      selectedProvider: payment.providerId,
      attempts: payment.attempts.map((attempt) => ({
        provider: attempt.providerId,
        status: attempt.status,
        failureCode: attempt.failureCode,
      })),
    },
    idempotencyReturnedSamePayment: duplicate.id === payment.id,
    providerCalls: {
      primary: primary.callCount,
      backup: backup.callCount,
    },
    outbox: {
      relayResult,
      uniqueEventsConsumed: consumer.processedCount,
    },
  }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
