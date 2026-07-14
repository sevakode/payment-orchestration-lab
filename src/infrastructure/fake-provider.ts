import type {
  PaymentProvider,
  ProviderChargeCommand,
} from "../application/ports.js";
import type { ProviderResult } from "../domain/payment.js";

export type FakeProviderStep = ProviderResult | Error;

export interface FakeProviderOptions {
  readonly id: string;
  readonly priority: number;
  readonly supportedCurrencies: readonly string[];
  readonly minAmountMinor: number;
  readonly maxAmountMinor: number;
  readonly healthy?: boolean;
  readonly script?: readonly FakeProviderStep[];
}

export class FakePaymentProvider implements PaymentProvider {
  public readonly id: string;
  public readonly priority: number;
  public readonly supportedCurrencies: ReadonlySet<string>;
  public readonly minAmountMinor: number;
  public readonly maxAmountMinor: number;

  private healthy: boolean;
  private readonly script: FakeProviderStep[];
  private readonly resultsByAttemptId = new Map<string, ProviderResult>();
  private readonly commands: ProviderChargeCommand[] = [];

  public constructor(options: FakeProviderOptions) {
    this.id = options.id;
    this.priority = options.priority;
    this.supportedCurrencies = new Set(
      options.supportedCurrencies.map((currency) => currency.toUpperCase()),
    );
    this.minAmountMinor = options.minAmountMinor;
    this.maxAmountMinor = options.maxAmountMinor;
    this.healthy = options.healthy ?? true;
    this.script = [...(options.script ?? [])];
  }

  public isHealthy(): boolean {
    return this.healthy;
  }

  public setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  public get callCount(): number {
    return this.commands.length;
  }

  public get callLog(): readonly ProviderChargeCommand[] {
    return structuredClone(this.commands);
  }

  public async charge(command: ProviderChargeCommand): Promise<ProviderResult> {
    const cachedResult = this.resultsByAttemptId.get(command.attemptId);
    if (cachedResult !== undefined) {
      return structuredClone(cachedResult);
    }

    this.commands.push(structuredClone(command));
    const scriptedStep = this.script.shift();

    if (scriptedStep instanceof Error) {
      throw scriptedStep;
    }

    const result: ProviderResult = scriptedStep ?? {
      kind: "success",
      providerReference: `${this.id}-synthetic-${this.commands.length}`,
    };

    this.resultsByAttemptId.set(command.attemptId, structuredClone(result));
    return structuredClone(result);
  }
}
