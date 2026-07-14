export class IdempotencyConflictError extends Error {
  public constructor(idempotencyKey: string) {
    super(`Idempotency key "${idempotencyKey}" was already used with a different request.`);
    this.name = "IdempotencyConflictError";
  }
}

export class InvalidPaymentTransitionError extends Error {
  public constructor(from: string, to: string) {
    super(`Payment cannot transition from ${from} to ${to}.`);
    this.name = "InvalidPaymentTransitionError";
  }
}

export class DomainInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DomainInvariantError";
  }
}
