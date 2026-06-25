import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { evaluatePolicy } from "../src/core.js";
import { ContractSchema, type Contract, type Incident, type ServiceContext } from "../src/types.js";
import { createActionRegistry, MockAwsAdapter } from "../src/actions.js";

async function createHarness(mode = "approve", confidence = 0.95) {
  const harness = await buildApp({ contractsDir: path.resolve("contracts"), mode });
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/incidents/demo",
    payload: { type: "post_deploy_5xx_spike", confidence, environment: "staging" }
  });
  return { ...harness, incident: response.json() };
}

describe("unsafe-write gate", () => {
  beforeEach(() => {
    delete process.env.MAXIMAL_MODE;
  });

  it("blocks execution below contract confidence", async () => {
    const { app, adapter, incident } = await createHarness("bounded_auto", 0.4);
    const response = await app.inject({ method: "POST", url: `/api/incidents/${incident.id}/plan` });
    expect(response.statusCode).toBe(200);
    expect(response.json().policy.decision).toBe("ESCALATE");
    expect(adapter.calls).toHaveLength(0);
    await app.close();
  });

  it("keeps observe mode read-only even after a human approval attempt", async () => {
    const { app, adapter, incident } = await createHarness("observe");
    await app.inject({ method: "POST", url: `/api/incidents/${incident.id}/plan` });
    const response = await app.inject({
      method: "POST",
      url: `/api/incidents/${incident.id}/approve`,
      payload: { actorId: "operator" }
    });
    expect(response.statusCode).toBe(409);
    expect(adapter.calls).toHaveLength(0);
    await app.close();
  });

  it("requires persisted snapshot before every AWS call", async () => {
    const { app, adapter, orchestrator, incident } = await createHarness("approve");
    await app.inject({ method: "POST", url: `/api/incidents/${incident.id}/plan` });
    const response = await app.inject({
      method: "POST",
      url: `/api/incidents/${incident.id}/approve`,
      payload: { actorId: "operator" }
    });
    expect(response.statusCode).toBe(200);
    expect(adapter.calls.length).toBeGreaterThan(0);
    expect(orchestrator.snapshots.has(incident.id)).toBe(true);
    const events = orchestrator.audit.replay(incident.id);
    expect(events.findIndex((event) => event.eventType === "snapshot"))
      .toBeLessThan(events.findIndex((event) => event.eventType === "aws_action"));
    await app.close();
  });

  it("automatically reverts and escalates when verification fails", async () => {
    const { app, adapter, orchestrator, incident } = await createHarness("approve");
    await app.inject({ method: "POST", url: `/api/incidents/${incident.id}/plan` });
    await app.inject({ method: "POST", url: `/api/incidents/${incident.id}/simulate-verification-failure` });
    const response = await app.inject({
      method: "POST",
      url: `/api/incidents/${incident.id}/approve`,
      payload: { actorId: "operator" }
    });
    expect(response.json().state).toBe("ESCALATED");
    expect(adapter.calls).toHaveLength(2);
    expect(orchestrator.audit.replay(incident.id).some((event) => event.eventType === "rollback")).toBe(true);
    expect(orchestrator.audit.verifyChain()).toBe(true);
    await app.close();
  });

  it("allows bounded auto only for reversible contract-approved actions", async () => {
    const { app, orchestrator, incident } = await createHarness("bounded_auto");
    const response = await app.inject({ method: "POST", url: `/api/incidents/${incident.id}/plan` });
    expect(response.json().policy.decision).toBe("AUTO");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(orchestrator.incidents.get(incident.id)?.state).toBe("CLOSED");
    await app.close();
  });

  it("preserves a valid replayable hash chain", async () => {
    const { app, orchestrator, incident } = await createHarness("approve");
    await app.inject({ method: "POST", url: `/api/incidents/${incident.id}/plan` });
    expect(orchestrator.audit.verifyChain()).toBe(true);
    expect(orchestrator.audit.replay(incident.id).length).toBeGreaterThan(3);
    await app.close();
  });

  it("provides inspectable evidence that maps proof to the proposed fix", async () => {
    const { app, incident } = await createHarness("approve");
    const evidence = incident.evidence[0];
    expect(evidence.location?.resource).toContain("arn:aws:");
    expect(evidence.location?.source).toContain("CloudWatch");
    expect(evidence.excerpt).toContain("rate=4.80%");
    expect(evidence.interpretation).toContain("threshold");
    expect(evidence.remediation?.actionType).toBe("rollback_ecs_task_definition");
    expect(evidence.remediation?.explanation).toContain("task definition 41");
    await app.close();
  });
});

describe("confidence floor", () => {
  const base = {
    incident_type: "post_deploy_5xx_spike",
    source: ["self_detect"],
    detect: { service: "auth-api" },
    allowed_actions: ["rollback_ecs_task_definition"],
    approval: {
      mode: "auto_under_blast_radius",
      blast_radius: {
        max_affected_services: 1,
        environments: ["staging"],
        allowed_action_types: ["rollback_ecs_task_definition"]
      }
    },
    verify: { window: "10m", checks: [{ metric: "alb_5xx_rate", condition: "<0.5%" }] },
    on_resolve: { draft_postmortem: true, learn_contract: true },
    notify: { slack_channel: "#prod-incidents" }
  };

  it("rejects a contract whose min_confidence is below the hard floor", () => {
    expect(() => ContractSchema.parse({ ...base, min_confidence: 0.85 })).toThrow();
  });

  it("accepts a contract at the floor and defaults missing values to 0.95", () => {
    expect(ContractSchema.parse({ ...base, min_confidence: 0.9 }).min_confidence).toBe(0.9);
    expect(ContractSchema.parse(base).min_confidence).toBe(0.95);
  });
});

describe("corroborating-evidence gate", () => {
  const contract: Contract = ContractSchema.parse({
    incident_type: "post_deploy_5xx_spike",
    source: ["self_detect"],
    detect: { service: "auth-api" },
    min_confidence: 0.95,
    allowed_actions: ["rollback_ecs_task_definition"],
    approval: {
      mode: "auto_under_blast_radius",
      blast_radius: {
        max_affected_services: 1,
        environments: ["staging"],
        allowed_action_types: ["rollback_ecs_task_definition"]
      }
    },
    verify: { window: "10m", checks: [{ metric: "alb_5xx_rate", condition: "<0.5%" }] },
    on_resolve: { draft_postmortem: true, learn_contract: true },
    notify: { slack_channel: "#prod-incidents" }
  });

  const context: ServiceContext = {
    service: "auth-api",
    environment: "staging",
    dependencies: [],
    allowedActions: ["rollback_ecs_task_definition"],
    resources: { ecs: { cluster: "maximal-demo", service: "auth-api" } }
  };

  const action = createActionRegistry(new MockAwsAdapter()).get("rollback_ecs_task_definition")!;
  const params = { previousTaskDefinition: "task-def:41" };

  const incident = (kinds: Incident["evidence"][number]["kind"][]): Incident => ({
    id: "00000000-0000-4000-8000-000000000000",
    type: "post_deploy_5xx_spike",
    service: "auth-api",
    environment: "staging",
    source: "self_detect",
    confidence: 0.97,
    evidence: kinds.map((kind, i) => ({
      kind,
      ref: `ref-${i}`,
      summary: `evidence ${i}`,
      observedAt: new Date().toISOString()
    })),
    deployCorrelation: null,
    state: "DETECTED",
    createdAt: new Date().toISOString()
  });

  it("escalates a high-confidence incident backed by only one evidence kind", () => {
    const decision = evaluatePolicy({
      incident: incident(["metric"]),
      contract,
      context,
      action,
      params,
      mode: "bounded_auto"
    });
    expect(decision.decision).toBe("ESCALATE");
    expect(decision.reasons).toContain("insufficient_corroborating_evidence");
  });

  it("permits auto when two independent evidence kinds corroborate", () => {
    const decision = evaluatePolicy({
      incident: incident(["metric", "deploy_event"]),
      contract,
      context,
      action,
      params,
      mode: "bounded_auto"
    });
    expect(decision.decision).toBe("AUTO");
    expect(decision.reasons).not.toContain("insufficient_corroborating_evidence");
  });
});
