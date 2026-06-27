import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "../db/client.js";
import {
  incidents,
  auditRecords,
  incidentOutcomes,
  proposedContractUpdates,
} from "../db/schema.js";
import type { ContractLearnerJob } from "../queue/definitions.js";

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic();
  return _client;
}

// Static system prompt — cached by Anthropic after the first call.
const SYSTEM_PROMPT = `You are Maximal's contract optimizer. You review an incident resolution timeline and propose improvements to the remediation contract that governed it.

Hard constraints:
- Only TIGHTEN safety rules: raise min_confidence, reduce blast radius, shorten verify windows only when evidence shows faster recovery
- NEVER loosen guardrails (lower min_confidence, widen blast radius, remove approval requirements)
- Only propose changes directly supported by the incident evidence
- If the incident was already well-handled by the current contract, say so and propose no changes

Output ONLY valid JSON:
{
  "proposedYaml": "<the contract sections to update, as valid YAML>",
  "rationale": "<concise justification ≤ 600 chars>"
}

If no changes are warranted, output:
{ "proposedYaml": "", "rationale": "Current contract handled this incident correctly." }`;

// Reads a resolved incident's audit timeline, builds structured context, and
// calls Claude to draft a proposed contract update for human review.
// The output is stored in proposed_contract_updates with status='pending';
// it is NEVER auto-applied to autonomy gating.
export async function learnContract(job: ContractLearnerJob): Promise<void> {
  const db = getDb();
  const client = getClient();
  if (!db || !client) return;

  const { tenantId, incidentId } = job;

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

  const [outcome] = await db
    .select()
    .from(incidentOutcomes)
    .where(eq(incidentOutcomes.incidentId, incidentId))
    .limit(1);

  // Historical success rate for this incident type
  const similar = await db
    .select({
      verificationPassed: incidentOutcomes.verificationPassed,
      timeToResolveMs: incidentOutcomes.timeToResolveMs,
    })
    .from(incidentOutcomes)
    .where(
      and(
        eq(incidentOutcomes.tenantId, tenantId),
        eq(incidentOutcomes.incidentType, incident.type),
        isNotNull(incidentOutcomes.verificationPassed)
      )
    )
    .orderBy(desc(incidentOutcomes.createdAt))
    .limit(20);

  const successRate =
    similar.length >= 3
      ? similar.filter((s) => s.verificationPassed).length / similar.length
      : null;

  // Compact timeline — truncate large payloads to keep prompt < 4k tokens
  const timelineText = records
    .map(
      (r) =>
        `[${r.ts}] ${r.eventType}: ${JSON.stringify(r.payload).slice(0, 300)}`
    )
    .join("\n")
    .slice(0, 4_000);

  const prompt =
    `Incident type: ${incident.type}\n` +
    `Service: ${incident.service} | Environment: ${incident.environment}\n` +
    `Final state: ${incident.state}\n` +
    (outcome
      ? `Confidence at classification: ${outcome.confidenceAtClassification}\n` +
        `Verification passed: ${outcome.verificationPassed}\n` +
        `Rollback triggered: ${outcome.rollbackTriggered}\n` +
        `Time to resolve: ${outcome.timeToResolveMs !== null ? `${Math.round(Number(outcome.timeToResolveMs) / 1000)}s` : "N/A"}\n`
      : "") +
    (successRate !== null
      ? `Historical success rate for this type: ${(successRate * 100).toFixed(1)}% (n=${similar.length})\n`
      : "Insufficient historical data for success rate.\n") +
    `\nAudit timeline:\n${timelineText}\n\nPropose contract improvements. Only tighten safety rules.`;

  try {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2_048,
      system: [
        {
          type: "text" as const,
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" as const },
        },
      ],
      messages: [{ role: "user" as const, content: prompt }],
    });

    const text =
      response.content[0]?.type === "text" ? response.content[0].text : null;
    if (!text) return;

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;

    const parsed = JSON.parse(match[0]) as {
      proposedYaml?: string;
      rationale?: string;
    };

    // Empty proposedYaml means "no changes warranted" — skip insert
    if (!parsed.proposedYaml || !parsed.rationale) return;
    if (parsed.proposedYaml.trim() === "") return;

    await db.insert(proposedContractUpdates).values({
      id: randomUUID(),
      tenantId,
      incidentType: incident.type,
      proposedYaml: parsed.proposedYaml,
      rationale: parsed.rationale.slice(0, 600),
      basedOnIncidentIds: [incidentId],
      status: "pending",
    });

    console.info(
      `[contract-learner] proposed update for ${incident.type} (incident=${incidentId})`
    );
  } catch (err) {
    console.error(
      "[contract-learner] error:",
      err instanceof Error ? err.message : err
    );
  }
}
