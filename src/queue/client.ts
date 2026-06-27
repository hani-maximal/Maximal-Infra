import { Queue } from "bullmq";

export const QUEUE_NAMES = {
  OUTCOME_WRITER: "maximal:outcome-writer",
  CALIBRATION: "maximal:calibration",
  CONTRACT_LEARNER: "maximal:contract-learner",
  BASELINE_LEARN: "maximal:baseline-learn",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// Singleton queue map — one Queue instance per name.
// BullMQ manages its own Redis connection per queue using the URL string.
const _queues = new Map<QueueName, Queue>();

function getRedisConnectionOptions() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  // BullMQ accepts { url } as ConnectionOptions — it creates its own ioredis
  // client internally, avoiding version conflicts with our ioredis instance.
  return { url };
}

export function getQueue<T = unknown>(name: QueueName): Queue<T> | null {
  if (_queues.has(name)) return _queues.get(name) as Queue<T>;

  const connection = getRedisConnectionOptions();
  if (!connection) return null;

  const queue = new Queue<T>(name, {
    connection,
    defaultJobOptions: {
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 200 },
    },
  });

  _queues.set(name, queue as Queue<unknown>);
  return queue;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([..._queues.values()].map((q) => q.close()));
  _queues.clear();
}
