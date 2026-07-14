import type { Clock, EventPublisher, OutboxEvent } from "../application/ports.js";
import { InMemoryDatabase } from "./in-memory-database.js";

export interface RelayResult {
  readonly scanned: number;
  readonly published: number;
  readonly failed: number;
}

export class OutboxRelay {
  private readonly database: InMemoryDatabase;
  private readonly publisher: EventPublisher;
  private readonly clock: Clock;

  public constructor(
    database: InMemoryDatabase,
    publisher: EventPublisher,
    clock: Clock,
  ) {
    this.database = database;
    this.publisher = publisher;
    this.clock = clock;
  }

  public async relayOnce(limit = 100): Promise<RelayResult> {
    const records = this.database.pendingOutboxEvents(limit);
    let published = 0;
    let failed = 0;

    for (const record of records) {
      this.database.recordDeliveryAttempt(record.event.id);
      try {
        await this.publisher.publish(record.event);
        this.database.markPublished(record.event.id, this.clock.now());
        published += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown publishing failure";
        this.database.recordDeliveryFailure(record.event.id, message);
        failed += 1;
      }
    }

    return {
      scanned: records.length,
      published,
      failed,
    };
  }
}

export class DeduplicatingEventConsumer implements EventPublisher {
  private readonly processedIds = new Set<string>();
  private readonly processedEvents: OutboxEvent[] = [];
  private deliveries = 0;

  public async publish(event: OutboxEvent): Promise<void> {
    this.deliveries += 1;
    if (this.processedIds.has(event.id)) {
      return;
    }

    this.processedIds.add(event.id);
    this.processedEvents.push(structuredClone(event));
  }

  public get deliveryCount(): number {
    return this.deliveries;
  }

  public get processedCount(): number {
    return this.processedEvents.length;
  }

  public get events(): readonly OutboxEvent[] {
    return structuredClone(this.processedEvents);
  }
}

export class FailOnceAfterDeliveryPublisher implements EventPublisher {
  private readonly downstream: EventPublisher;
  private shouldFail = true;

  public constructor(downstream: EventPublisher) {
    this.downstream = downstream;
  }

  public async publish(event: OutboxEvent): Promise<void> {
    await this.downstream.publish(event);
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error("Synthetic crash after downstream delivery and before outbox acknowledgement.");
    }
  }
}
