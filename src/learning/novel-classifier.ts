import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Incident, ServiceContext } from "../types.js";

export interface NovelActionProposal {
  actionType: string;
  params: Record<string, unknown>;
  reasoning: string;
  confidence: number;
}

// Human-readable descriptions and param shapes for every registered action.
// Kept here rather than imported from actions.ts to avoid circular deps.
const ACTION_CATALOG: Record<string, { description: string; paramsHint: string }> = {
  rollback_ecs_task_definition: {
    description: "Roll an ECS service back to a previous task definition revision.",
    paramsHint: '{ "previousTaskDefinition": "arn:aws:ecs:...:task-definition/name:N" }',
  },
  rollback_lambda_alias: {
    description: "Point a Lambda alias back to a known-good function version.",
    paramsHint: '{ "previousVersion": "41" }',
  },
  restart_ec2_instance: {
    description: "Start or reboot an EC2 instance that is stopped or crashed.",
    paramsHint: '{ "instanceId": "i-0abc123", "region": "us-east-1" }',
  },
  force_new_ecs_deployment: {
    description: "Force a new ECS deployment to replace stuck or unhealthy tasks.",
    paramsHint: '{ "reason": "unhealthy_tasks" }',
  },
  scale_ecs_service: {
    description: "Increase ECS service desired task count to absorb load or replace unhealthy tasks.",
    paramsHint: '{ "desiredCount": 4, "reason": "backlog_saturation" }',
  },
  scale_ecs_service_down: {
    description: "Reduce ECS service desired count to relieve RDS connection pressure.",
    paramsHint: '{ "desiredCount": 1, "reason": "connection_saturation" }',
  },
  restore_lambda_reserved_concurrency: {
    description: "Set or restore Lambda reserved concurrency after exhaustion.",
    paramsHint: '{ "reservedConcurrency": 100 }',
  },
  scale_out_asg: {
    description: "Increase Auto Scaling Group desired capacity to replace unhealthy hosts or expand capacity.",
    paramsHint: '{ "asgName": "web-fleet-asg", "desiredCapacity": 4 }',
  },
  extend_ebs_volume: {
    description: "Increase an EBS volume size to resolve disk pressure. Does not require instance stop.",
    paramsHint: '{ "volumeId": "vol-0abc123", "region": "us-east-1", "sizeGiB": 40 }',
  },
  detach_unhealthy_target: {
    description: "Remove an unhealthy instance from an ALB target group to stop serving traffic to it.",
    paramsHint: '{ "targetGroupArn": "arn:aws:elasticloadbalancing:...", "targetId": "i-0abc123", "reason": "health_check_failed" }',
  },
  set_asg_instance_unhealthy: {
    description: "Mark an ASG instance as unhealthy so the ASG replaces it automatically.",
    paramsHint: '{ "asgName": "web-fleet-asg", "instanceId": "i-0abc123" }',
  },
  rerun_failed_deployment: {
    description: "Re-trigger a failed or stuck CodeDeploy deployment.",
    paramsHint: '{ "deploymentId": "d-XXXXXXX" }',
  },
  rollback_lightsail_container_deployment: {
    description: "Roll back a Lightsail container service to its last active deployment.",
    paramsHint: '{ "serviceName": "my-container-service" }',
  },
  detach_from_lightsail_lb: {
    description: "Detach an unhealthy Lightsail instance from its load balancer.",
    paramsHint: '{ "loadBalancerName": "blog-lb", "instanceName": "blog-instance-1" }',
  },
  reboot_lightsail_instance: {
    description: "Reboot an unresponsive Lightsail instance.",
    paramsHint: '{ "instanceName": "blog-instance-1" }',
  },
  scale_node_group: {
    description: "Increase an EKS managed node group desired size.",
    paramsHint: '{ "clusterName": "my-cluster", "nodegroupName": "default", "desiredSize": 3 }',
  },
  open_revert_pr: {
    description: "Open a Git revert PR against a bad commit on an EC2/instance-based service. Only valid when gitCommitSha and gitRepo are known.",
    paramsHint: '{ "repo": "owner/repo", "commitSha": "40hexchars", "baseBranch": "main", "incidentSummary": "..." }',
  },
  escalate: {
    description: "No automated action is appropriate — escalate to a human with context.",
    paramsHint: "{}",
  },
};

// Minimum confidence below which we don't present the proposal to a human —
// if Claude itself is this uncertain, escalation is safer than a bad suggestion.
export const NOVEL_CONFIDENCE_FLOOR = 0.6;

// Replace Claude's guessed resource identifiers with ground-truth values from
// ServiceContext wherever the context can supply them authoritatively.
// Claude's judgment params (counts, sizes, versions) are left untouched.
export function groundParams(
  actionType: string,
  rawParams: Record<string, unknown>,
  context: ServiceContext,
): Record<string, unknown> {
  const p = { ...rawParams };

  if (context.resources.ec2) {
    const { instanceId, region } = context.resources.ec2;
    if (actionType === "restart_ec2_instance") {
      p.instanceId = instanceId;
      p.region = region;
    }
    if (actionType === "extend_ebs_volume") {
      p.region = region;
    }
    if (actionType === "set_asg_instance_unhealthy" && !p.instanceId) {
      p.instanceId = instanceId;
    }
    if (actionType === "detach_unhealthy_target" && !p.targetId) {
      p.targetId = instanceId;
    }
  }

  if (context.resources.lambda) {
    const { functionName, alias } = context.resources.lambda;
    if (actionType === "rollback_lambda_alias") {
      p.functionName = functionName;
      p.aliasName = alias;
    }
    if (actionType === "restore_lambda_reserved_concurrency") {
      p.functionName = functionName;
    }
  }

  if (context.resources.git) {
    const { repo, baseBranch } = context.resources.git;
    if (actionType === "open_revert_pr") {
      p.repo = p.repo ?? repo;
      p.baseBranch = p.baseBranch ?? baseBranch;
    }
  }

  return p;
}

const ProposalSchema = z.object({
  actionType: z.string().min(1),
  params: z.record(z.unknown()),
  reasoning: z.string().min(1).max(1_000),
  confidence: z.number().min(0).max(1),
});

export async function classifyNovelIncident(
  incident: Incident,
  context: ServiceContext | null,
  availableActionTypes: string[],
): Promise<NovelActionProposal | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const catalog = [...availableActionTypes, "escalate"]
    .filter((t) => ACTION_CATALOG[t])
    .map((t) => `  ${t}\n    ${ACTION_CATALOG[t]!.description}\n    params: ${ACTION_CATALOG[t]!.paramsHint}`)
    .join("\n\n");

  const evidenceSummary = incident.evidence
    .map((e) => `  [${e.kind}] ${e.summary}${e.value !== undefined ? ` (value: ${e.value})` : ""}`)
    .join("\n");

  const resourcesJson = context
    ? JSON.stringify(context.resources, null, 2)
    : "No context available";

  const systemPrompt = [
    "You are the incident reasoning layer for Maximal, an infrastructure auto-remediation platform.",
    "An incident has arrived that has no pre-configured contract. Your job is to reason over the evidence",
    "and propose the single safest bounded remediation action from the available set.",
    "",
    "Hard rules:",
    "- Only propose actions from the provided list — never invent action types.",
    "- Propose concrete params that can be passed directly to the action — no placeholders.",
    "- Prefer reversible actions. Never propose anything that could cause data loss.",
    "- If the evidence is ambiguous or no action is clearly safe, choose 'escalate'.",
    "- Respond with valid JSON only — no markdown fences, no prose outside the JSON.",
    "",
    "Available actions:",
    catalog,
  ].join("\n");

  const userPrompt = [
    `Incident type: ${incident.type}`,
    `Service: ${incident.service}  Environment: ${incident.environment}`,
    `Source: ${incident.source}  Confidence: ${incident.confidence}`,
    `Deploy correlation: ${incident.deployCorrelation ? JSON.stringify(incident.deployCorrelation) : "none"}`,
    "",
    "Evidence:",
    evidenceSummary,
    "",
    "AWS resources for this service:",
    resourcesJson,
    "",
    'Respond with exactly this JSON shape (no other text):',
    '{ "actionType": "...", "params": {...}, "reasoning": "one concise sentence", "confidence": 0.0 }',
  ].join("\n");

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : null;
    if (!text) return null;

    const parsed = ProposalSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;

    // Reject hallucinated action types
    const allowed = new Set([...availableActionTypes, "escalate"]);
    if (!allowed.has(parsed.data.actionType)) return null;

    return parsed.data;
  } catch {
    return null;
  }
}
