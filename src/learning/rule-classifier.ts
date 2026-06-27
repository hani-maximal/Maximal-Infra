import type { Incident, ClassifierHypothesis } from "../types.js";
import { DEFAULT_MIN_CONFIDENCE } from "../types.js";

// Deterministic rules for high-confidence incident patterns. Each rule
// returns a hypothesis only when evidence is unambiguous — if the evidence
// kit is incomplete or mixed, return null to let the LLM tiers handle it.
//
// These rules reflect what the detector already knows; the purpose here is
// to confirm (and score) patterns that don't need LLM reasoning. Rules must
// never raise confidence above what the evidence directly supports.

type RuleFn = (incident: Incident) => {
  confidence: number;
  evidenceSummary: string;
  reasoning: string;
} | null;

function kinds(incident: Incident): Set<string> {
  return new Set(incident.evidence.map((e) => e.kind));
}

function hasKinds(incident: Incident, ...required: string[]): boolean {
  const k = kinds(incident);
  return required.every((r) => k.has(r));
}

const RULES: Partial<Record<string, RuleFn>> = {
  post_deploy_5xx_spike: (incident) => {
    if (!incident.deployCorrelation) return null;
    if (!hasKinds(incident, "deploy_event", "metric")) return null;
    return {
      confidence: 0.96,
      evidenceSummary: `Post-deploy 5xx spike: deploy ${incident.deployCorrelation.deployId} correlated with metric and deploy_event evidence.`,
      reasoning:
        "Deploy correlation present alongside both deploy_event and metric evidence — strong deterministic signal.",
    };
  },

  ecs_service_unhealthy: (incident) => {
    const k = kinds(incident);
    if (!k.has("metric") && !k.has("alarm")) return null;
    const hasAlarm = k.has("alarm");
    return {
      confidence: hasAlarm ? 0.96 : 0.93,
      evidenceSummary: `ECS service unhealthy confirmed by ${hasAlarm ? "CloudWatch alarm" : "metric"} evidence.`,
      reasoning: hasAlarm
        ? "CloudWatch alarm directly confirms ECS health degradation."
        : "Metric evidence consistent with ECS unhealthy; alarm would further increase confidence.",
    };
  },

  ec2_instance_status_check_failed: (incident) => {
    const k = kinds(incident);
    if (!k.has("alarm") && !k.has("metric")) return null;
    return {
      confidence: 0.97,
      evidenceSummary: "EC2 instance status check failure confirmed by CloudWatch evidence.",
      reasoning:
        "EC2 status check failures are low-ambiguity signals directly reflected in CloudWatch metrics/alarms.",
    };
  },

  lambda_error_spike: (incident) => {
    if (!hasKinds(incident, "metric")) return null;
    const hasLog = kinds(incident).has("log");
    return {
      confidence: hasLog ? 0.96 : 0.91,
      evidenceSummary: `Lambda error spike: metric evidence${hasLog ? " and log confirmation" : ""}.`,
      reasoning: hasLog
        ? "Error spike confirmed by both metric trend and log evidence."
        : "Metric evidence only — log corroboration would improve confidence.",
    };
  },

  lambda_throttling_concurrency_exhausted: (incident) => {
    if (!hasKinds(incident, "metric")) return null;
    return {
      confidence: 0.95,
      evidenceSummary: "Lambda throttling confirmed by concurrency metric evidence.",
      reasoning:
        "Concurrency exhaustion is directly observable via CloudWatch Throttles metric — deterministic signal.",
    };
  },

  deploy_failed_or_stuck: (incident) => {
    if (!incident.deployCorrelation) return null;
    if (!hasKinds(incident, "deploy_event")) return null;
    return {
      confidence: 0.95,
      evidenceSummary: `Deployment failure: deploy ${incident.deployCorrelation.deployId} with deploy_event evidence.`,
      reasoning: "Deploy event evidence directly confirms deployment failure pattern.",
    };
  },

  fargate_service_unhealthy: (incident) => {
    const k = kinds(incident);
    if (!k.has("metric") && !k.has("alarm")) return null;
    return {
      confidence: k.has("alarm") ? 0.95 : 0.92,
      evidenceSummary: `Fargate service unhealthy confirmed by ${k.has("alarm") ? "alarm" : "metric"} evidence.`,
      reasoning:
        "Fargate health degradation pattern matched against CloudWatch evidence.",
    };
  },

  rds_connection_saturation: (incident) => {
    if (!hasKinds(incident, "metric")) return null;
    return {
      confidence: 0.95,
      evidenceSummary: "RDS connection saturation confirmed by metric evidence.",
      reasoning:
        "DatabaseConnections metric directly reflects connection pool exhaustion — low ambiguity.",
    };
  },

  alb_latency_saturation: (incident) => {
    if (!hasKinds(incident, "metric")) return null;
    const hasAlarm = kinds(incident).has("alarm");
    return {
      confidence: hasAlarm ? 0.96 : 0.93,
      evidenceSummary: `ALB latency saturation: ${hasAlarm ? "alarm + metric" : "metric"} evidence.`,
      reasoning:
        "ALB TargetResponseTime metric is a direct saturation signal.",
    };
  },
};

// Applies deterministic rules to the incident. Returns a full hypothesis
// if confidence meets the target floor (DEFAULT_MIN_CONFIDENCE = 0.95);
// returns null otherwise to let L2/L3 LLM tiers take over.
export function applyRules(incident: Incident): ClassifierHypothesis | null {
  const ruleFn = RULES[incident.type];
  if (!ruleFn) return null;

  const result = ruleFn(incident);
  if (!result) return null;
  if (result.confidence < DEFAULT_MIN_CONFIDENCE) return null;

  return {
    incidentType: incident.type,
    confidence: result.confidence,
    evidenceSummary: result.evidenceSummary,
    reasoning: result.reasoning,
    calibrationNote: `L1 rule-based: ${incident.type} matched deterministically`,
  };
}
