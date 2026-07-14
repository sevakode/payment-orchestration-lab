import { DeterministicPaymentRouter } from "../src/application/deterministic-router.js";
import { PaymentOrchestrator } from "../src/application/payment-orchestrator.js";
import type { Clock, IdGenerator, PaymentProvider } from "../src/application/ports.js";
import { InMemoryDatabase } from "../src/infrastructure/in-memory-database.js";

export class FixedClock implements Clock {
  public now(): string {
    return "2026-01-01T00:00:00.000Z";
  }
}

export class SequenceIdGenerator implements IdGenerator {
  private sequence = 0;

  public next(): string {
    this.sequence += 1;
    return `synthetic-id-${this.sequence}`;
  }
}

export function createHarness(providers: readonly PaymentProvider[]): {
  readonly database: InMemoryDatabase;
  readonly clock: FixedClock;
  readonly orchestrator: PaymentOrchestrator;
} {
  const database = new InMemoryDatabase();
  const clock = new FixedClock();
  return {
    database,
    clock,
    orchestrator: new PaymentOrchestrator(
      database,
      new DeterministicPaymentRouter(providers),
      clock,
      new SequenceIdGenerator(),
    ),
  };
}

export const usdRequest = {
  idempotencyKey: "checkout-request-0001",
  amountMinor: 5_000,
  currency: "USD",
  merchantReference: "synthetic-order-0001",
} as const;
