import { EventEmitter } from "node:events";

// Single in-process event bus. Action handlers emit domain events when a
// meaningful state change occurs (post created, award granted, etc.).
// Subscribers (currently only the achievement engine, plus SSE per-user
// streams) react. The emitter is decoupled from the reactors — posts.ts
// does not know about achievements; achievements.ts does not know which
// route fired the event.
//
// In-process only: events do NOT survive a server restart and do NOT
// cross processes. Fine at single-instance scale; for multi-instance, swap
// this module for Redis pub/sub later (or layer Redis underneath the same
// emit() API).

// Discriminated union of every domain event. Every emit/listen site uses
// these names — typos are caught at compile time.
export type DomainEvent =
  | { type: "post_created"; userId: string }
  | { type: "comment_created"; userId: string }
  | { type: "award_granted"; granterId: string }
  | {
      type: "achievement_unlocked";
      userId: string;
      achievement: {
        id: string;
        key: string;
        name: string;
        description: string;
        rewardCoins: number;
      };
      newCoinBalance: number;
    };

// Node's EventEmitter is untyped. This thin wrapper enforces the union
// above so listeners get the correct payload type for the event name they
// subscribe to.
class TypedBus {
  private emitter = new EventEmitter();

  constructor() {
    // Without this, an unhandled-listener-error would crash the process.
    // We swallow listener errors and log — achievements going sideways
    // must never tank the request that triggered them.
    this.emitter.on("error", (err) => {
      console.error("[bus] listener error:", err);
    });
    // Bun's default maxListeners (10) is too low if many SSE clients
    // attach. Bump high — the cost is just memory.
    this.emitter.setMaxListeners(10_000);
  }

  emit<E extends DomainEvent>(event: E): void {
    // Forward to the underlying emitter so listeners fire synchronously.
    // Listeners themselves can be async; their promises run on next tick.
    this.emitter.emit(event.type, event);
  }

  on<T extends DomainEvent["type"]>(
    type: T,
    listener: (event: Extract<DomainEvent, { type: T }>) => void | Promise<void>,
  ): () => void {
    const wrapped = (event: Extract<DomainEvent, { type: T }>) => {
      Promise.resolve(listener(event)).catch((err) =>
        this.emitter.emit("error", err),
      );
    };
    this.emitter.on(type, wrapped as never);
    // Returning an unsubscribe handle is what makes per-request SSE
    // listeners safe — when the HTTP connection closes, we call the
    // returned function and avoid leaking listeners forever.
    return () => this.emitter.off(type, wrapped as never);
  }
}

export const bus = new TypedBus();
