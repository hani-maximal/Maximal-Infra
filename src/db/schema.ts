import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const automationDepthEnum = pgEnum("automation_depth", [
  "CONSERVATIVE",
  "SUPERVISED",
  "AUTOMATED",
]);

export const subscriptionTierEnum = pgEnum("subscription_tier", [
  "starter",
  "team",
  "scale",
  "enterprise",
]);

// ---------------------------------------------------------------------------
// tenants — one row per connected customer account (M7 multi-tenancy)
// ---------------------------------------------------------------------------
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  subscriptionTier: subscriptionTierEnum("subscription_tier").notNull().default("team"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// incidents — all lifecycle state, evidence, deploy correlation
// insert-only pattern: state updates via UPDATE (not append), audit log is
// the tamper-evident record; this table is queryable current state.
// ---------------------------------------------------------------------------
export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    type: varchar("type", { length: 120 }).notNull(),
    service: varchar("service", { length: 120 }).notNull(),
    environment: varchar("environment", { length: 80 }).notNull(),
    source: varchar("source", { length: 50 }).notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    evidence: jsonb("evidence").notNull().default("[]"),
    deployCorrelation: jsonb("deploy_correlation"),
    state: varchar("state", { length: 30 }).notNull().default("DETECTED"),
    plan: jsonb("plan"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantStateIdx: index("incidents_tenant_state_idx").on(t.tenantId, t.state),
    tenantCreatedIdx: index("incidents_tenant_created_idx").on(t.tenantId, t.createdAt),
  })
);

// ---------------------------------------------------------------------------
// audit_records — append-only, hash-chained tamper-evident log
// DB-level: no DELETE or UPDATE permissions granted on this table in prod.
// Hash chain: sha256(prevHash + canonicalJSON(payload) + ts)
// ---------------------------------------------------------------------------
export const auditRecords = pgTable(
  "audit_records",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    actor: varchar("actor", { length: 10 }).notNull(), // 'system' | 'human'
    actorId: text("actor_id"),
    eventType: varchar("event_type", { length: 50 }).notNull(),
    payload: jsonb("payload").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => ({
    incidentTsIdx: index("audit_incident_ts_idx").on(t.incidentId, t.ts),
    tenantIdx: index("audit_tenant_idx").on(t.tenantId),
  })
);

// ---------------------------------------------------------------------------
// snapshots — pre-action state captures; required before every execute()
// ---------------------------------------------------------------------------
export const snapshots = pgTable(
  "snapshots",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id),
    actionType: varchar("action_type", { length: 120 }).notNull(),
    resource: text("resource").notNull(),
    state: jsonb("state").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    incidentIdx: index("snapshots_incident_idx").on(t.incidentId),
  })
);

// ---------------------------------------------------------------------------
// incident_outcomes — the learning loop's foundation.
// One row per closed/escalated incident. Written by the outcome-writer worker.
// evidence_summary is used for Postgres full-text search (RAG).
// ---------------------------------------------------------------------------
export const incidentOutcomes = pgTable(
  "incident_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    incidentId: uuid("incident_id")
      .notNull()
      .unique()
      .references(() => incidents.id),
    incidentType: varchar("incident_type", { length: 120 }).notNull(),
    service: varchar("service", { length: 120 }).notNull(),
    environment: varchar("environment", { length: 80 }).notNull(),
    // Deduplicated list of evidence kinds (metric, log, alarm, deploy_event, …)
    evidenceKinds: text("evidence_kinds").array().notNull(),
    // Concatenated evidence summaries — indexed for full-text RAG search
    evidenceSummary: text("evidence_summary").notNull(),
    actionType: varchar("action_type", { length: 120 }),
    policyDecision: varchar("policy_decision", { length: 20 }).notNull(), // AUTO | APPROVE | ESCALATE
    verificationPassed: boolean("verification_passed"),
    rollbackTriggered: boolean("rollback_triggered").notNull().default(false),
    humanOverrode: boolean("human_overrode").notNull().default(false),
    timeToResolveMs: bigint("time_to_resolve_ms", { mode: "number" }),
    confidenceAtClassification: numeric("confidence_at_classification", {
      precision: 5,
      scale: 4,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    tenantTypeIdx: index("outcomes_tenant_type_idx").on(t.tenantId, t.incidentType),
    tenantServiceIdx: index("outcomes_tenant_service_idx").on(
      t.tenantId,
      t.service,
      t.environment
    ),
  })
);

// ---------------------------------------------------------------------------
// service_baselines — rolling per-service metric statistics for dynamic
// verify.checks thresholds. Computed by the baseline-learn worker.
// ---------------------------------------------------------------------------
export const serviceBaselines = pgTable(
  "service_baselines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    service: varchar("service", { length: 120 }).notNull(),
    environment: varchar("environment", { length: 80 }).notNull(),
    metricName: varchar("metric_name", { length: 120 }).notNull(),
    mean: numeric("mean", { precision: 12, scale: 4 }),
    stddev: numeric("stddev", { precision: 12, scale: 4 }),
    p50: numeric("p50", { precision: 12, scale: 4 }),
    p95: numeric("p95", { precision: 12, scale: 4 }),
    sampleCount: integer("sample_count").notNull().default(0),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueServiceMetric: uniqueIndex("baselines_service_metric_uidx").on(
      t.tenantId,
      t.service,
      t.environment,
      t.metricName
    ),
  })
);

// ---------------------------------------------------------------------------
// calibration_records — confidence calibration buckets.
// For each incident type and confidence range, what fraction actually resolved?
// Computed weekly by the calibration worker.
// ---------------------------------------------------------------------------
export const calibrationRecords = pgTable(
  "calibration_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    incidentType: varchar("incident_type", { length: 120 }).notNull(),
    confidenceBucketLow: numeric("confidence_bucket_low", { precision: 3, scale: 2 }).notNull(),
    confidenceBucketHigh: numeric("confidence_bucket_high", { precision: 3, scale: 2 }).notNull(),
    sampleCount: integer("sample_count").notNull(),
    actualSuccessRate: numeric("actual_success_rate", { precision: 5, scale: 4 }).notNull(),
    meanTimeToResolveMs: bigint("mean_time_to_resolve_ms", { mode: "number" }),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantTypeIdx: index("calibration_tenant_type_idx").on(t.tenantId, t.incidentType),
  })
);

// ---------------------------------------------------------------------------
// trust_configs — per-tenant, per-incident-type automation depth configuration.
// Controls whether known contracts require human approval and how novel
// (uncontracted) incidents are routed. Safety invariants (ESCALATE decisions,
// snapshot+revert, typed actions) are never overridden regardless of depth.
//
// incidentType is nullable: NULL = tenant-wide default, non-null = type-specific.
// Two partial unique indexes enforce: one default per tenant, one config per type.
// ---------------------------------------------------------------------------
export const trustConfigs = pgTable(
  "trust_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    incidentType: varchar("incident_type", { length: 120 }), // null = tenant default
    automationDepth: automationDepthEnum("automation_depth")
      .notNull()
      .default("CONSERVATIVE"),
    novelIncidentConfidenceThreshold: numeric("novel_incident_confidence_threshold", {
      precision: 4,
      scale: 3,
    })
      .notNull()
      .default("0.950"),
    maxBlastRadiusOverride: integer("max_blast_radius_override"),
    requiresApprovalOverride: boolean("requires_approval_override"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    specificTypeIdx: uniqueIndex("trust_configs_tenant_type_uidx")
      .on(t.tenantId, t.incidentType)
      .where(sql`${t.incidentType} IS NOT NULL`),
    defaultIdx: uniqueIndex("trust_configs_tenant_default_uidx")
      .on(t.tenantId)
      .where(sql`${t.incidentType} IS NULL`),
    tenantIdx: index("trust_configs_tenant_idx").on(t.tenantId),
  })
);

// ---------------------------------------------------------------------------
// proposed_contract_updates — LLM-drafted contract changes pending human review.
// NEVER auto-applied to autonomy gating without explicit sign-off (§9.10).
// ---------------------------------------------------------------------------
export const proposedContractUpdates = pgTable(
  "proposed_contract_updates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    incidentType: varchar("incident_type", { length: 120 }).notNull(),
    proposedYaml: text("proposed_yaml").notNull(),
    rationale: text("rationale").notNull(),
    basedOnIncidentIds: uuid("based_on_incident_ids").array().notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | approved | rejected
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantStatusIdx: index("proposals_tenant_status_idx").on(t.tenantId, t.status),
  })
);
