import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { incidentOutcomes, calibrationRecords } from "../db/schema.js";
import type { CalibrationJob } from "../queue/definitions.js";

// Confidence buckets that map to the calibration records table.
// Bucket [0.90, 0.93) captures incidents near the hard safety floor.
// Bucket [0.98, 1.00] captures the high-confidence autonomous range.
const CONFIDENCE_BUCKETS: ReadonlyArray<readonly [number, number]> = [
  [0.90, 0.93],
  [0.93, 0.96],
  [0.96, 0.98],
  [0.98, 1.00],
] as const;

// Minimum sample size before we trust a bucket's statistics.
const MIN_BUCKET_SAMPLES = 3;

// Computes per-incident-type, per-confidence-bucket calibration statistics
// from all outcomes recorded for a tenant and writes them to the DB.
//
// The results feed back into the classifier's system prompt as context:
// "When you assigned confidence 0.91–0.93 for lambda_error_spike incidents,
// the action verified successfully 67% of the time." This lets Claude
// calibrate its own confidence outputs against real outcomes.
export async function runCalibration(job: CalibrationJob): Promise<void> {
  const db = getDb();
  if (!db) return;

  const { tenantId } = job;

  const outcomes = await db
    .select({
      incidentType: incidentOutcomes.incidentType,
      confidenceAtClassification: incidentOutcomes.confidenceAtClassification,
      verificationPassed: incidentOutcomes.verificationPassed,
      timeToResolveMs: incidentOutcomes.timeToResolveMs,
    })
    .from(incidentOutcomes)
    .where(eq(incidentOutcomes.tenantId, tenantId));

  if (outcomes.length === 0) return;

  // Group by incident type first
  const byType = new Map<string, typeof outcomes>();
  for (const outcome of outcomes) {
    const list = byType.get(outcome.incidentType) ?? [];
    list.push(outcome);
    byType.set(outcome.incidentType, list);
  }

  const newRecords: Parameters<typeof db.insert>[0] extends (...args: infer A) => unknown
    ? never
    : Array<{
        id: string;
        tenantId: string;
        incidentType: string;
        confidenceBucketLow: string;
        confidenceBucketHigh: string;
        sampleCount: number;
        actualSuccessRate: string;
        meanTimeToResolveMs: number | null;
      }> = [];

  for (const [incidentType, typeOutcomes] of byType) {
    for (const [bucketLow, bucketHigh] of CONFIDENCE_BUCKETS) {
      const bucketItems = typeOutcomes.filter((o) => {
        const conf = Number(o.confidenceAtClassification);
        return conf >= bucketLow && conf < bucketHigh;
      });

      if (bucketItems.length < MIN_BUCKET_SAMPLES) continue;

      const resolved = bucketItems.filter((o) => o.verificationPassed === true).length;
      const successRate = resolved / bucketItems.length;

      const times = bucketItems
        .map((o) => o.timeToResolveMs)
        .filter((t): t is number => t !== null);
      const meanTime =
        times.length > 0
          ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
          : null;

      newRecords.push({
        id: randomUUID(),
        tenantId,
        incidentType,
        confidenceBucketLow: String(bucketLow),
        confidenceBucketHigh: String(bucketHigh),
        sampleCount: bucketItems.length,
        actualSuccessRate: successRate.toFixed(4),
        meanTimeToResolveMs: meanTime,
      });
    }
  }

  if (newRecords.length > 0) {
    await db.insert(calibrationRecords).values(newRecords);
    console.info(
      `[calibration] tenant=${tenantId} wrote ${newRecords.length} calibration record(s)`
    );
  }
}

// Returns the latest calibration record for a given tenant + incident type +
// confidence value, if one exists. Used by the classifier to include
// calibration context in the prompt.
export async function getCalibrationContext(
  tenantId: string,
  incidentType: string
): Promise<string> {
  const db = getDb();
  if (!db) return "";

  try {
    const records = await db
      .select({
        confidenceBucketLow: calibrationRecords.confidenceBucketLow,
        confidenceBucketHigh: calibrationRecords.confidenceBucketHigh,
        sampleCount: calibrationRecords.sampleCount,
        actualSuccessRate: calibrationRecords.actualSuccessRate,
        meanTimeToResolveMs: calibrationRecords.meanTimeToResolveMs,
      })
      .from(calibrationRecords)
      .where(
        and(
          eq(calibrationRecords.tenantId, tenantId),
          eq(calibrationRecords.incidentType, incidentType)
        )
      )
      .orderBy(calibrationRecords.computedAt)
      .limit(4);

    if (records.length === 0) return "";

    const lines = records.map(
      (r) =>
        `  confidence ${r.confidenceBucketLow}–${r.confidenceBucketHigh}: ` +
        `${(Number(r.actualSuccessRate) * 100).toFixed(1)}% resolved ` +
        `(n=${r.sampleCount}${r.meanTimeToResolveMs ? `, avg ${Math.round(Number(r.meanTimeToResolveMs) / 1000)}s` : ""})`
    );

    return `\nHistorical calibration for ${incidentType} in this environment:\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}
