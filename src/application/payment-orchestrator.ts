import { IdempotencyConflictError, DomainInvariantError } from "../domain/errors.js";
import {
  createPayment,
  fingerprintPaymentRequest,
  finishProviderAttempt,
  normalizePaymentRequest,
  startProviderAttempt,
} from "../domain/payment.js";
import type {
  CreatePaymentRequest,
  NormalizedPaymentRequest,
  Payment,
  PaymentStatus,
  ProviderResult,
} from "../domain/payment.js";
import { transitionPayment } from "../domain/state-machine.js";
import type { PaymentTransitionPatch } from "../domain/state-machine.js";
import { InMemoryDatabase } from "../infrastructure/in-memory-database.js";
import type {
  Clock,
  IdGenerator,
  OutboxEvent,
  PaymentProvider,
  PaymentRouter,
} from "./ports.js";

interface InFlightPayment {
  readonly requestFingerprint: string;
  readonly promise: Promise<Payment>;
}

interface CreationResult {
  readonly payment: Payment;
  readonly created: boolean;
}

export class PaymentOrchestrator {
  private readonly database: InMemoryDatabase;
  private readonly router: PaymentRouter;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly inFlightByIdempotencyKey = new Map<string, InFlightPayment>();

  public constructor(
    database: InMemoryDatabase,
    router: PaymentRouter,
    clock: Clock,
    idGenerator: IdGenerator,
  ) {
    this.database = database;
    this.router = router;
    this.clock = clock;
    this.idGenerator = idGenerator;
  }

  public async createPayment(input: CreatePaymentRequest): Promise<Payment> {
    const request = normalizePaymentRequest(input);
    const requestFingerprint = fingerprintPaymentRequest(request);
    const inFlight = this.inFlightByIdempotencyKey.get(request.idempotencyKey);

    if (inFlight !== undefined) {
      if (inFlight.requestFingerprint !== requestFingerprint) {
        throw new IdempotencyConflictError(request.idempotencyKey);
      }
      return structuredClone(await inFlight.promise);
    }

    const promise = this.processPayment(request, requestFingerprint);
    this.inFlightByIdempotencyKey.set(request.idempotencyKey, {
      requestFingerprint,
      promise,
    });

    try {
      return structuredClone(await promise);
    } finally {
      const current = this.inFlightByIdempotencyKey.get(request.idempotencyKey);
      if (current?.promise === promise) {
        this.inFlightByIdempotencyKey.delete(request.idempotencyKey);
      }
    }
  }

  private async processPayment(
    request: NormalizedPaymentRequest,
    requestFingerprint: string,
  ): Promise<Payment> {
    const creation = this.createOrGetPayment(request, requestFingerprint);
    if (!creation.created) {
      return creation.payment;
    }

    let payment = this.transition(creation.payment.id, "ROUTING");
    const routes = this.router.routesFor(request);

    if (routes.length === 0) {
      return this.transition(payment.id, "FAILED", {
        failureCode: "NO_HEALTHY_ROUTE",
      });
    }

    payment = this.transition(payment.id, "PROCESSING");
    let terminalProviderFailure = false;

    for (const [routeIndex, provider] of routes.entries()) {
      const attemptId = `${payment.id}:${provider.id}:${routeIndex + 1}`;
      payment = this.recordAttemptStarted(payment.id, attemptId, provider.id);

      const result = await this.chargeProvider(provider, payment, attemptId);
      payment = this.recordAttemptFinished(payment.id, attemptId, result);

      if (result.kind === "success") {
        return this.transition(payment.id, "SUCCEEDED", {
          providerId: provider.id,
          failureCode: null,
        });
      }

      if (!result.retryable) {
        terminalProviderFailure = true;
        break;
      }
    }

    return this.transition(payment.id, "FAILED", {
      failureCode: terminalProviderFailure ? "PROVIDER_REJECTED" : "ROUTES_EXHAUSTED",
    });
  }

  private createOrGetPayment(
    request: NormalizedPaymentRequest,
    requestFingerprint: string,
  ): CreationResult {
    return this.database.transaction((transaction) => {
      const existing = transaction.getPaymentByIdempotencyKey(request.idempotencyKey);
      if (existing !== null) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new IdempotencyConflictError(request.idempotencyKey);
        }
        return { payment: existing.payment, created: false };
      }

      const now = this.clock.now();
      const payment = createPayment(this.idGenerator.next(), request, requestFingerprint, now);
      transaction.savePayment(payment);
      transaction.bindIdempotencyKey(request.idempotencyKey, payment.id, requestFingerprint);
      transaction.appendOutboxEvent(this.event(
        "payment.created",
        payment.id,
        {
          status: payment.status,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          merchantReference: payment.merchantReference,
        },
        now,
      ));

      return { payment, created: true };
    });
  }

  private transition(
    paymentId: string,
    to: PaymentStatus,
    patch: PaymentTransitionPatch = {},
  ): Payment {
    return this.database.transaction((transaction) => {
      const current = transaction.getPayment(paymentId);
      if (current === null) {
        throw new DomainInvariantError(`Payment "${paymentId}" does not exist.`);
      }

      const now = this.clock.now();
      const next = transitionPayment(current, to, now, patch);
      transaction.savePayment(next);
      transaction.appendOutboxEvent(this.event(
        "payment.state_changed",
        paymentId,
        {
          from: current.status,
          to,
          version: next.version,
          providerId: next.providerId,
          failureCode: next.failureCode,
        },
        now,
      ));
      return next;
    });
  }

  private recordAttemptStarted(
    paymentId: string,
    attemptId: string,
    providerId: string,
  ): Payment {
    return this.database.transaction((transaction) => {
      const current = transaction.getPayment(paymentId);
      if (current === null) {
        throw new DomainInvariantError(`Payment "${paymentId}" does not exist.`);
      }

      const now = this.clock.now();
      const next = startProviderAttempt(current, attemptId, providerId, now);
      transaction.savePayment(next);
      transaction.appendOutboxEvent(this.event(
        "provider.attempt_started",
        paymentId,
        {
          attemptId,
          providerId,
          sequence: next.attempts.length,
        },
        now,
      ));
      return next;
    });
  }

  private recordAttemptFinished(
    paymentId: string,
    attemptId: string,
    result: ProviderResult,
  ): Payment {
    return this.database.transaction((transaction) => {
      const current = transaction.getPayment(paymentId);
      if (current === null) {
        throw new DomainInvariantError(`Payment "${paymentId}" does not exist.`);
      }

      const now = this.clock.now();
      const next = finishProviderAttempt(current, attemptId, result, now);
      transaction.savePayment(next);
      transaction.appendOutboxEvent(this.event(
        "provider.attempt_finished",
        paymentId,
        result.kind === "success"
          ? {
              attemptId,
              outcome: result.kind,
              providerReference: result.providerReference,
            }
          : {
              attemptId,
              outcome: result.kind,
              failureCode: result.code,
              retryable: result.retryable,
            },
        now,
      ));
      return next;
    });
  }

  private async chargeProvider(
    provider: PaymentProvider,
    payment: Payment,
    attemptId: string,
  ): Promise<ProviderResult> {
    try {
      return await provider.charge({
        attemptId,
        paymentId: payment.id,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        merchantReference: payment.merchantReference,
      });
    } catch {
      return {
        kind: "failure",
        code: "PROVIDER_UNAVAILABLE",
        retryable: true,
      };
    }
  }

  private event(
    type: string,
    aggregateId: string,
    payload: Readonly<Record<string, unknown>>,
    occurredAt: string,
  ): OutboxEvent {
    return {
      id: this.idGenerator.next(),
      type,
      aggregateId,
      occurredAt,
      payload,
    };
  }
}
