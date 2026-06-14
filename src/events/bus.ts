import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import { redisUrl } from "../utils/env";

// Single in-process event bus. Action handlers emit domain events when a
// meaningful state change occurs (post created, award granted, etc.).
// Subscribers (currently only the achievement engine, plus SSE per-user
// streams) react. The emitter is decoupled from the reactors — posts.ts
// does not know about achievements; achievements.ts does not know which
// route fired the event.
//
// TRANSPORT (in-process vs Redis) is an implementation detail behind the
// same emit()/on() API:
//
//  • Most events are LOCAL-ONLY. Their consumer (the achievement engine)
//    writes to Postgres and must run EXACTLY ONCE — on the single instance
//    that handled the request. Broadcasting them across instances would
//    double-grant. So they never touch Redis.
//
//  • "Fan-out" events (FANOUT_TYPES below — currently just
//    achievement_unlocked) must reach a specific user's SSE stream, which
//    may be held open on a DIFFERENT instance. When REDIS_URL is set we
//    PUBLISH these to a Redis channel; every instance's subscriber receives
//    them (including this one's) and re-emits locally, so the instance
//    holding that user's connection pushes the toast. The SSE handler does
//    no DB write, so broadcast-and-filter is safe. Redis pub/sub is lossy
//    by design — fine here: the achievement DATA is already durable in
//    Postgres, only the live toast is ephemeral.
//
// With REDIS_URL UNSET the bus is purely in-process — correct and
// sufficient at single-instance scale, and the dev default (no Redis
// required to run pigweed locally).

const FANOUT_CHANNEL = "pigweed:fanout";

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

// Event types that must cross instance boundaries. Keep this minimal:
// only add a type here if its consumer is connection-targeted and does NO
// non-idempotent side effect (no DB write). Everything else stays local.
const FANOUT_TYPES = new Set<DomainEvent["type"]>(["achievement_unlocked"]);

// Node's EventEmitter is untyped. This thin wrapper enforces the union
// above so listeners get the correct payload type for the event name they
// subscribe to.
class TypedBus {
  private emitter = new EventEmitter();

  // Redis connections. Only created when REDIS_URL is set. Two are needed:
  // a connection in "subscriber mode" cannot issue other commands, so the
  // publisher gets its own. Null ⇒ pure in-process transport.
  private pub: Redis | null = null;
  private sub: Redis | null = null;

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

    this.connectRedis();
  }

  // Wire up Redis pub/sub if configured. Failures here are non-fatal: the
  // bus keeps working in-process, we just lose cross-instance delivery.
  private connectRedis(): void {
    const url = redisUrl();
    if (!url) return;

    // ioredis enables TLS automatically for rediss:// URLs (Upstash).
    this.pub = new Redis(url);
    this.sub = new Redis(url);

    this.pub.on("error", (err) => console.error("[bus] redis pub error:", err));
    this.sub.on("error", (err) => console.error("[bus] redis sub error:", err));

    this.sub.subscribe(FANOUT_CHANNEL, (err) => {
      if (err) {
        console.error("[bus] redis subscribe failed:", err);
        return;
      }
      console.log(`[bus] redis fan-out active on "${FANOUT_CHANNEL}"`);
    });

    // A fan-out event arrived from SOME instance (possibly this one). Emit
    // it locally so this instance's SSE listeners can react. ioredis
    // auto-resubscribes after a reconnect, so no manual re-wiring needed.
    this.sub.on("message", (channel, payload) => {
      if (channel !== FANOUT_CHANNEL) return;
      try {
        const event = JSON.parse(payload) as DomainEvent;
        this.localEmit(event);
      } catch (err) {
        console.error("[bus] bad fan-out payload:", err);
      }
    });
  }

  // Deliver to in-process listeners synchronously.
  private localEmit(event: DomainEvent): void {
    this.emitter.emit(event.type, event);
  }

  emit<E extends DomainEvent>(event: E): void {
    // Fan-out type AND Redis configured → publish only. Redis delivers to
    // every subscriber INCLUDING this instance's own `sub`, which then
    // re-emits locally (see the "message" handler). Emitting locally here
    // too would double-fire on this instance.
    if (FANOUT_TYPES.has(event.type) && this.pub) {
      this.pub.publish(FANOUT_CHANNEL, JSON.stringify(event)).catch((err) =>
        console.error("[bus] redis publish failed:", err),
      );
      return;
    }

    // Local-only event, or no Redis configured → deliver in-process.
    this.localEmit(event);
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
