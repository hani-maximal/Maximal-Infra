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
import type { DrizzleDb } from "./db/client.js";
import {
  incidents as pgIncidents,
  auditRecords as pgAuditRecords,
  snapshots as pgSnapshots,
} from "./db/schema.js";

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
  #db: DrizzleDb | null = null;
  #tenantId: string | null = null;

  setDb(db: DrizzleDb, tenantId: string): void {
    this.#db = db;
    this.#tenantId = tenantId;
  }

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
    if (this.#db && this.#tenantId) {
      this.#persistRecord(record, this.#tenantId).catch((err) => {
        console.error("[audit] Failed to persist record:", err instanceof Error ? err.message : err);
      });
    }
    return record;
  }

  async #persistRecord(record: AuditRecord, tenantId: string): Promise<void> {
    await this.#db!
      .insert(pgAuditRecords)
      .values({
        id: record.id,
        tenantId,
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

  // Load (or reload) contracts from S3. Tenant-specific keys take priority over
  // defaults. Bucket structure:
  //   s3://CONTRACTS_BUCKET/defaults/{incident_type}.yaml
  //   s3://CONTRACTS_BUCKET/{tenantId}/{incident_type}.yaml
  //
  // Falls back to filesystem contracts if S3 is not configured (env
  // CONTRACTS_BUCKET unset or AWS credentials absent).
  async loadFromS3(tenantId: string): Promise<void> {
    const bucket = process.env.CONTRACTS_BUCKET;
    if (!bucket) return;

    const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

    const getYaml = async (key: string): Promise<Contract | null> => {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = await res.Body?.transformToString("utf8");
        if (!body) return null;
        return ContractSchema.parse(YAML.parse(body));
      } catch {
        return null;
      }
    };

    const loadPrefix = async (prefix: string): Promise<Map<string, Contract>> => {
      const map = new Map<string, Contract>();
      let continuationToken: string | undefined;
      do {
        const res = await s3.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }));
        for (const obj of res.Contents ?? []) {
          if (!obj.Key?.endsWith(".yaml")) continue;
          const contract = await getYaml(obj.Key);
          if (contract) map.set(contract.incident_type, contract);
        }
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (continuationToken);
      return map;
    };

    const defaults = await loadPrefix("defaults/");
    const tenantOverrides = await loadPrefix(`${tenantId}/`);

    const merged = new Map<string, Contract>([...defaults, ...tenantOverrides]);
    if (merged.size === 0) {
      console.warn(`[contracts] S3 returned no contracts for tenant ${tenantId} in ${bucket}; keeping existing contracts`);
      return;
    }

    this.contracts.clear();
    for (const [type, contract] of merged) {
      this.contracts.set(type, contract);
    }
    console.info(`[contracts] Loaded ${merged.size} contracts from S3 (${defaults.size} defaults + ${tenantOverrides.size} overrides) for tenant ${tenantId}`);
  }

  // Hot-reload a single tenant's contracts from S3. Called on Redis pub/sub event.
  async reload(tenantId: string): Promise<void> {
    await this.loadFromS3(tenantId);
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
  #db: DrizzleDb | null = null;
  #tenantId: string | null = null;

  setDb(db: DrizzleDb, tenantId: string): void {
    this.#db = db;
    this.#tenantId = tenantId;
  }

  // Populate in-memory cache from DB on startup (active incidents only).
  // Called once by buildApp() when a DB connection is available.
  async loadFromDb(): Promise<void> {
    if (!this.#db || !this.#tenantId) return;
    const { ne, and, eq } = await import("drizzle-orm");
    const rows = await this.#db
      .select()
      .from(pgIncidents)
      .where(
        and(
          eq(pgIncidents.tenantId, this.#tenantId),
          ne(pgIncidents.state, "CLOSED"),
          ne(pgIncidents.state, "ESCALATED"),
          ne(pgIncidents.state, "ROLLED_BACK"),
        )
      )
      .limit(500);
    for (const row of rows) {
      try {
        const incident = IncidentSchema.parse({
          id: row.id,
          type: row.type,
          service: row.service,
          environment: row.environment,
          source: row.source,
          confidence: Number(row.confidence),
          evidence: row.evidence as Incident["evidence"],
          deployCorrelation: row.deployCorrelation as Incident["deployCorrelation"] ?? null,
          state: row.state,
          createdAt: row.createdAt.toISOString(),
        });
        this.#incidents.set(incident.id, incident);
      } catch {
        // Skip rows that don't parse (stale schema, etc.)
      }
    }
  }

  create(input: Incident): Incident {
    const incident = IncidentSchema.parse(input);
    this.#incidents.set(incident.id, incident);
    if (this.#db && this.#tenantId) {
      this.#upsertToDb(incident).catch(() => {});
    }
    return incident;
  }

  async #upsertToDb(incident: Incident, plan?: unknown): Promise<void> {
    await this.#db!
      .insert(pgIncidents)
      .values({
        id: incident.id,
        tenantId: this.#tenantId!,
        type: incident.type,
        service: incident.service,
        environment: incident.environment,
        source: incident.source,
        confidence: String(incident.confidence),
        evidence: incident.evidence,
        deployCorrelation: incident.deployCorrelation,
        state: incident.state,
        plan: plan ?? null,
      })
      .onConflictDoUpdate({
        target: pgIncidents.id,
        set: { state: incident.state, plan: plan ?? null, updatedAt: new Date() },
      });
  }

  persistPlan(id: string, plan: unknown): void {
    const incident = this.get(id);
    if (!incident || !this.#db || !this.#tenantId) return;
    this.#upsertToDb(incident, plan).catch(() => {});
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
    if (this.#db && this.#tenantId) {
      this.#upsertToDb(updated).catch(() => {});
    }
    return updated;
  }
}
