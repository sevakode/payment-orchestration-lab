import { describe, expect, it } from "vitest";

import type { OutboxEvent } from "../src/application/ports.js";
import { InMemoryDatabase } from "../src/infrastructure/in-memory-database.js";
import {
  DeduplicatingEventConsumer,
  FailOnceAfterDeliveryPublisher,
  OutboxRelay,
} from "../src/infrastructure/outbox.js";
import { FixedClock } from "./helpers.js";

describe("outbox relay", () => {
  it("replays after an ambiguous failure while downstream deduplicates by event id", async () => {
    const database = new InMemoryDatabase();
    const event: OutboxEvent = {
      id: "synthetic-event-1",
      type: "payment.created",
      aggregateId: "synthetic-payment-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { synthetic: true },
    };
    database.transaction((transaction) => transaction.appendOutboxEvent(event));

    const consumer = new DeduplicatingEventConsumer();
    const publisher = new FailOnceAfterDeliveryPublisher(consumer);
    const relay = new OutboxRelay(database, publisher, new FixedClock());

    const firstRun = await relay.relayOnce();
    expect(firstRun).toEqual({ scanned: 1, published: 0, failed: 1 });
    expect(database.pendingOutboxEvents()).toHaveLength(1);
    expect(consumer.deliveryCount).toBe(1);
    expect(consumer.processedCount).toBe(1);

    const replay = await relay.relayOnce();
    expect(replay).toEqual({ scanned: 1, published: 1, failed: 0 });
    expect(database.pendingOutboxEvents()).toHaveLength(0);
    expect(consumer.deliveryCount).toBe(2);
    expect(consumer.processedCount).toBe(1);
    expect(database.allOutboxEvents()[0]?.deliveryAttempts).toBe(2);
  });
});
