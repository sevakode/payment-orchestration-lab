import type { NormalizedPaymentRequest, ProviderResult } from "../domain/payment.js";

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(): string;
}

export interface ProviderChargeCommand {
  readonly attemptId: string;
  readonly paymentId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly merchantReference: string;
}

export interface PaymentProvider {
  readonly id: string;
  readonly priority: number;
  readonly supportedCurrencies: ReadonlySet<string>;
  readonly minAmountMinor: number;
  readonly maxAmountMinor: number;

  isHealthy(): boolean;
  charge(command: ProviderChargeCommand): Promise<ProviderResult>;
}

export interface OutboxEvent {
  readonly id: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EventPublisher {
  publish(event: OutboxEvent): Promise<void>;
}

export interface PaymentRouter {
  routesFor(request: NormalizedPaymentRequest): readonly PaymentProvider[];
}
