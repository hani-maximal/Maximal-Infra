import { z } from "zod";

/**
 * Safety thresholds for auto-remediation. These are deliberately conservative.
 *
 * - MIN_CONTRACT_CONFIDENCE_FLOOR: hard boot floor. No contract may set a
 *   min_confidence below this — an invalid contract is a hard boot failure.
 *   Below this level the classification itself is suspect, so the system must
 *   refuse to act rather than merely ask for approval.
 * - DEFAULT_MIN_CONFIDENCE: the short-term auto-action target. Contracts that
 *   don't specify min_confidence inherit this.
 * - MIN_CORROBORATING_EVIDENCE_KINDS: a single metric crossing a threshold is
 *   not high confidence. Require independent evidence kinds (e.g. a metric AND
 *   a log/alarm/deploy_event) before any execution is permitted.
 */
export const MIN_CONTRACT_CONFIDENCE_FLOOR = 0.9;
export const DEFAULT_MIN_CONFIDENCE = 0.95;
export const MIN_CORROBORATING_EVIDENCE_KINDS = 2;

export const incidentTypes = [
  "post_deploy_5xx_spike",
  "ecs_service_unhealthy",
  "lambda_error_spike",
  "deploy_failed_or_stuck",
  "alb_latency_saturation",
  "alb_target_unhealthy_no_deploy",
  "dependency_5xx_timeout_spike",
  "ec2_asg_unhealthy_hosts",
  "ec2_disk_full",
  "ec2_instance_status_check_failed",
  "ecs_image_pull_failed",
  "ecs_task_placement_capacity_failed",
  "eks_deployment_rollout_failed",
  "eks_node_not_ready",
  "elasticache_memory_pressure_evictions",
  "fargate_service_unhealthy",
  "fargate_task_oom_kill",
  "lambda_throttling_concurrency_exhausted",
  "lambda_timeout_duration_spike",
  "lightsail_container_deployment_failed",
  "lightsail_instance_unhealthy",
  "rds_connection_saturation",
  "sqs_worker_backlog_saturation"
] as const;

export const IncidentTypeSchema = z.enum(incidentTypes);
export type IncidentType = z.infer<typeof IncidentTypeSchema>;

export const SourceSchema = z.enum([
  "aws_devops_agent",
  "datadog",
  "pagerduty",
  "self_detect"
]);

export const IncidentStateSchema = z.enum([
  "DETECTED",
  "CLASSIFIED",
  "CONTRACT_MATCHED",
  "AWAITING_APPROVAL",
  "EXECUTING",
  "VERIFYING",
  "RESOLVED",
  "ROLLING_BACK",
  "ROLLED_BACK",
  "ESCALATED",
  "CLOSED"
]);

export const EvidenceSchema = z.object({
  kind: z.enum(["metric", "log", "config", "deploy_event", "cloudtrail", "alarm"]),
  ref: z.string().min(1).max(500),
  summary: z.string().min(1).max(2_000),
  value: z.number().optional(),
  observedAt: z.string().datetime(),
  location: z.object({
    resource: z.string().min(1).max(500),
    source: z.string().min(1).max(500),
    selector: z.string().min(1).max(500)
  }).optional(),
  excerpt: z.string().min(1).max(8_000).optional(),
  interpretation: z.string().min(1).max(2_000).optional(),
  remediation: z.object({
    actionType: z.string().min(1),
    explanation: z.string().min(1).max(2_000)
  }).optional()
});

export const IncidentSchema = z.object({
  id: z.string().uuid(),
  type: IncidentTypeSchema,
  service: z.string().min(1).max(120),
  environment: z.string().min(1).max(80),
  source: SourceSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceSchema).min(1),
  deployCorrelation: z.object({
    deployId: z.string().min(1),
    deployedAt: z.string().datetime(),
    artifactRef: z.string().min(1)
  }).nullable(),
  state: IncidentStateSchema,
  createdAt: z.string().datetime()
});
export type Incident = z.infer<typeof IncidentSchema>;

export const ContractSchema = z.object({
  incident_type: IncidentTypeSchema,
  source: z.array(SourceSchema).min(1),
  detect: z.record(z.unknown()),
  min_confidence: z
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_MIN_CONFIDENCE)
    .refine((v) => v >= MIN_CONTRACT_CONFIDENCE_FLOOR, {
      message: `min_confidence must be >= ${MIN_CONTRACT_CONFIDENCE_FLOOR} (auto-remediation confidence floor)`
    }),
  allowed_actions: z.array(z.string().min(1)).min(1),
  approval: z.object({
    mode: z.enum(["always_human", "auto_under_blast_radius"]),
    blast_radius: z.object({
      max_affected_services: z.number().int().positive(),
      environments: z.array(z.string()).min(1),
      allowed_action_types: z.array(z.string()),
      require_reversible: z.boolean().default(true)
    })
  }),
  verify: z.object({
    window: z.string().min(1),
    checks: z.array(z.object({
      metric: z.string().min(1),
      condition: z.string().min(1)
    })).min(1)
  }),
  rollback_if_failed: z.boolean().default(true),
  on_resolve: z.object({
    draft_postmortem: z.boolean().default(true),
    learn_contract: z.boolean().default(true)
  }),
  notify: z.object({ slack_channel: z.string().min(1) })
});
export type Contract = z.infer<typeof ContractSchema>;

export const AuditEventTypeSchema = z.enum([
  "signal",
  "hypothesis",
  "classification",
  "contract_match",
  "policy_decision",
  "approval_request",
  "approval_granted",
  "approval_denied",
  "snapshot",
  "aws_action",
  "verification",
  "rollback",
  "escalation",
  "postmortem",
  "state_change"
]);

export const AuditRecordSchema = z.object({
  id: z.string().uuid(),
  incidentId: z.string().uuid(),
  ts: z.string().datetime(),
  actor: z.enum(["system", "human"]),
  actorId: z.string().nullable(),
  eventType: AuditEventTypeSchema,
  payload: z.unknown(),
  prevHash: z.string(),
  hash: z.string()
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

export const AutonomyModeSchema = z.enum(["observe", "approve", "bounded_auto"]);
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;

export interface ServiceContext {
  service: string;
  environment: string;
  dependencies: string[];
  allowedActions: string[];
  resources: {
    ecs?: { cluster: string; service: string };
    lambda?: { functionName: string; alias: string };
    ec2?: { instanceId: string; region: string };
  };
}

export interface BlastRadiusResult {
  affectedServices: string[];
  environment: string;
  actionType: string;
}

export interface Snapshot {
  id: string;
  actionType: string;
  resource: string;
  state: Record<string, unknown>;
  capturedAt: string;
}

export interface ActionResult {
  ok: boolean;
  actionType: string;
  awsCalls: Array<{ api: string; input: unknown; at: string }>;
  snapshotId: string;
  message: string;
}

export interface VerificationResult {
  ok: boolean;
  checks: Array<{ metric: string; condition: string; passed: boolean; observed: string }>;
}

// ---------------------------------------------------------------------------
// Learning pipeline types
// ---------------------------------------------------------------------------

// Advisory output of the LLM classifier. Never authorizes an action —
// only updates the confidence score (conservatively) and provides a
// structured evidence summary for the audit trail and postmortem.
export const ClassifierHypothesisSchema = z.object({
  incidentType: IncidentTypeSchema,
  confidence: z.number().min(0).max(1),
  evidenceSummary: z.string().min(1).max(4_000),
  reasoning: z.string().min(1).max(8_000),
  calibrationNote: z.string().max(1_000).optional(),
});
export type ClassifierHypothesis = z.infer<typeof ClassifierHypothesisSchema>;

// Outcome record written after every terminal incident (CLOSED / ESCALATED).
// The foundation of the confidence calibration and RAG pipelines.
export const IncidentOutcomeSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  incidentId: z.string().uuid(),
  incidentType: IncidentTypeSchema,
  service: z.string().min(1).max(120),
  environment: z.string().min(1).max(80),
  evidenceKinds: z.array(z.string()),
  evidenceSummary: z.string(),
  actionType: z.string().nullable(),
  policyDecision: z.enum(["AUTO", "APPROVE", "ESCALATE"]),
  verificationPassed: z.boolean().nullable(),
  rollbackTriggered: z.boolean(),
  humanOverrode: z.boolean(),
  timeToResolveMs: z.number().int().nullable(),
  confidenceAtClassification: z.number().min(0).max(1),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
});
export type IncidentOutcome = z.infer<typeof IncidentOutcomeSchema>;

// Per-incident-type, per-confidence-bucket calibration statistics.
export const CalibrationRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  incidentType: IncidentTypeSchema,
  confidenceBucketLow: z.number().min(0).max(1),
  confidenceBucketHigh: z.number().min(0).max(1),
  sampleCount: z.number().int().nonnegative(),
  actualSuccessRate: z.number().min(0).max(1),
  meanTimeToResolveMs: z.number().int().nullable(),
  computedAt: z.string().datetime(),
});
export type CalibrationRecord = z.infer<typeof CalibrationRecordSchema>;

// LLM-drafted contract update pending human review.
// NEVER auto-applied to autonomy gating without sign-off.
export const ProposedContractUpdateSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  incidentType: IncidentTypeSchema,
  proposedYaml: z.string().min(1),
  rationale: z.string().min(1),
  basedOnIncidentIds: z.array(z.string().uuid()),
  status: z.enum(["pending", "approved", "rejected"]),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ProposedContractUpdate = z.infer<typeof ProposedContractUpdateSchema>;

// Per-tenant, per-incident-type automation depth configuration.
// automationDepth controls the approval gate for known contracts and novel-incident routing.
// Safety invariants (ESCALATE, snapshot+revert, typed actions) are never overridden.
export const AutomationDepthSchema = z.enum(["CONSERVATIVE", "SUPERVISED", "AUTOMATED"]);
export type AutomationDepth = z.infer<typeof AutomationDepthSchema>;

export const SubscriptionTierSchema = z.enum(["starter", "team", "scale", "enterprise"]);
export type SubscriptionTier = z.infer<typeof SubscriptionTierSchema>;

export const TrustConfigSchema = z.object({
  tenantId: z.string().uuid(),
  incidentType: z.string().nullable(),
  automationDepth: AutomationDepthSchema.default("CONSERVATIVE"),
  novelIncidentConfidenceThreshold: z.number().min(0).max(1).default(0.95),
  maxBlastRadiusOverride: z.number().int().positive().nullable(),
  requiresApprovalOverride: z.boolean().nullable(),
});
export type TrustConfig = z.infer<typeof TrustConfigSchema>;

// Rolling per-service metric baseline computed by the baseline-learn worker.
export const ServiceBaselineSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  service: z.string().min(1).max(120),
  environment: z.string().min(1).max(80),
  metricName: z.string().min(1).max(120),
  mean: z.number().nullable(),
  stddev: z.number().nullable(),
  p50: z.number().nullable(),
  p95: z.number().nullable(),
  sampleCount: z.number().int().nonnegative(),
  computedAt: z.string().datetime(),
});
export type ServiceBaseline = z.infer<typeof ServiceBaselineSchema>;
