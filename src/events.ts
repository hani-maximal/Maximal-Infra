import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Incident } from "./types.js";

export interface IncidentUpdatedEvent {
  type: "incident_updated";
  incidentId: string;
  state: Incident["state"];
  service: string;
  incidentType: Incident["type"];
  tenantId: string;
  ts: string;
}

// Unique per process — used to suppress re-emitting our own Redis publishes.
const INSTANCE_ID = randomUUID();
const REDIS_CHANNEL = "mx:incidents:events";

// In-process bus. All SSE connections on this instance subscribe here.
// setMaxListeners(256) accommodates many concurrent browser tabs / sessions.
const bus = new EventEmitter();
bus.setMaxListeners(256);

// Subscribe to incident state-change events. Returns an unsubscribe function.
export function onIncidentUpdated(
  listener: (e: IncidentUpdatedEvent) => void
): () => void {
  bus.on("incident_updated", listener);
  return () => bus.off("incident_updated", listener);
}

// Emit a state-change event to all local subscribers and fan out to Redis
// pub/sub so other instances receive it too.
export function emitIncidentUpdate(
  event: Omit<IncidentUpdatedEvent, "type">
): void {
  const full: IncidentUpdatedEvent = { type: "incident_updated", ...event };
  bus.emit("incident_updated", full);
  broadcastToRedis(full).catch(() => {});
}

async function broadcastToRedis(event: IncidentUpdatedEvent): Promise<void> {
  const { getRedis } = await import("./cache/client.js");
  const redis = getRedis();
  if (!redis) return;
  await redis.publish(
    REDIS_CHANNEL,
    JSON.stringify({ ...event, _origin: INSTANCE_ID })
  );
}

// Subscribe to the Redis channel and re-emit events from other instances.
// Call once at startup when Redis is configured.
// Returns a cleanup function to call on app shutdown.
export async function subscribeToRedisChannel(): Promise<() => Promise<void>> {
  const { getRedisDuplicate } = await import("./cache/client.js");
  const sub = getRedisDuplicate();
  if (!sub) return async () => {};

  await sub.subscribe(REDIS_CHANNEL);

  sub.on("message", (_ch: string, raw: string) => {
    try {
      const msg = JSON.parse(raw) as IncidentUpdatedEvent & {
        _origin?: string;
      };
      // Skip events that this instance already emitted locally
      if (msg._origin === INSTANCE_ID) return;
      const event: IncidentUpdatedEvent = {
        type: msg.type,
        incidentId: msg.incidentId,
        state: msg.state,
        service: msg.service,
        incidentType: msg.incidentType,
        tenantId: msg.tenantId,
        ts: msg.ts,
      };
      bus.emit("incident_updated", event);
    } catch {}
  });

  return async () => {
    await sub.unsubscribe(REDIS_CHANNEL);
    await sub.quit();
  };
}

// ── Contract reload pub/sub ───────────────────────────────────────────────────

const CONTRACT_RELOAD_PREFIX = "mx:contracts:reload:";

// Publish a reload signal to all engine instances for a given tenant.
export async function publishContractReload(tenantId: string): Promise<void> {
  const { getRedis } = await import("./cache/client.js");
  const redis = getRedis();
  if (!redis) return;
  await redis.publish(`${CONTRACT_RELOAD_PREFIX}${tenantId}`, tenantId);
}

// Subscribe to contract reload signals. The handler is called with the tenantId
// whenever another instance (or the proposal pipeline) triggers a reload.
// Returns a cleanup function to call on app shutdown.
export async function subscribeToContractReloads(
  handler: (tenantId: string) => Promise<void>
): Promise<() => Promise<void>> {
  const { getRedisDuplicate } = await import("./cache/client.js");
  const sub = getRedisDuplicate();
  if (!sub) return async () => {};

  await sub.psubscribe(`${CONTRACT_RELOAD_PREFIX}*`);

  sub.on("pmessage", (_pattern: string, channel: string, message: string) => {
    const tenantId = message || channel.slice(CONTRACT_RELOAD_PREFIX.length);
    handler(tenantId).catch((err: unknown) => {
      console.error("[events] Contract reload handler failed:", err instanceof Error ? err.message : err);
    });
  });

  return async () => {
    await sub.punsubscribe(`${CONTRACT_RELOAD_PREFIX}*`);
    await sub.quit();
  };
}
