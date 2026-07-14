import { createHash } from "node:crypto";

import { DomainInvariantError } from "./errors.js";

export type PaymentStatus = "CREATED" | "ROUTING" | "PROCESSING" | "SUCCEEDED" | "FAILED";

export type ProviderAttemptStatus = "STARTED" | "SUCCEEDED" | "FAILED";

export interface CreatePaymentRequest {
  readonly idempotencyKey: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly merchantReference: string;
}

export interface NormalizedPaymentRequest {
  readonly idempotencyKey: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly merchantReference: string;
}

export interface ProviderAttempt {
  readonly id: string;
  readonly providerId: string;
  readonly sequence: number;
  readonly status: ProviderAttemptStatus;
  readonly failureCode: string | null;
  readonly retryable: boolean | null;
  readonly providerReference: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface Payment {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly merchantReference: string;
  readonly status: PaymentStatus;
  readonly providerId: string | null;
  readonly failureCode: string | null;
  readonly attempts: readonly ProviderAttempt[];
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SuccessfulProviderResult {
  readonly kind: "success";
  readonly providerReference: string;
}

export interface FailedProviderResult {
  readonly kind: "failure";
  readonly code: string;
  readonly retryable: boolean;
}

export type ProviderResult = SuccessfulProviderResult | FailedProviderResult;

export function normalizePaymentRequest(input: CreatePaymentRequest): NormalizedPaymentRequest {
  const idempotencyKey = input.idempotencyKey.trim();
  const merchantReference = input.merchantReference.trim();
  const currency = input.currency.trim().toUpperCase();

  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new DomainInvariantError("idempotencyKey must contain between 8 and 128 characters.");
  }

  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new DomainInvariantError("amountMinor must be a positive safe integer.");
  }

  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new DomainInvariantError("currency must be a three-letter ISO-style code.");
  }

  if (merchantReference.length === 0 || merchantReference.length > 128) {
    throw new DomainInvariantError("merchantReference must contain between 1 and 128 characters.");
  }

  return {
    idempotencyKey,
    amountMinor: input.amountMinor,
    currency,
    merchantReference,
  };
}

export function fingerprintPaymentRequest(request: NormalizedPaymentRequest): string {
  const canonicalPayload = JSON.stringify([
    request.amountMinor,
    request.currency,
    request.merchantReference,
  ]);

  return createHash("sha256").update(canonicalPayload).digest("hex");
}

export function createPayment(
  id: string,
  request: NormalizedPaymentRequest,
  requestFingerprint: string,
  now: string,
): Payment {
  return {
    id,
    idempotencyKey: request.idempotencyKey,
    requestFingerprint,
    amountMinor: request.amountMinor,
    currency: request.currency,
    merchantReference: request.merchantReference,
    status: "CREATED",
    providerId: null,
    failureCode: null,
    attempts: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function startProviderAttempt(
  payment: Payment,
  attemptId: string,
  providerId: string,
  now: string,
): Payment {
  if (payment.status !== "PROCESSING") {
    throw new DomainInvariantError("Provider attempts can only start while a payment is PROCESSING.");
  }

  if (payment.attempts.some((attempt) => attempt.id === attemptId)) {
    throw new DomainInvariantError(`Provider attempt "${attemptId}" already exists.`);
  }

  const attempt: ProviderAttempt = {
    id: attemptId,
    providerId,
    sequence: payment.attempts.length + 1,
    status: "STARTED",
    failureCode: null,
    retryable: null,
    providerReference: null,
    startedAt: now,
    finishedAt: null,
  };

  return {
    ...payment,
    attempts: [...payment.attempts, attempt],
    version: payment.version + 1,
    updatedAt: now,
  };
}

export function finishProviderAttempt(
  payment: Payment,
  attemptId: string,
  result: ProviderResult,
  now: string,
): Payment {
  const attemptIndex = payment.attempts.findIndex((attempt) => attempt.id === attemptId);
  const attempt = payment.attempts[attemptIndex];

  if (attemptIndex < 0 || attempt === undefined) {
    throw new DomainInvariantError(`Provider attempt "${attemptId}" does not exist.`);
  }

  if (attempt.status !== "STARTED") {
    throw new DomainInvariantError(`Provider attempt "${attemptId}" is already finished.`);
  }

  const finishedAttempt: ProviderAttempt = result.kind === "success"
    ? {
        ...attempt,
        status: "SUCCEEDED",
        providerReference: result.providerReference,
        finishedAt: now,
      }
    : {
        ...attempt,
        status: "FAILED",
        failureCode: result.code,
        retryable: result.retryable,
        finishedAt: now,
      };

  const attempts = [...payment.attempts];
  attempts[attemptIndex] = finishedAttempt;

  return {
    ...payment,
    attempts,
    version: payment.version + 1,
    updatedAt: now,
  };
}
