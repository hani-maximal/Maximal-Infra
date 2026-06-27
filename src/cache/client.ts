import { Redis } from "ioredis";

let _redis: InstanceType<typeof Redis> | null = null;

export function getRedis(): InstanceType<typeof Redis> | null {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;

  _redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    // TLS — ElastiCache with in-transit encryption uses rediss:// scheme;
    // ioredis picks this up automatically from the URL.
    // For an explicit override set REDIS_TLS=true.
    tls: process.env.REDIS_TLS === "true" ? {} : undefined,
  });

  _redis.on("error", (err: Error) => {
    // Log but never crash — caching and queuing are additive; the app
    // degrades gracefully without Redis (in-memory fallback for dev).
    console.error("[redis] connection error:", err.message);
  });

  _redis.on("connect", () => {
    console.info("[redis] connected");
  });

  return _redis;
}

// Dedicated subscriber connection — Redis pub/sub requires a separate client
// that cannot be used for regular commands once it enters subscribe mode.
let _redisSub: InstanceType<typeof Redis> | null = null;

export function getRedisDuplicate(): InstanceType<typeof Redis> | null {
  if (_redisSub) return _redisSub;
  const url = process.env.REDIS_URL;
  if (!url) return null;

  _redisSub = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    tls: process.env.REDIS_TLS === "true" ? {} : undefined,
  });

  _redisSub.on("error", (err: Error) => {
    console.error("[redis-sub] connection error:", err.message);
  });

  return _redisSub;
}

export async function closeRedis(): Promise<void> {
  if (_redisSub) {
    await _redisSub.quit().catch(() => {});
    _redisSub = null;
  }
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
