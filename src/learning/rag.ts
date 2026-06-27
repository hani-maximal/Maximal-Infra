import { and, desc, eq, sql } from "drizzle-orm";
import type { Incident } from "../types.js";
import { getDb } from "../db/client.js";
import { incidentOutcomes } from "../db/schema.js";

export interface SimilarOutcome {
  incidentType: string;
  service: string;
  environment: string;
  actionType: string | null;
  confidenceAtClassification: string;
  verificationPassed: boolean | null;
  rollbackTriggered: boolean;
  evidenceSummary: string;
}

// Full-text search over past incident_outcomes using Postgres tsvector.
// Falls back to incident-type + service match if no DB is configured.
//
// The returned rows are injected as few-shot examples into the classifier
// prompt so Claude reasons about YOUR environment's history, not generic
// AWS incident patterns.
export async function searchSimilarOutcomes(
  incident: Incident,
  tenantId: string,
  limit = 5
): Promise<SimilarOutcome[]> {
  const db = getDb();
  if (!db) return [];

  try {
    // Build a tsquery from the evidence summaries (first 5 significant words
    // each, OR'd together). Falls back to a type+tenant match if the
    // search produces no results.
    const searchTerms = incident.evidence
      .flatMap((e) =>
        e.summary
          .replace(/[^a-zA-Z0-9\s]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 3)
          .slice(0, 5)
      )
      .join(" | ");

    // Full-text search using Postgres tsvector on evidence_summary
    if (searchTerms.length > 0) {
      const ftsResults = await db
        .select({
          incidentType: incidentOutcomes.incidentType,
          service: incidentOutcomes.service,
          environment: incidentOutcomes.environment,
          actionType: incidentOutcomes.actionType,
          confidenceAtClassification: incidentOutcomes.confidenceAtClassification,
          verificationPassed: incidentOutcomes.verificationPassed,
          rollbackTriggered: incidentOutcomes.rollbackTriggered,
          evidenceSummary: incidentOutcomes.evidenceSummary,
        })
        .from(incidentOutcomes)
        .where(
          and(
            eq(incidentOutcomes.tenantId, tenantId),
            sql`to_tsvector('english', ${incidentOutcomes.evidenceSummary}) @@ to_tsquery('english', ${searchTerms})`
          )
        )
        .orderBy(desc(incidentOutcomes.createdAt))
        .limit(limit);

      if (ftsResults.length > 0) return ftsResults;
    }

    // Fallback: match by incident type (most relevant context for the classifier)
    return db
      .select({
        incidentType: incidentOutcomes.incidentType,
        service: incidentOutcomes.service,
        environment: incidentOutcomes.environment,
        actionType: incidentOutcomes.actionType,
        confidenceAtClassification: incidentOutcomes.confidenceAtClassification,
        verificationPassed: incidentOutcomes.verificationPassed,
        rollbackTriggered: incidentOutcomes.rollbackTriggered,
        evidenceSummary: incidentOutcomes.evidenceSummary,
      })
      .from(incidentOutcomes)
      .where(
        and(
          eq(incidentOutcomes.tenantId, tenantId),
          eq(incidentOutcomes.incidentType, incident.type)
        )
      )
      .orderBy(desc(incidentOutcomes.createdAt))
      .limit(limit);
  } catch (err) {
    // RAG is best-effort — a DB error must never block classification
    console.error("[rag] search error:", err instanceof Error ? err.message : err);
    return [];
  }
}
