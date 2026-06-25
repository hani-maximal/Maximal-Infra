import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  AuditRecord,
  AuditRecordSchema,
  AutonomyMode,
  BlastRadiusResult,
  Contract,
  ContractSchema,
  Incident,
  IncidentSchema,
  MIN_CORROBORATING_EVIDENCE_KINDS,
  ServiceContext,
  Snapshot,
  VerificationResult
} from "./types.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class AuditStore {
  #records: AuditRecord[] = [];

  append(input: Omit<AuditRecord, "id" | "ts" | "prevHash" | "hash"> & { ts?: string }): AuditRecord {
    const previous = this.#records.at(-1);
    const ts = input.ts ?? new Date().toISOString();
    const prevHash = previous?.hash ?? "GENESIS";
    const hash = createHash("sha256")
      .update(`${prevHash}${canonical(input.payload)}${ts}`)
      .digest("hex");
    const record = AuditRecordSchema.parse({
      ...input,
      id: randomUUID(),
      ts,
      prevHash,
      hash
    });
    this.#records.push(record);
    return record;
  }

  replay(incidentId: string): AuditRecord[] {
    return this.#records.filter((record) => record.incidentId === incidentId);
  }

  verifyChain(): boolean {
    let prevHash = "GENESIS";
    for (const record of this.#records) {
      const expected = createHash("sha256")
        .update(`${prevHash}${canonical(record.payload)}${record.ts}`)
        .digest("hex");
      if (record.prevHash !== prevHash || record.hash !== expected) return false;
      prevHash = record.hash;
    }
    return true;
  }
}

export class ContractRegistry {
  readonly contracts = new Map<string, Contract>();

  async load(directory: string): Promise<void> {
    const files = (await fs.readdir(directory)).filter((file) => file.endsWith(".yaml"));
    if (files.length === 0) throw new Error(`No contracts found in ${directory}`);
    for (const file of files) {
      const raw = YAML.parse(await fs.readFile(path.join(directory, file), "utf8"));
      const contract = ContractSchema.parse(raw);
      if (this.contracts.has(contract.incident_type)) {
        throw new Error(`Duplicate contract for ${contract.incident_type}`);
      }
      this.contracts.set(contract.incident_type, contract);
    }
  }

  match(incident: Incident): Contract | null {
    const contract = this.contracts.get(incident.type);
    return contract && contract.source.includes(incident.source) ? contract : null;
  }
}

export class ContextGraph {
  #contexts = new Map<string, ServiceContext>();

  upsert(context: ServiceContext): void {
    this.#contexts.set(`${context.environment}:${context.service}`, context);
  }

  get(incident: Incident): ServiceContext | null {
    return this.#contexts.get(`${incident.environment}:${incident.service}`) ?? null;
  }
}

export interface RemediationAction<P = Record<string, unknown>> {
  readonly type: string;
  readonly isReversible: boolean;
  parseParams(input: unknown): P;
  blastRadius(params: P, context: ServiceContext): BlastRadiusResult;
  preconditions(params: P, context: ServiceContext): Promise<{ ok: boolean; reason?: string }>;
  captureState(params: P, context: ServiceContext): Promise<Snapshot>;
  execute(params: P, context: ServiceContext, snapshot: Snapshot): Promise<import("./types.js").ActionResult>;
  revert(snapshot: Snapshot, context: ServiceContext): Promise<import("./types.js").ActionResult>;
}

export class ActionRegistry {
  #actions = new Map<string, RemediationAction>();

  register(action: RemediationAction): void {
    if (this.#actions.has(action.type)) throw new Error(`Duplicate action ${action.type}`);
    this.#actions.set(action.type, action);
  }

  get(type: string): RemediationAction | null {
    return this.#actions.get(type) ?? null;
  }

  list(): string[] {
    return [...this.#actions.keys()];
  }
}

export interface PolicyDecision {
  decision: "AUTO" | "APPROVE" | "ESCALATE";
  reasons: string[];
  blastRadius: BlastRadiusResult;
}

export function evaluatePolicy(input: {
  incident: Incident;
  contract: Contract;
  context: ServiceContext;
  action: RemediationAction;
  params: unknown;
  mode: AutonomyMode;
}): PolicyDecision {
  const { incident, contract, context, action, mode } = input;
  const params = action.parseParams(input.params);
  const blastRadius = action.blastRadius(params, context);
  const reasons: string[] = [];
  const radius = contract.approval.blast_radius;

  if (incident.confidence < contract.min_confidence) reasons.push("confidence_below_contract_minimum");
  const distinctEvidenceKinds = new Set(incident.evidence.map((e) => e.kind)).size;
  if (distinctEvidenceKinds < MIN_CORROBORATING_EVIDENCE_KINDS) {
    reasons.push("insufficient_corroborating_evidence");
  }
  if (!contract.allowed_actions.includes(action.type)) reasons.push("action_not_contract_allowlisted");
  if (!context.allowedActions.includes(action.type)) reasons.push("action_not_service_allowlisted");
  if (!radius.environments.includes(incident.environment)) reasons.push("environment_not_allowed");
  if (blastRadius.affectedServices.length > radius.max_affected_services) reasons.push("blast_radius_exceeded");

  if (reasons.length > 0) return { decision: "ESCALATE", reasons, blastRadius };
  if (mode === "observe") return { decision: "APPROVE", reasons: ["observe_mode_blocks_execution"], blastRadius };
  if (mode === "approve") return { decision: "APPROVE", reasons: ["global_approval_mode"], blastRadius };
  if (contract.approval.mode === "always_human") {
    return { decision: "APPROVE", reasons: ["contract_requires_human"], blastRadius };
  }
  if (!action.isReversible || (radius.require_reversible && !action.isReversible)) {
    return { decision: "APPROVE", reasons: ["action_not_reversible"], blastRadius };
  }
  if (!radius.allowed_action_types.includes(action.type)) {
    return { decision: "APPROVE", reasons: ["action_not_auto_allowlisted"], blastRadius };
  }
  return { decision: "AUTO", reasons: ["bounded_auto_policy_passed"], blastRadius };
}

export interface Verifier {
  verify(contract: Contract, incident: Incident): Promise<VerificationResult>;
}

export class DeterministicVerifier implements Verifier {
  #failNext = new Set<string>();

  failNext(incidentId: string): void {
    this.#failNext.add(incidentId);
  }

  async verify(contract: Contract, incident: Incident): Promise<VerificationResult> {
    const fail = this.#failNext.delete(incident.id);
    return {
      ok: !fail,
      checks: contract.verify.checks.map((check, index) => ({
        ...check,
        passed: !fail || index > 0,
        observed: fail && index === 0 ? "threshold still breached" : "healthy in verification window"
      }))
    };
  }
}

export class IncidentRepository {
  #incidents = new Map<string, Incident>();

  create(input: Incident): Incident {
    const incident = IncidentSchema.parse(input);
    this.#incidents.set(incident.id, incident);
    return incident;
  }

  get(id: string): Incident | null {
    return this.#incidents.get(id) ?? null;
  }

  list(): Incident[] {
    return [...this.#incidents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  setState(id: string, state: Incident["state"]): Incident {
    const current = this.get(id);
    if (!current) throw new Error("Incident not found");
    const updated = IncidentSchema.parse({ ...current, state });
    this.#incidents.set(id, updated);
    return updated;
  }
}
