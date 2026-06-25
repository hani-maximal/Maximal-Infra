import { AuditStore, ActionRegistry, ContextGraph, ContractRegistry, DeterministicVerifier, evaluatePolicy, IncidentRepository, PolicyDecision } from "./core.js";
import { AutonomyMode, Contract, Incident, Snapshot } from "./types.js";

interface PlannedAction {
  actionType: string;
  params: unknown;
  policy: PolicyDecision;
}

export class Orchestrator {
  readonly plans = new Map<string, PlannedAction>();
  readonly snapshots = new Map<string, Snapshot>();

  constructor(
    readonly incidents: IncidentRepository,
    readonly contracts: ContractRegistry,
    readonly contexts: ContextGraph,
    readonly actions: ActionRegistry,
    readonly audit: AuditStore,
    readonly verifier: DeterministicVerifier,
    readonly mode: AutonomyMode
  ) {}

  private transition(incident: Incident, state: Incident["state"]): Incident {
    const updated = this.incidents.setState(incident.id, state);
    this.audit.append({
      incidentId: incident.id,
      actor: "system",
      actorId: null,
      eventType: "state_change",
      payload: { from: incident.state, to: state }
    });
    return updated;
  }

  private chooseAction(incident: Incident, contract: Contract): { actionType: string; params: unknown } | null {
    const candidates =
      incident.type === "lambda_error_spike" || incident.type.startsWith("lambda_")
        ? [{ actionType: "rollback_lambda_alias", params: { previousVersion: "41" } }]
        : incident.deployCorrelation
          ? [{ actionType: "rollback_ecs_task_definition", params: { previousTaskDefinition: "task-def:41" } }]
          : [{ actionType: "force_new_ecs_deployment", params: { reason: "unhealthy_tasks" } }];
    return candidates.find(({ actionType }) => contract.allowed_actions.includes(actionType)) ?? null;
  }

  plan(incidentId: string): PlannedAction {
    let incident = this.incidents.get(incidentId);
    if (!incident) throw new Error("Incident not found");
    const contract = this.contracts.match(incident);
    const context = this.contexts.get(incident);

    incident = this.transition(incident, "CLASSIFIED");
    this.audit.append({
      incidentId,
      actor: "system",
      actorId: null,
      eventType: "classification",
      payload: { type: incident.type, confidence: incident.confidence, evidenceCount: incident.evidence.length }
    });

    if (!contract || !context) {
      this.transition(incident, "ESCALATED");
      this.audit.append({
        incidentId,
        actor: "system",
        actorId: null,
        eventType: "escalation",
        payload: { reason: !contract ? "no_matching_contract" : "missing_service_context" }
      });
      throw new Error(!contract ? "No matching contract" : "Missing service context");
    }

    incident = this.transition(incident, "CONTRACT_MATCHED");
    this.audit.append({
      incidentId,
      actor: "system",
      actorId: null,
      eventType: "contract_match",
      payload: { incidentType: contract.incident_type, minConfidence: contract.min_confidence }
    });

    const selected = this.chooseAction(incident, contract);
    if (!selected) {
      this.transition(incident, "ESCALATED");
      throw new Error("No implemented action is allowed by this contract");
    }
    const action = this.actions.get(selected.actionType);
    if (!action) throw new Error("Action is not registered");

    const policy = evaluatePolicy({
      incident,
      contract,
      context,
      action,
      params: selected.params,
      mode: this.mode
    });
    const plan = { ...selected, policy };
    this.plans.set(incidentId, plan);
    this.audit.append({
      incidentId,
      actor: "system",
      actorId: null,
      eventType: "policy_decision",
      payload: { actionType: selected.actionType, ...policy }
    });

    if (policy.decision === "ESCALATE") {
      this.transition(incident, "ESCALATED");
      this.audit.append({
        incidentId,
        actor: "system",
        actorId: null,
        eventType: "escalation",
        payload: { reasons: policy.reasons }
      });
    } else if (policy.decision === "APPROVE") {
      this.transition(incident, "AWAITING_APPROVAL");
      this.audit.append({
        incidentId,
        actor: "system",
        actorId: null,
        eventType: "approval_request",
        payload: { actionType: selected.actionType, reasons: policy.reasons }
      });
    } else {
      void this.execute(incidentId, "system");
    }
    return plan;
  }

  async approve(incidentId: string, actorId: string): Promise<Incident> {
    const incident = this.incidents.get(incidentId);
    if (!incident || incident.state !== "AWAITING_APPROVAL") throw new Error("Incident is not awaiting approval");
    if (this.mode === "observe") throw new Error("Observe mode cannot execute writes");
    this.audit.append({
      incidentId,
      actor: "human",
      actorId,
      eventType: "approval_granted",
      payload: { actionType: this.plans.get(incidentId)?.actionType }
    });
    return this.execute(incidentId, actorId);
  }

  deny(incidentId: string, actorId: string): Incident {
    const incident = this.incidents.get(incidentId);
    if (!incident || incident.state !== "AWAITING_APPROVAL") throw new Error("Incident is not awaiting approval");
    this.audit.append({
      incidentId,
      actor: "human",
      actorId,
      eventType: "approval_denied",
      payload: { actionType: this.plans.get(incidentId)?.actionType }
    });
    const escalated = this.transition(incident, "ESCALATED");
    this.audit.append({
      incidentId,
      actor: "system",
      actorId: null,
      eventType: "escalation",
      payload: { reason: "approval_denied" }
    });
    return escalated;
  }

  async execute(incidentId: string, actorId: string): Promise<Incident> {
    let incident = this.incidents.get(incidentId);
    const plan = this.plans.get(incidentId);
    if (!incident || !plan) throw new Error("Incident or plan not found");
    if (incident.state !== "CONTRACT_MATCHED" && incident.state !== "AWAITING_APPROVAL") {
      throw new Error("Unsafe state transition into execution blocked");
    }
    if (plan.policy.decision === "ESCALATE") throw new Error("Escalated plans cannot execute");
    if (plan.policy.decision === "APPROVE" && incident.state !== "AWAITING_APPROVAL") {
      throw new Error("Approval-required plan has no approval state");
    }
    const contract = this.contracts.match(incident);
    const context = this.contexts.get(incident);
    const action = this.actions.get(plan.actionType);
    if (!contract || !context || !action) throw new Error("Execution dependencies missing");
    const params = action.parseParams(plan.params);
    const preconditions = await action.preconditions(params, context);
    if (!preconditions.ok) throw new Error(preconditions.reason ?? "Action preconditions failed");

    const snapshot = await action.captureState(params, context);
    this.snapshots.set(incidentId, snapshot);
    this.audit.append({
      incidentId,
      actor: "system",
      actorId: null,
      eventType: "snapshot",
      payload: snapshot
    });
    if (!this.snapshots.has(incidentId)) throw new Error("Snapshot persistence failed");

    incident = this.transition(incident, "EXECUTING");
    const actionResult = await action.execute(params, context, snapshot);
    this.audit.append({
      incidentId,
      actor: actorId === "system" ? "system" : "human",
      actorId: actorId === "system" ? null : actorId,
      eventType: "aws_action",
      payload: actionResult
    });
    incident = this.transition(incident, "VERIFYING");
    const verification = await this.verifier.verify(contract, incident);
    this.audit.append({
      incidentId,
      actor: "system",
      actorId: null,
      eventType: "verification",
      payload: verification
    });

    if (verification.ok) {
      incident = this.transition(incident, "RESOLVED");
      this.audit.append({
        incidentId,
        actor: "system",
        actorId: null,
        eventType: "postmortem",
        payload: {
          title: `${incident.service}: ${incident.type}`,
          summary: "Recovery verified after bounded remediation.",
          proposedContractChange: null
        }
      });
      return this.transition(incident, "CLOSED");
    }

    incident = this.transition(incident, "ROLLING_BACK");
    if (contract.rollback_if_failed && action.isReversible) {
      const rollback = await action.revert(snapshot, context);
      this.audit.append({
        incidentId,
        actor: "system",
        actorId: null,
        eventType: "rollback",
        payload: rollback
      });
      incident = this.transition(incident, "ROLLED_BACK");
    }
    const escalated = this.transition(incident, "ESCALATED");
    this.audit.append({
      incidentId,
      actor: "system",
      actorId: null,
      eventType: "escalation",
      payload: { reason: "verification_failed", rollbackAttempted: contract.rollback_if_failed && action.isReversible }
    });
    return escalated;
  }
}
