import {
  AuditStore,
  ActionRegistry,
  ContextGraph,
  ContractRegistry,
  DeterministicVerifier,
  evaluatePolicy,
  IncidentRepository,
  PolicyDecision,
} from "./core.js";
import {
  AutonomyMode,
  ClassifierHypothesis,
  Contract,
  Incident,
  Snapshot,
  TrustConfig,
} from "./types.js";
import { getDb } from "./db/client.js";
import { getQueue, QUEUE_NAMES } from "./queue/client.js";
import {
  incidents as pgIncidents,
  auditRecords as pgAuditRecords,
  snapshots as pgSnapshots,
} from "./db/schema.js";
import { classifyIncident } from "./learning/classifier.js";
import { classifyNovelIncident, groundParams, NOVEL_CONFIDENCE_FLOOR } from "./learning/novel-classifier.js";
import { getTrustConfig } from "./trust.js";
import { emitIncidentUpdate } from "./events.js";
import type { OutcomeWriterJob, ContractLearnerJob } from "./queue/definitions.js";
import { ContractSchema } from "./types.js";

const DEFAULT_TENANT_ID =
  process.env.DEFAULT_TENANT_ID ?? "00000000-0000-4000-8000-000000000001";

export interface PlannedAction {
  actionType: string;
  params: unknown;
  policy: PolicyDecision;
}

export class Orchestrator {
  readonly plans = new Map<string, PlannedAction>();
  readonly snapshots = new Map<string, Snapshot>();
  readonly #hypotheses = new Map<string, ClassifierHypothesis>();
  // Synthetic contracts built on-the-fly for novel incidents (no YAML contract exists).
  // Keyed by incidentId so execute() can find them without re-running the classifier.
  readonly #novelContracts = new Map<string, Contract>();
  readonly tenantId: string;

  constructor(
    readonly incidents: IncidentRepository,
    readonly contracts: ContractRegistry,
    readonly contexts: ContextGraph,
    readonly actions: ActionRegistry,
    readonly audit: AuditStore,
    readonly verifier: DeterministicVerifier,
    readonly mode: AutonomyMode,
    tenantId?: string
  ) {
    this.tenantId = tenantId ?? DEFAULT_TENANT_ID;
  }

  private async transition(
    incident: Incident,
    state: Incident["state"]
  ): Promise<Incident> {
    const updated = this.incidents.setState(incident.id, state);
    this.audit.append({
      incidentId: incident.id,
      actor: "system",
      actorId: null,
      eventType: "state_change",
      payload: { from: incident.state, to: state },
    });
    emitIncidentUpdate({
      incidentId: incident.id,
      state,
      service: incident.service,
      incidentType: incident.type,
      tenantId: this.tenantId,
      ts: new Date().toISOString(),
    });
    return updated;
  }

  private chooseAction(
    incident: Incident,
    contract: Contract,
    context: import("./types.js").ServiceContext
  ): { actionType: string; params: unknown } | null {
    // Incident-type-specific candidates ordered by preference; first allowed wins.
    const candidates: Array<{ actionType: string; params: unknown }> = (() => {
      switch (incident.type) {
        case "sqs_worker_backlog_saturation":
        case "alb_latency_saturation":
          return [{ actionType: "scale_ecs_service", params: { desiredCount: 4, reason: "backlog_saturation" } }];

        case "alb_target_unhealthy_no_deploy":
          return [
            { actionType: "force_new_ecs_deployment", params: { reason: "unhealthy_tasks" } },
            { actionType: "scale_ecs_service", params: { desiredCount: 4, reason: "unhealthy_tasks" } },
            {
              actionType: "detach_unhealthy_target",
              params: {
                targetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/demo/abc123",
                targetId: context.resources.ec2?.instanceId ?? "i-0demo1234567890ab",
                reason: "unhealthy_target",
              },
            },
          ];

        case "deploy_failed_or_stuck":
          return [
            { actionType: "rollback_ecs_task_definition", params: { previousTaskDefinition: "task-def:41" } },
            { actionType: "force_new_ecs_deployment", params: { reason: "stuck_deployment" } },
            { actionType: "rerun_failed_deployment", params: { deploymentId: incident.deployCorrelation?.deployId ?? "d-demo" } },
          ];

        case "fargate_service_unhealthy":
          return incident.deployCorrelation
            ? [
                { actionType: "rollback_ecs_task_definition", params: { previousTaskDefinition: "task-def:41" } },
                { actionType: "scale_ecs_service", params: { desiredCount: 4, reason: "unhealthy_tasks" } },
              ]
            : [
                { actionType: "scale_ecs_service", params: { desiredCount: 4, reason: "unhealthy_tasks" } },
                { actionType: "force_new_ecs_deployment", params: { reason: "unhealthy_tasks" } },
              ];

        case "lambda_throttling_concurrency_exhausted":
          return [
            { actionType: "restore_lambda_reserved_concurrency", params: { reservedConcurrency: 100 } },
            { actionType: "rollback_lambda_alias", params: { previousVersion: "41" } },
          ];

        case "ec2_asg_unhealthy_hosts":
          return [
            { actionType: "scale_out_asg", params: { asgName: "web-fleet-asg", desiredCapacity: 4 } },
            { actionType: "set_asg_instance_unhealthy", params: { asgName: "web-fleet-asg", instanceId: context.resources.ec2?.instanceId ?? "i-0demo1234567890ab" } },
          ];

        case "ecs_task_placement_capacity_failed":
          return [{ actionType: "scale_out_asg", params: { asgName: "web-fleet-asg", desiredCapacity: 4 } }];

        case "ec2_disk_full":
          return [
            { actionType: "extend_ebs_volume", params: { volumeId: "vol-0demo1234567890ab", region: context.resources.ec2?.region ?? "us-east-1", sizeGiB: 40 } },
            {
              actionType: "detach_unhealthy_target",
              params: {
                targetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/demo/abc123",
                targetId: context.resources.ec2?.instanceId ?? "i-0demo1234567890ab",
                reason: "disk_full",
              },
            },
          ];

        case "eks_node_not_ready":
          return [
            { actionType: "scale_node_group", params: { clusterName: "demo-eks", nodegroupName: "default", desiredSize: 3 } },
          ];

        case "lightsail_container_deployment_failed":
          return [{ actionType: "rollback_lightsail_container_deployment", params: { serviceName: "marketing-site" } }];

        case "lightsail_instance_unhealthy":
          return [
            { actionType: "detach_from_lightsail_lb", params: { loadBalancerName: "blog-lb", instanceName: "blog-instance-1" } },
            { actionType: "reboot_lightsail_instance", params: { instanceName: "blog-instance-1" } },
          ];

        case "rds_connection_saturation":
          return [{ actionType: "scale_ecs_service_down", params: { desiredCount: 1, reason: "connection_saturation" } }];

        case "ec2_post_deploy_regression": {
          const gitSha = incident.deployCorrelation?.gitCommitSha;
          const gitRepo = incident.deployCorrelation?.gitRepo ?? context.resources.git?.repo;
          if (gitSha && gitRepo) {
            return [
              {
                actionType: "open_revert_pr",
                params: {
                  repo: gitRepo,
                  commitSha: gitSha,
                  baseBranch: context.resources.git?.baseBranch ?? "main",
                  incidentSummary:
                    incident.evidence[0]?.summary ??
                    `EC2 service outage on ${incident.service} following deploy ${incident.deployCorrelation?.deployId ?? "unknown"}`,
                },
              },
              {
                actionType: "restart_ec2_instance",
                params: {
                  instanceId: context.resources.ec2?.instanceId ?? "",
                  region: context.resources.ec2?.region ?? "us-east-1",
                },
              },
            ];
          }
          return [
            {
              actionType: "restart_ec2_instance",
              params: {
                instanceId: context.resources.ec2?.instanceId ?? "",
                region: context.resources.ec2?.region ?? "us-east-1",
              },
            },
          ];
        }

        default:
          if (incident.type.startsWith("lambda_")) {
            return [{ actionType: "rollback_lambda_alias", params: { previousVersion: "41" } }];
          }
          if (incident.type.startsWith("ec2_")) {
            // If the incident carries a git commit SHA, prefer the revert PR path over a bare restart
            const gitSha = incident.deployCorrelation?.gitCommitSha;
            const gitRepo = incident.deployCorrelation?.gitRepo ?? context.resources.git?.repo;
            if (gitSha && gitRepo) {
              return [
                {
                  actionType: "open_revert_pr",
                  params: {
                    repo: gitRepo,
                    commitSha: gitSha,
                    baseBranch: context.resources.git?.baseBranch ?? "main",
                    incidentSummary: incident.evidence[0]?.summary ?? `EC2 service outage on ${incident.service}`,
                  },
                },
                {
                  actionType: "restart_ec2_instance",
                  params: {
                    instanceId: context.resources.ec2?.instanceId ?? "",
                    region: context.resources.ec2?.region ?? "us-east-1",
                  },
                },
              ];
            }
            return [
              {
                actionType: "restart_ec2_instance",
                params: {
                  instanceId: context.resources.ec2?.instanceId ?? "",
                  region: context.resources.ec2?.region ?? "us-east-1",
                },
              },
            ];
          }
          return incident.deployCorrelation
            ? [{ actionType: "rollback_ecs_task_definition", params: { previousTaskDefinition: "task-def:41" } }]
            : [{ actionType: "force_new_ecs_deployment", params: { reason: "unhealthy_tasks" } }];
      }
    })();

    return (
      candidates.find(({ actionType }) =>
        contract.allowed_actions.includes(actionType) &&
        this.actions.get(actionType) !== null
      ) ?? null
    );
  }

  // ---------------------------------------------------------------------------
  // plan() — async to accommodate classifyIncident() (Anthropic API).
  //
  // Advisory classification rules:
  //   - We NEVER raise confidence based on LLM output (golden rule §2).
  //   - We NEVER change the incident type based on LLM output — the detector
  //     is the authoritative typer; the classifier is a confidence adjuster.
  //   - If the classifier returns a lower confidence, we use it (conservative).
  //   - If the API is unavailable (no key, timeout, validation failure),
  //     we fall back to the detector's original confidence — plan() still
  //     completes normally.
  //
  // AUTO path still fire-and-forgets execute() to keep HTTP response fast
  // and maintain the existing test timing contract.
  // ---------------------------------------------------------------------------
  async plan(incidentId: string): Promise<PlannedAction> {
    let incident = this.incidents.get(incidentId);
    if (!incident) throw new Error("Incident not found");
    const contract = this.contracts.match(incident);
    const context = this.contexts.get(incident);

    // Trust config — keyed by incident type; governs approval-gate override
    // and novel-incident routing. Fetched before any DB writes so the audit
    // trail can record the effective automation depth.
    const trust = await getTrustConfig(this.tenantId, incident.type);

    // Advisory classification — non-blocking, null-safe fallback
    const hypothesis = await classifyIncident(incident, this.tenantId);
    if (hypothesis) this.#hypotheses.set(incidentId, hypothesis);

    const classifiedConfidence =
      hypothesis && hypothesis.confidence < incident.confidence
        ? hypothesis.confidence
        : incident.confidence;

    // If confidence was lowered, surface a version of the incident that
    // the policy engine will use. The in-memory repo still holds the
    // original detector confidence; we shadow it locally here.
    const effectiveIncident: Incident =
      classifiedConfidence !== incident.confidence
        ? { ...incident, confidence: classifiedConfidence }
        : incident;

    incident = await this.transition(effectiveIncident, "CLASSIFIED");
    this.audit.append({
      incidentId,
      actor: "system",
      actorId: null,
      eventType: "classification",
      payload: {
        type: incident.type,
        detectorConfidence: this.incidents.get(incidentId)?.confidence ?? incident.confidence,
        classifiedConfidence,
        evidenceSummary: hypothesis?.evidenceSummary ?? null,
        calibrationNote: hypothesis?.calibrationNote ?? null,
        evidenceCount: incident.evidence.length,
        ragAugmented: hypothesis !== null,
      },
    });

    // ── Novel incident path ────────────────────────────────────────────────
    // When no contract exists and the tenant is not CONSERVATIVE, call Claude
    // to reason over the evidence and propose a bounded typed action. The
    // proposal always requires human approval — there is no auto path for
    // novel incidents. Context must exist (needed for params + blast radius).
    if (!contract && context && trust.automationDepth !== "CONSERVATIVE") {
      const proposal = await classifyNovelIncident(
        incident,
        context,
        this.actions.list(),
      ).catch(() => null);

      if (proposal && proposal.actionType !== "escalate" && this.actions.get(proposal.actionType)
          && proposal.confidence >= NOVEL_CONFIDENCE_FLOOR) {
        const action = this.actions.get(proposal.actionType)!;

        // Ground resource identifiers from ServiceContext so Claude's guessed
        // strings (instanceId, region, functionName, etc.) are replaced with
        // values we actually know to be correct. Judgment params (counts, sizes,
        // versions) are left as Claude proposed.
        const groundedParams = groundParams(proposal.actionType, proposal.params, context);

        // Eagerly validate params with the action's own zod schema. If Claude's
        // output doesn't parse, fall through to escalation rather than presenting
        // a broken plan to the human.
        let parsedParams: unknown;
        try {
          parsedParams = action.parseParams(groundedParams);
        } catch {
          this.audit.append({
            incidentId,
            actor: "system",
            actorId: null,
            eventType: "escalation",
            payload: {
              reason: "novel_proposal_param_validation_failed",
              actionType: proposal.actionType,
              reasoning: proposal.reasoning,
            },
          });
          // fall through to hard-escalate below
          void parsedParams;
          return this.#hardEscalate(incident, incidentId, trust, "novel_proposal_param_validation_failed");
        }

        // Eagerly run preconditions before asking the human — no point presenting
        // a plan that would immediately fail in execute().
        const precheck = await action.preconditions(parsedParams as never, context).catch(() => ({ ok: false, reason: "precondition_check_threw" }));
        if (!precheck.ok) {
          this.audit.append({
            incidentId,
            actor: "system",
            actorId: null,
            eventType: "escalation",
            payload: {
              reason: "novel_proposal_preconditions_failed",
              actionType: proposal.actionType,
              preconditionReason: precheck.reason,
            },
          });
          return this.#hardEscalate(incident, incidentId, trust, `novel_precondition_failed:${precheck.reason}`);
        }

        // Synthetic contract: conservative defaults, always_human, rollback on failure.
        const syntheticContract = ContractSchema.parse({
          incident_type: incident.type,
          source: [incident.source],
          detect: {},
          min_confidence: 0,
          allowed_actions: [proposal.actionType, "escalate"],
          approval: {
            mode: "always_human",
            blast_radius: {
              max_affected_services: 1,
              environments: [incident.environment],
              allowed_action_types: [], // nothing auto-eligible for novel incidents
              require_reversible: true,
            },
          },
          verify: {
            window: "10m",
            checks: [{ metric: "service_health", condition: "healthy for 5m" }],
          },
          rollback_if_failed: true,
          on_resolve: { draft_postmortem: true, learn_contract: true },
          notify: { slack_channel: "#prod-incidents" },
        });
        this.#novelContracts.set(incidentId, syntheticContract);

        // Novel proposals always require human approval — skip evaluatePolicy().
        const blastRadius = action.blastRadius(parsedParams as never, context);
        const novelPolicy: PolicyDecision = {
          decision: "APPROVE",
          reasons: ["novel_incident_no_contract_human_required"],
          blastRadius,
        };

        const novelPlan: PlannedAction = {
          actionType: proposal.actionType,
          params: groundedParams, // store grounded params, not raw Claude output
          policy: novelPolicy,
        };
        this.plans.set(incidentId, novelPlan);
        this.incidents.persistPlan(incidentId, novelPlan);

        incident = await this.transition(incident, "CONTRACT_MATCHED");
        this.audit.append({
          incidentId,
          actor: "system",
          actorId: null,
          eventType: "contract_match",
          payload: {
            incidentType: incident.type,
            minConfidence: 0,
            novel: true,
          },
        });
        this.audit.append({
          incidentId,
          actor: "system",
          actorId: null,
          eventType: "policy_decision",
          payload: {
            actionType: proposal.actionType,
            ...novelPolicy,
            novel: true,
            classifierReasoning: proposal.reasoning,
            classifierConfidence: proposal.confidence,
          },
        });

        await this.transition(incident, "AWAITING_APPROVAL");
        this.audit.append({
          incidentId,
          actor: "system",
          actorId: null,
          eventType: "approval_request",
          payload: {
            actionType: proposal.actionType,
            novel: true,
            reasoning: proposal.reasoning,
          },
        });

        return novelPlan;
      }
    }

    if (!contract || !context) {
      await this.transition(incident, "ESCALATED");
      this.audit.append({
        incidentId,
        actor: "system",
        actorId: null,
        eventType: "escalation",
        payload: {
          reason: !contract ? "no_matching_contract" : "missing_service_context",
          automationDepth: trust.automationDepth,
          contractProposalQueued: trust.automationDepth !== "CONSERVATIVE",
        },
      });
      void this.#persistAndLearn(incidentId, "ESCALATED");
      throw new Error(!contract ? "No matching contract" : "Missing service context");
    }

    incident = await this.transition(incident, "CONTRACT_MATCHED");
    this.audit.append({
      incidentId,
      actor: "system",
      actorId: null,
      eventType: "contract_match",
      payload: {
        incidentType: contract.incident_type,
        minConfidence: contract.min_confidence,
      },
    });

    const selected = this.chooseAction(incident, contract, context);
    if (!selected) {
      await this.transition(incident, "ESCALATED");
      void this.#persistAndLearn(incidentId, "ESCALATED");
      throw new Error("No implemented action is allowed by this contract");
    }
    const action = this.actions.get(selected.actionType);
    if (!action) throw new Error("Action is not registered");

    const rawPolicy = evaluatePolicy({
      incident,
      contract,
      context,
      action,
      params: selected.params,
      mode: this.mode,
    });
    const policy = this.#applyTrustOverride(rawPolicy, trust);
    const plan = { ...selected, policy };
    this.plans.set(incidentId, plan);
    this.incidents.persistPlan(incidentId, plan);
    this.audit.append({
      incidentId,
      actor: "system",
      actorId: null,
      eventType: "policy_decision",
      payload: {
        actionType: selected.actionType,
        ...policy,
        automationDepth: trust.automationDepth,
        trustOverrideApplied: policy.decision !== rawPolicy.decision,
      },
    });

    if (policy.decision === "ESCALATE") {
      await this.transition(incident, "ESCALATED");
      this.audit.append({
        incidentId,
        actor: "system",
        actorId: null,
        eventType: "escalation",
        payload: { reasons: policy.reasons },
      });
      void this.#persistAndLearn(incidentId, "ESCALATED");
    } else if (policy.decision === "APPROVE") {
      await this.transition(incident, "AWAITING_APPROVAL");
      this.audit.append({
        incidentId,
        actor: "system",
        actorId: null,
        eventType: "approval_request",
        payload: { actionType: selected.actionType, reasons: policy.reasons },
      });
    } else {
      void this.execute(incidentId, "system");
    }
    return plan;
  }

  async approve(incidentId: string, actorId: string): Promise<Incident> {
    const incident = this.incidents.get(incidentId);
    if (!incident || incident.state !== "AWAITING_APPROVAL")
      throw new Error("Incident is not awaiting approval");
    if (this.mode === "observe") throw new Error("Observe mode cannot execute writes");
    this.audit.append({
      incidentId,
      actor: "human",
      actorId,
      eventType: "approval_granted",
      payload: { actionType: this.plans.get(incidentId)?.actionType },
    });
    return this.execute(incidentId, actorId);
  }

  async deny(incidentId: string, actorId: string): Promise<Incident> {
    const incident = this.incidents.get(incidentId);
    if (!incident || incident.state !== "AWAITING_APPROVAL")
      throw new Error("Incident is not awaiting approval");
    this.audit.append({
      incidentId,
      actor: "human",
      actorId,
      eventType: "approval_denied",
      payload: { actionType: this.plans.get(incidentId)?.actionType },
    });
    const escalated = await this.transition(incident, "ESCALATED");
    this.audit.append({
      incidentId,
      actor: "system",
      actorId: null,
      eventType: "escalation",
      payload: { reason: "approval_denied" },
    });
    void this.#persistAndLearn(incidentId, "ESCALATED");
    return escalated;
  }

  async execute(incidentId: string, actorId: string): Promise<Incident> {
    let incident = this.incidents.get(incidentId);
    const plan = this.plans.get(incidentId);
    if (!incident || !plan) throw new Error("Incident or plan not found");
    if (
      incident.state !== "CONTRACT_MATCHED" &&
      incident.state !== "AWAITING_APPROVAL"
    ) {
      throw new Error("Unsafe state transition into execution blocked");
    }
    if (plan.policy.decision === "ESCALATE")
      throw new Error("Escalated plans cannot execute");
    if (
      plan.policy.decision === "APPROVE" &&
      incident.state !== "AWAITING_APPROVAL"
    ) {
      throw new Error("Approval-required plan has no approval state");
    }

    const contract = this.contracts.match(incident) ?? this.#novelContracts.get(incidentId) ?? null;
    const context = this.contexts.get(incident);
    const action = this.actions.get(plan.actionType);
    if (!contract || !context || !action)
      throw new Error("Execution dependencies missing");

    const params = action.parseParams(plan.params);
    const preconditions = await action.preconditions(params, context);
    if (!preconditions.ok)
      throw new Error(preconditions.reason ?? "Action preconditions failed");

    const snapshot = await action.captureState(params, context);
    this.snapshots.set(incidentId, snapshot);
    // Eagerly write snapshot to DB so it survives a process restart
    const db = getDb();
    if (db) {
      db.insert(pgSnapshots).values({
        id: snapshot.id,
        tenantId: this.tenantId,
        incidentId,
        actionType: snapshot.actionType,
        resource: snapshot.resource,
        state: snapshot.state,
        capturedAt: new Date(snapshot.capturedAt),
      }).onConflictDoNothing().catch(() => {});
    }
    this.audit.append({
      incidentId,
      actor: "system",
      actorId: null,
      eventType: "snapshot",
      payload: snapshot,
    });
    if (!this.snapshots.has(incidentId))
      throw new Error("Snapshot persistence failed");

    incident = await this.transition(incident, "EXECUTING");
    const actionResult = await action.execute(params, context, snapshot);
    this.audit.append({
      incidentId,
      actor: actorId === "system" ? "system" : "human",
      actorId: actorId === "system" ? null : actorId,
      eventType: "aws_action",
      payload: actionResult,
    });

    incident = await this.transition(incident, "VERIFYING");
    const verification = await this.verifier.verify(contract, incident);
    this.audit.append({
      incidentId,
      actor: "system",
      actorId: null,
      eventType: "verification",
      payload: verification,
    });

    if (verification.ok) {
      incident = await this.transition(incident, "RESOLVED");
      const storedHypothesis = this.#hypotheses.get(incidentId);
      this.audit.append({
        incidentId,
        actor: "system",
        actorId: null,
        eventType: "postmortem",
        payload: {
          title: `${incident.service}: ${incident.type}`,
          summary:
            storedHypothesis?.evidenceSummary ??
            "Recovery verified after bounded remediation.",
          proposedContractChange: null,
        },
      });
      const closed = await this.transition(incident, "CLOSED");
      void this.#persistAndLearn(incidentId, "CLOSED");
      return closed;
    }

    incident = await this.transition(incident, "ROLLING_BACK");
    if (contract.rollback_if_failed && action.isReversible) {
      const rollback = await action.revert(snapshot, context);
      this.audit.append({
        incidentId,
        actor: "system",
        actorId: null,
        eventType: "rollback",
        payload: rollback,
      });
      incident = await this.transition(incident, "ROLLED_BACK");
    }
    const escalated = await this.transition(incident, "ESCALATED");
    this.audit.append({
      incidentId,
      actor: "system",
      actorId: null,
      eventType: "escalation",
      payload: {
        reason: "verification_failed",
        rollbackAttempted: contract.rollback_if_failed && action.isReversible,
      },
    });
    void this.#persistAndLearn(incidentId, "ESCALATED");
    return escalated;
  }

  // ---------------------------------------------------------------------------
  // #applyTrustOverride — applies per-tenant automation depth to a policy decision.
  //
  // Rules:
  //   ESCALATE decisions are never overridden (safety invariant).
  //   CONSERVATIVE: downgrade AUTO → APPROVE (human always in the loop).
  //   AUTOMATED: upgrade APPROVE → AUTO only when the sole reason is
  //              "contract_requires_human" — mode-based gates (observe_mode,
  //              global_approval_mode) are never bypassed by tenant config.
  //   SUPERVISED: policy is unchanged (follow the contract's own setting).
  // ---------------------------------------------------------------------------
  #applyTrustOverride(policy: PolicyDecision, trust: TrustConfig): PolicyDecision {
    if (policy.decision === "ESCALATE") return policy;

    if (trust.automationDepth === "CONSERVATIVE" && policy.decision === "AUTO") {
      return {
        ...policy,
        decision: "APPROVE",
        reasons: [...policy.reasons, "trust_config_conservative"],
      };
    }

    if (trust.automationDepth === "AUTOMATED" && policy.decision === "APPROVE") {
      const modeLocked = policy.reasons.some(
        (r) => r === "observe_mode_blocks_execution" || r === "global_approval_mode"
      );
      if (modeLocked) return policy;

      const nonContractReasons = policy.reasons.filter((r) => r !== "contract_requires_human");
      if (nonContractReasons.length === 0) {
        return {
          ...policy,
          decision: "AUTO",
          reasons: [...policy.reasons, "trust_config_automated_bypass"],
        };
      }
    }

    return policy;
  }

  // ---------------------------------------------------------------------------
  // #persistAndLearn — fires after every terminal state (CLOSED / ESCALATED).
  //
  // 1. Upserts incident + full audit chain to Postgres (learning workers read
  //    from DB, not in-memory). Uses onConflictDoNothing / onConflictDoUpdate
  //    so retries are safe.
  // 2. Queues outcome-writer (writes IncidentOutcome row).
  // 3. For CLOSED: queues contract-learner (drafts proposed contract update).
  //
  // Shared escalation path for the novel classifier's early-exit cases.
  async #hardEscalate(
    incident: Incident,
    incidentId: string,
    trust: TrustConfig,
    reason: string,
  ): Promise<PlannedAction> {
    await this.transition(incident, "ESCALATED");
    this.audit.append({
      incidentId,
      actor: "system",
      actorId: null,
      eventType: "escalation",
      payload: { reason, automationDepth: trust.automationDepth },
    });
    void this.#persistAndLearn(incidentId, "ESCALATED");
    throw new Error(reason);
  }

  // NEVER blocks the incident lifecycle — errors are logged, not thrown.
  // ---------------------------------------------------------------------------
  async #persistAndLearn(
    incidentId: string,
    finalState: "CLOSED" | "ESCALATED"
  ): Promise<void> {
    const db = getDb();
    if (!db) return;

    const incident = this.incidents.get(incidentId);
    const auditTrail = this.audit.replay(incidentId);
    if (!incident) return;

    try {
      // Incident and audit records are already eagerly written via write-through
      // (IncidentRepository.setState + AuditStore.append). Here we only need to
      // ensure the final state is committed and then kick off the learning jobs.
      // As a safety net, also write audit records that may have been missed (e.g.
      // if DB was unavailable when an earlier append fired).
      for (const record of auditTrail) {
        await db
          .insert(pgAuditRecords)
          .values({
            id: record.id,
            tenantId: this.tenantId,
            incidentId: record.incidentId,
            ts: new Date(record.ts),
            actor: record.actor,
            actorId: record.actorId,
            eventType: record.eventType,
            payload: record.payload,
            prevHash: record.prevHash,
            hash: record.hash,
          })
          .onConflictDoNothing();
      }

      const outcomeQueue = getQueue<OutcomeWriterJob>(QUEUE_NAMES.OUTCOME_WRITER);
      if (outcomeQueue) {
        await outcomeQueue.add(
          "write-outcome",
          { tenantId: this.tenantId, incidentId },
          {
            jobId: `outcome-${incidentId}`,
            attempts: 3,
            backoff: { type: "exponential" as const, delay: 1_000 },
          }
        );
      }

      if (finalState === "CLOSED") {
        const contractQueue = getQueue<ContractLearnerJob>(
          QUEUE_NAMES.CONTRACT_LEARNER
        );
        if (contractQueue) {
          await contractQueue.add(
            "learn-contract",
            { tenantId: this.tenantId, incidentId },
            {
              jobId: `contract-${incidentId}`,
              attempts: 2,
              delay: 10_000,
            }
          );
        }
      }
    } catch (err) {
      console.error(
        "[orchestrator] persistAndLearn error (non-fatal):",
        err instanceof Error ? err.message : err
      );
    }
  }
}
