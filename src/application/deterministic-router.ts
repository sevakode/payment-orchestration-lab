import { DomainInvariantError } from "../domain/errors.js";
import type { NormalizedPaymentRequest } from "../domain/payment.js";
import type { PaymentProvider, PaymentRouter } from "./ports.js";

export class DeterministicPaymentRouter implements PaymentRouter {
  private readonly providers: readonly PaymentProvider[];

  public constructor(providers: readonly PaymentProvider[]) {
    const providerIds = new Set<string>();

    for (const provider of providers) {
      if (providerIds.has(provider.id)) {
        throw new DomainInvariantError(`Provider id "${provider.id}" is duplicated.`);
      }
      if (!Number.isInteger(provider.priority)) {
        throw new DomainInvariantError(`Provider "${provider.id}" must have an integer priority.`);
      }
      if (
        !Number.isSafeInteger(provider.minAmountMinor)
        || !Number.isSafeInteger(provider.maxAmountMinor)
        || provider.minAmountMinor < 0
        || provider.maxAmountMinor < provider.minAmountMinor
      ) {
        throw new DomainInvariantError(`Provider "${provider.id}" has invalid amount limits.`);
      }
      providerIds.add(provider.id);
    }

    this.providers = [...providers];
  }

  public routesFor(request: NormalizedPaymentRequest): readonly PaymentProvider[] {
    return this.providers
      .filter((provider) => provider.isHealthy())
      .filter((provider) => provider.supportedCurrencies.has(request.currency))
      .filter(
        (provider) => request.amountMinor >= provider.minAmountMinor
          && request.amountMinor <= provider.maxAmountMinor,
      )
      .sort((left, right) => {
        if (left.priority !== right.priority) {
          return left.priority - right.priority;
        }
        if (left.id === right.id) {
          return 0;
        }
        return left.id < right.id ? -1 : 1;
      });
  }
}
