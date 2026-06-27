import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
  incidents,
  auditRecords,
  incidentOutcomes,
} from "../db/schema.js";
import type { OutcomeWriterJob } from "../queue/definitions.js";

// Writes a single IncidentOutcome row from the persisted audit chain.
// Called by the BullMQ worker after every CLOSED or ESCALATED transition.
// Idempotent: a second call for the same incidentId is a no-op.
export async function writeOutcome(job: OutcomeWriterJob): Promise<void> {
  const db = getDb();
  if (!db) return;

  const { tenantId, incidentId } = job;

  // Idempotency check — outcome may already exist if the job was retried
  const existing = await db
    .select({ id: incidentOutcomes.id })
    .from(incidentOutcomes)
    .where(eq(incidentOutcomes.incidentId, incidentId))
    .limit(1);
  if (existing.length > 0) return;

  const [incident] = await db
    .select()
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1);
  if (!incident) return;

  const records = await db
    .select()
    .from(auditRecords)
    .where(eq(auditRecords.incidentId, incidentId))
    .orderBy(auditRecords.ts);

  // Extract key signals from the audit trail
  const policyRecord = records.find((r) => r.eventType === "policy_decision");
  const classificationRecord = records.find((r) => r.eventType === "classification");
  const awsActionRecord = records.find((r) => r.eventType === "aws_action");
  const verificationRecord = records.find((r) => r.eventType === "verification");
  const rollbackRecord = records.find((r) => r.eventType === "rollback");
  const approvalRecord = records.find((r) => r.eventType === "approval_granted");
  const denialRecord = records.find((r) => r.eventType === "approval_denied");

  const policy = policyRecord?.payload as { decision?: string } | null;
  const classification = classificationRecord?.payload as { confidence?: number } | null;
  const awsAction = awsActionRecord?.payload as { actionType?: string } | null;
  const verification = verificationRecord?.payload as { ok?: boolean } | null;

  const createdMs = new Date(incident.createdAt ?? Date.now()).getTime();
  const lastRecord = records.at(-1);
  const terminalMs = lastRecord ? new Date(lastRecord.ts).getTime() : null;

  const evidence = (Array.isArray(incident.evidence) ? incident.evidence : []) as Array<{
    kind: string;
    summary: string;
  }>;
  const evidenceKinds = [...new Set(evidence.map((e) => e.kind))];
  const evidenceSummary = evidence
    .map((e) => e.summary)
    .join(" | ")
    .slice(0, 2_000);

  const isClosed = incident.state === "CLOSED" || incident.state === "RESOLVED";

  await db.insert(incidentOutcomes).values({
    id: randomUUID(),
    tenantId,
    incidentId,
    incidentType: incident.type,
    service: incident.service,
    environment: incident.environment,
    evidenceKinds,
    evidenceSummary,
    actionType: awsAction?.actionType ?? null,
    policyDecision: (policy?.decision ?? "ESCALATE") as "AUTO" | "APPROVE" | "ESCALATE",
    verificationPassed: verification?.ok ?? null,
    rollbackTriggered: Boolean(rollbackRecord),
    // humanOverrode = true if a human either approved or denied the action
    humanOverrode: Boolean(approvalRecord ?? denialRecord),
    timeToResolveMs:
      isClosed && terminalMs !== null ? terminalMs - createdMs : null,
    confidenceAtClassification: String(
      classification?.confidence ?? incident.confidence
    ),
    resolvedAt: isClosed && terminalMs !== null ? new Date(terminalMs) : null,
  });
}
