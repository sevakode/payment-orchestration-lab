import { randomUUID } from "node:crypto";

import type { Clock, IdGenerator } from "../application/ports.js";

export class SystemClock implements Clock {
  public now(): string {
    return new Date().toISOString();
  }
}

export class UuidGenerator implements IdGenerator {
  public next(): string {
    return randomUUID();
  }
}
