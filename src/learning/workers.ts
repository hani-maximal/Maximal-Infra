import { Worker, type Job } from "bullmq";
import { QUEUE_NAMES } from "../queue/client.js";
import { writeOutcome } from "./outcome-writer.js";
import { runCalibration } from "./calibration.js";
import { learnContract } from "./contract-learner.js";
import type {
  OutcomeWriterJob,
  CalibrationJob,
  ContractLearnerJob,
} from "../queue/definitions.js";

// BullMQ workers manage their own Redis connections using the URL string —
// no shared ioredis instance needed, avoiding version conflicts.
function getConnectionOptions() {
  const url = process.env.REDIS_URL;
  return url ? { url } : null;
}

export function startWorkers(): (() => Promise<void>) | null {
  const connection = getConnectionOptions();
  if (!connection) {
    console.info("[workers] Redis not configured — learning pipeline workers disabled");
    return null;
  }

  const outcomeWorker = new Worker<OutcomeWriterJob>(
    QUEUE_NAMES.OUTCOME_WRITER,
    async (job: Job<OutcomeWriterJob>) => writeOutcome(job.data),
    { connection, concurrency: 10 }
  );

  const calibrationWorker = new Worker<CalibrationJob>(
    QUEUE_NAMES.CALIBRATION,
    async (job: Job<CalibrationJob>) => runCalibration(job.data),
    { connection, concurrency: 1 }
  );

  const contractWorker = new Worker<ContractLearnerJob>(
    QUEUE_NAMES.CONTRACT_LEARNER,
    async (job: Job<ContractLearnerJob>) => learnContract(job.data),
    { connection, concurrency: 3 }
  );

  const workers = [outcomeWorker, calibrationWorker, contractWorker];

  for (const worker of workers) {
    worker.on("failed", (job, err) => {
      console.error(
        `[worker:${worker.name}] job ${job?.id ?? "unknown"} failed:`,
        err.message
      );
    });
  }

  console.info("[workers] outcome-writer, calibration, contract-learner started");

  return async () => {
    await Promise.all(workers.map((w) => w.close()));
    console.info("[workers] all workers shut down");
  };
}
