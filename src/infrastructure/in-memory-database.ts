import { DomainInvariantError } from "../domain/errors.js";
import type { OutboxEvent } from "../application/ports.js";
import type { Payment } from "../domain/payment.js";

interface IdempotencyBinding {
  readonly paymentId: string;
  readonly requestFingerprint: string;
}

export interface StoredOutboxEvent {
  readonly event: OutboxEvent;
  readonly deliveryAttempts: number;
  readonly publishedAt: string | null;
  readonly lastError: string | null;
}

interface MutableDatabaseState {
  payments: Map<string, Payment>;
  idempotencyBindings: Map<string, IdempotencyBinding>;
  outbox: Map<string, StoredOutboxEvent>;
}

function cloneState(state: MutableDatabaseState): MutableDatabaseState {
  return {
    payments: new Map(
      [...state.payments].map(([id, payment]) => [id, structuredClone(payment)]),
    ),
    idempotencyBindings: new Map(
      [...state.idempotencyBindings].map(([key, binding]) => [key, structuredClone(binding)]),
    ),
    outbox: new Map(
      [...state.outbox].map(([id, record]) => [id, structuredClone(record)]),
    ),
  };
}

export class InMemoryTransaction {
  private readonly state: MutableDatabaseState;

  public constructor(state: MutableDatabaseState) {
    this.state = state;
  }

  public getPayment(paymentId: string): Payment | null {
    const payment = this.state.payments.get(paymentId);
    return payment === undefined ? null : structuredClone(payment);
  }

  public getPaymentByIdempotencyKey(
    idempotencyKey: string,
  ): { readonly payment: Payment; readonly requestFingerprint: string } | null {
    const binding = this.state.idempotencyBindings.get(idempotencyKey);
    if (binding === undefined) {
      return null;
    }

    const payment = this.state.payments.get(binding.paymentId);
    if (payment === undefined) {
      throw new DomainInvariantError(
        `Idempotency binding "${idempotencyKey}" references a missing payment.`,
      );
    }

    return {
      payment: structuredClone(payment),
      requestFingerprint: binding.requestFingerprint,
    };
  }

  public savePayment(payment: Payment): void {
    this.state.payments.set(payment.id, structuredClone(payment));
  }

  public bindIdempotencyKey(
    idempotencyKey: string,
    paymentId: string,
    requestFingerprint: string,
  ): void {
    if (this.state.idempotencyBindings.has(idempotencyKey)) {
      throw new DomainInvariantError(`Idempotency key "${idempotencyKey}" is already bound.`);
    }

    this.state.idempotencyBindings.set(idempotencyKey, {
      paymentId,
      requestFingerprint,
    });
  }

  public appendOutboxEvent(event: OutboxEvent): void {
    if (this.state.outbox.has(event.id)) {
      throw new DomainInvariantError(`Outbox event "${event.id}" already exists.`);
    }

    this.state.outbox.set(event.id, {
      event: structuredClone(event),
      deliveryAttempts: 0,
      publishedAt: null,
      lastError: null,
    });
  }

  public getOutboxEvent(eventId: string): StoredOutboxEvent | null {
    const record = this.state.outbox.get(eventId);
    return record === undefined ? null : structuredClone(record);
  }

  public saveOutboxEvent(record: StoredOutboxEvent): void {
    if (!this.state.outbox.has(record.event.id)) {
      throw new DomainInvariantError(`Outbox event "${record.event.id}" does not exist.`);
    }
    this.state.outbox.set(record.event.id, structuredClone(record));
  }
}

export class InMemoryDatabase {
  private state: MutableDatabaseState = {
    payments: new Map(),
    idempotencyBindings: new Map(),
    outbox: new Map(),
  };

  public transaction<T>(work: (transaction: InMemoryTransaction) => T): T {
    const candidateState = cloneState(this.state);
    const result = work(new InMemoryTransaction(candidateState));

    if (result instanceof Promise) {
      throw new DomainInvariantError("In-memory transactions must not contain asynchronous work.");
    }

    this.state = candidateState;
    return result;
  }

  public getPayment(paymentId: string): Payment | null {
    const payment = this.state.payments.get(paymentId);
    return payment === undefined ? null : structuredClone(payment);
  }

  public allPayments(): readonly Payment[] {
    return [...this.state.payments.values()].map((payment) => structuredClone(payment));
  }

  public allOutboxEvents(): readonly StoredOutboxEvent[] {
    return [...this.state.outbox.values()].map((record) => structuredClone(record));
  }

  public pendingOutboxEvents(limit = 100): readonly StoredOutboxEvent[] {
    return [...this.state.outbox.values()]
      .filter((record) => record.publishedAt === null)
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  public recordDeliveryAttempt(eventId: string): void {
    this.updateOutboxEvent(eventId, (record) => ({
      ...record,
      deliveryAttempts: record.deliveryAttempts + 1,
      lastError: null,
    }));
  }

  public recordDeliveryFailure(eventId: string, error: string): void {
    this.updateOutboxEvent(eventId, (record) => ({
      ...record,
      lastError: error,
    }));
  }

  public markPublished(eventId: string, publishedAt: string): void {
    this.updateOutboxEvent(eventId, (record) => ({
      ...record,
      publishedAt,
      lastError: null,
    }));
  }

  private updateOutboxEvent(
    eventId: string,
    update: (record: StoredOutboxEvent) => StoredOutboxEvent,
  ): void {
    this.transaction((transaction) => {
      const record = transaction.getOutboxEvent(eventId);
      if (record === null) {
        throw new DomainInvariantError(`Outbox event "${eventId}" does not exist.`);
      }
      transaction.saveOutboxEvent(update(record));
    });
  }
}
