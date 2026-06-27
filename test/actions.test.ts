/**
 * Unit tests for registered AWS-backed typed actions.
 * Uses MockAwsAdapter so no real AWS credentials are needed.
 *
 * Covered: scale_ecs_service, scale_ecs_service_down,
 *   restore_lambda_reserved_concurrency, scale_out_asg,
 *   rollback_lightsail_container_deployment, detach_from_lightsail_lb,
 *   and additional AWS-SDK-feasible actions referenced by contracts
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MockAwsAdapter, createActionRegistry } from "../src/actions.js";
import type { ServiceContext, Snapshot } from "../src/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEcsContext(cluster = "my-cluster", service = "my-svc"): ServiceContext {
  return {
    service,
    environment: "staging",
    dependencies: [],
    allowedActions: [],
    resources: { ecs: { cluster, service } },
  };
}

function makeLambdaContext(functionName = "my-fn", alias = "live"): ServiceContext {
  return {
    service: functionName,
    environment: "staging",
    dependencies: [],
    allowedActions: [],
    resources: { lambda: { functionName, alias } },
  };
}

function makeEmptyContext(): ServiceContext {
  return {
    service: "svc",
    environment: "staging",
    dependencies: [],
    allowedActions: [],
    resources: {},
  };
}

// ── scale_ecs_service ─────────────────────────────────────────────────────────

describe("scale_ecs_service", () => {
  let adapter: MockAwsAdapter;
  let action: ReturnType<typeof createActionRegistry>["get"] extends (t: string) => infer R ? NonNullable<R> : never;

  beforeEach(() => {
    adapter = new MockAwsAdapter();
    adapter.state.ecsDesiredCount = 2;
    const registry = createActionRegistry(adapter);
    action = registry.get("scale_ecs_service")!;
  });

  it("passes preconditions when ECS resource is present", async () => {
    const params = action.parseParams({ desiredCount: 4, reason: "backlog_saturation" });
    const result = await action.preconditions(params, makeEcsContext());
    expect(result.ok).toBe(true);
  });

  it("fails preconditions when ECS resource is absent", async () => {
    const params = action.parseParams({ desiredCount: 4, reason: "backlog_saturation" });
    const result = await action.preconditions(params, makeEmptyContext());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_ecs_resource");
  });

  it("captureState snapshots current desiredCount", async () => {
    const ctx = makeEcsContext();
    const params = action.parseParams({ desiredCount: 4, reason: "backlog_saturation" });
    const snapshot = await action.captureState(params, ctx);
    expect(snapshot.state.desiredCount).toBe(2);
    expect(snapshot.actionType).toBe("scale_ecs_service");
  });

  it("execute sets new desired count and records API call", async () => {
    const ctx = makeEcsContext();
    const params = action.parseParams({ desiredCount: 5, reason: "latency_saturation" });
    const snapshot = await action.captureState(params, ctx);
    const r = await action.execute(params, ctx, snapshot);
    expect(r.ok).toBe(true);
    expect(adapter.state.ecsDesiredCount).toBe(5);
    expect(adapter.calls.some((c) => c.api === "ecs:UpdateService(desiredCount)")).toBe(true);
  });

  it("revert restores prior desiredCount", async () => {
    const ctx = makeEcsContext();
    const params = action.parseParams({ desiredCount: 5, reason: "backlog_saturation" });
    const snapshot = await action.captureState(params, ctx);
    await action.execute(params, ctx, snapshot);
    expect(adapter.state.ecsDesiredCount).toBe(5);
    await action.revert(snapshot, ctx);
    expect(adapter.state.ecsDesiredCount).toBe(2);
  });
});

// ── scale_ecs_service_down ────────────────────────────────────────────────────

describe("scale_ecs_service_down", () => {
  let adapter: MockAwsAdapter;
  let action: NonNullable<ReturnType<ReturnType<typeof createActionRegistry>["get"]>>;

  beforeEach(() => {
    adapter = new MockAwsAdapter();
    adapter.state.ecsDesiredCount = 4;
    const registry = createActionRegistry(adapter);
    action = registry.get("scale_ecs_service_down")!;
  });

  it("passes preconditions when ECS context and non-zero count", async () => {
    const params = action.parseParams({ desiredCount: 2, reason: "connection_saturation" });
    const result = await action.preconditions(params, makeEcsContext());
    expect(result.ok).toBe(true);
  });

  it("fails preconditions when desiredCount is zero (safety guard)", async () => {
    const params = action.parseParams({ desiredCount: 0, reason: "load_shedding" });
    const result = await action.preconditions(params, makeEcsContext());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cannot_scale_to_zero");
  });

  it("fails preconditions when ECS resource absent", async () => {
    const params = action.parseParams({ desiredCount: 2, reason: "connection_saturation" });
    const result = await action.preconditions(params, makeEmptyContext());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_ecs_resource");
  });

  it("execute reduces desired count", async () => {
    const ctx = makeEcsContext();
    const params = action.parseParams({ desiredCount: 2, reason: "connection_saturation" });
    const snapshot = await action.captureState(params, ctx);
    const r = await action.execute(params, ctx, snapshot);
    expect(r.ok).toBe(true);
    expect(adapter.state.ecsDesiredCount).toBe(2);
  });

  it("revert restores prior desired count", async () => {
    const ctx = makeEcsContext();
    const params = action.parseParams({ desiredCount: 2, reason: "connection_saturation" });
    const snapshot = await action.captureState(params, ctx);
    await action.execute(params, ctx, snapshot);
    await action.revert(snapshot, ctx);
    expect(adapter.state.ecsDesiredCount).toBe(4);
  });
});

// ── restore_lambda_reserved_concurrency ───────────────────────────────────────

describe("restore_lambda_reserved_concurrency", () => {
  let adapter: MockAwsAdapter;
  let action: NonNullable<ReturnType<ReturnType<typeof createActionRegistry>["get"]>>;

  beforeEach(() => {
    adapter = new MockAwsAdapter();
    adapter.state.lambdaReservedConcurrency = null; // starts unreserved
    const registry = createActionRegistry(adapter);
    action = registry.get("restore_lambda_reserved_concurrency")!;
  });

  it("passes preconditions when Lambda resource present", async () => {
    const params = action.parseParams({ reservedConcurrency: 100 });
    const result = await action.preconditions(params, makeLambdaContext());
    expect(result.ok).toBe(true);
  });

  it("fails preconditions when Lambda resource absent", async () => {
    const params = action.parseParams({ reservedConcurrency: 100 });
    const result = await action.preconditions(params, makeEmptyContext());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_lambda_resource");
  });

  it("captureState records null when no reserved concurrency set", async () => {
    const ctx = makeLambdaContext();
    const params = action.parseParams({ reservedConcurrency: 100 });
    const snapshot = await action.captureState(params, ctx);
    expect(snapshot.state.reservedConcurrency).toBeNull();
  });

  it("execute sets reserved concurrency", async () => {
    const ctx = makeLambdaContext();
    const params = action.parseParams({ reservedConcurrency: 200 });
    const snapshot = await action.captureState(params, ctx);
    const r = await action.execute(params, ctx, snapshot);
    expect(r.ok).toBe(true);
    expect(adapter.state.lambdaReservedConcurrency).toBe(200);
    expect(adapter.calls.some((c) => c.api === "lambda:PutFunctionConcurrency")).toBe(true);
  });

  it("revert deletes reserved concurrency when prior value was null", async () => {
    const ctx = makeLambdaContext();
    const params = action.parseParams({ reservedConcurrency: 200 });
    const snapshot = await action.captureState(params, ctx);
    await action.execute(params, ctx, snapshot);
    await action.revert(snapshot, ctx);
    expect(adapter.state.lambdaReservedConcurrency).toBeNull();
    expect(adapter.calls.some((c) => c.api === "lambda:DeleteFunctionConcurrency")).toBe(true);
  });

  it("revert restores prior reserved concurrency when it existed", async () => {
    adapter.state.lambdaReservedConcurrency = 50;
    const ctx = makeLambdaContext();
    const params = action.parseParams({ reservedConcurrency: 200 });
    const snapshot = await action.captureState(params, ctx);
    // prior is captured as 50
    expect(snapshot.state.reservedConcurrency).toBe(50);
    await action.execute(params, ctx, snapshot);
    await action.revert(snapshot, ctx);
    expect(adapter.state.lambdaReservedConcurrency).toBe(50);
  });
});

// ── scale_out_asg ─────────────────────────────────────────────────────────────

describe("scale_out_asg", () => {
  let adapter: MockAwsAdapter;
  let action: NonNullable<ReturnType<ReturnType<typeof createActionRegistry>["get"]>>;
  const params = { asgName: "my-asg", desiredCapacity: 6 };

  beforeEach(() => {
    adapter = new MockAwsAdapter();
    // starts at desiredCapacity=3, minSize=2, maxSize=10
    const registry = createActionRegistry(adapter);
    action = registry.get("scale_out_asg")!;
  });

  it("passes preconditions when new capacity is higher and within max", async () => {
    const p = action.parseParams(params);
    const result = await action.preconditions(p, makeEmptyContext());
    expect(result.ok).toBe(true);
  });

  it("fails preconditions when desired is not greater than current", async () => {
    const p = action.parseParams({ asgName: "my-asg", desiredCapacity: 2 });
    const result = await action.preconditions(p, makeEmptyContext());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("desired_capacity_not_greater_than_current");
  });

  it("fails preconditions when desired exceeds ASG max", async () => {
    const p = action.parseParams({ asgName: "my-asg", desiredCapacity: 20 });
    const result = await action.preconditions(p, makeEmptyContext());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("desired_capacity_exceeds_asg_max");
  });

  it("captureState records current capacity", async () => {
    const p = action.parseParams(params);
    const snapshot = await action.captureState(p, makeEmptyContext());
    expect(snapshot.state.desiredCapacity).toBe(3);
    expect(snapshot.state.asgName).toBe("my-asg");
  });

  it("execute scales out ASG", async () => {
    const p = action.parseParams(params);
    const snapshot = await action.captureState(p, makeEmptyContext());
    const r = await action.execute(p, makeEmptyContext(), snapshot);
    expect(r.ok).toBe(true);
    expect(adapter.state.asgDesiredCapacity).toBe(6);
    expect(adapter.calls.some((c) => c.api === "autoscaling:SetDesiredCapacity")).toBe(true);
  });

  it("revert restores prior capacity", async () => {
    const p = action.parseParams(params);
    const ctx = makeEmptyContext();
    const snapshot = await action.captureState(p, ctx);
    await action.execute(p, ctx, snapshot);
    await action.revert(snapshot, ctx);
    expect(adapter.state.asgDesiredCapacity).toBe(3);
  });
});

// ── rollback_lightsail_container_deployment ───────────────────────────────────

describe("rollback_lightsail_container_deployment", () => {
  let adapter: MockAwsAdapter;
  let action: NonNullable<ReturnType<ReturnType<typeof createActionRegistry>["get"]>>;
  const svcParams = { serviceName: "my-ls-svc" };

  beforeEach(() => {
    adapter = new MockAwsAdapter();
    // MockAwsAdapter starts with version=2 (current=FAILED) and version=1 (lastActive=ACTIVE)
    const registry = createActionRegistry(adapter);
    action = registry.get("rollback_lightsail_container_deployment")!;
  });

  it("passes preconditions when a previous active deployment exists", async () => {
    const p = action.parseParams(svcParams);
    const result = await action.preconditions(p, makeEmptyContext());
    expect(result.ok).toBe(true);
  });

  it("fails preconditions when no previous active deployment exists", async () => {
    // Force only version 1 (no prior)
    adapter.state.lightsailDeploymentVersion = 1;
    const p = action.parseParams(svcParams);
    const result = await action.preconditions(p, makeEmptyContext());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_previous_active_deployment_to_roll_back_to");
  });

  it("captureState records current deployment", async () => {
    const p = action.parseParams(svcParams);
    const snapshot = await action.captureState(p, makeEmptyContext());
    expect(snapshot.state.serviceName).toBe("my-ls-svc");
    expect(snapshot.state.version).toBe(2);
  });

  it("execute deploys the last active version", async () => {
    const ctx = makeEmptyContext();
    const p = action.parseParams(svcParams);
    const snapshot = await action.captureState(p, ctx);
    const r = await action.execute(p, ctx, snapshot);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("v1");
    expect(adapter.calls.some((c) => c.api === "lightsail:CreateContainerServiceDeployment")).toBe(true);
  });

  it("revert re-deploys the pre-rollback state", async () => {
    const ctx = makeEmptyContext();
    const p = action.parseParams(svcParams);
    const snapshot = await action.captureState(p, ctx);
    await action.execute(p, ctx, snapshot);
    const callsBefore = adapter.calls.length;
    const r = await action.revert(snapshot, ctx);
    expect(r.ok).toBe(true);
    expect(adapter.calls.length).toBeGreaterThan(callsBefore);
  });
});

// ── detach_from_lightsail_lb ──────────────────────────────────────────────────

describe("detach_from_lightsail_lb", () => {
  let adapter: MockAwsAdapter;
  let action: NonNullable<ReturnType<ReturnType<typeof createActionRegistry>["get"]>>;
  const detachParams = { loadBalancerName: "my-lb", instanceName: "my-instance" };

  beforeEach(() => {
    adapter = new MockAwsAdapter();
    adapter.state.lightsailInstanceAttached = true;
    const registry = createActionRegistry(adapter);
    action = registry.get("detach_from_lightsail_lb")!;
  });

  it("passes preconditions when LB name and instance name are present", async () => {
    const p = action.parseParams(detachParams);
    const result = await action.preconditions(p, makeEmptyContext());
    expect(result.ok).toBe(true);
  });

  it("captureState records wasAttached=true", async () => {
    const p = action.parseParams(detachParams);
    const snapshot = await action.captureState(p, makeEmptyContext());
    expect(snapshot.state.wasAttached).toBe(true);
    expect(snapshot.state.loadBalancerName).toBe("my-lb");
    expect(snapshot.state.instanceName).toBe("my-instance");
  });

  it("execute detaches instance from load balancer", async () => {
    const ctx = makeEmptyContext();
    const p = action.parseParams(detachParams);
    const snapshot = await action.captureState(p, ctx);
    const r = await action.execute(p, ctx, snapshot);
    expect(r.ok).toBe(true);
    expect(adapter.state.lightsailInstanceAttached).toBe(false);
    expect(adapter.calls.some((c) => c.api === "lightsail:DetachInstancesFromLoadBalancer")).toBe(true);
  });

  it("revert re-attaches instance to load balancer", async () => {
    const ctx = makeEmptyContext();
    const p = action.parseParams(detachParams);
    const snapshot = await action.captureState(p, ctx);
    await action.execute(p, ctx, snapshot);
    expect(adapter.state.lightsailInstanceAttached).toBe(false);
    await action.revert(snapshot, ctx);
    expect(adapter.state.lightsailInstanceAttached).toBe(true);
    expect(adapter.calls.some((c) => c.api === "lightsail:AttachInstancesToLoadBalancer")).toBe(true);
  });

  it("revert is a clean inverse: attach call follows detach call", async () => {
    const ctx = makeEmptyContext();
    const p = action.parseParams(detachParams);
    const snapshot = await action.captureState(p, ctx);
    await action.execute(p, ctx, snapshot);
    await action.revert(snapshot, ctx);
    const apis = adapter.calls.map((c) => c.api);
    const detachIdx = apis.lastIndexOf("lightsail:DetachInstancesFromLoadBalancer");
    const attachIdx = apis.lastIndexOf("lightsail:AttachInstancesToLoadBalancer");
    expect(attachIdx).toBeGreaterThan(detachIdx);
  });

  it("isReversible is true", () => {
    expect(action.isReversible).toBe(true);
  });
});

describe("contract-mentioned AWS SDK actions", () => {
  let adapter: MockAwsAdapter;
  let registry: ReturnType<typeof createActionRegistry>;

  beforeEach(() => {
    adapter = new MockAwsAdapter();
    registry = createActionRegistry(adapter);
  });

  it("registers every AWS-SDK-feasible action mentioned by bundled contracts", () => {
    expect(registry.list()).toEqual(expect.arrayContaining([
      "detach_unhealthy_target",
      "extend_ebs_volume",
      "set_asg_instance_unhealthy",
      "rerun_failed_deployment",
      "scale_node_group",
      "reboot_lightsail_instance",
    ]));
  });

  it("detach_unhealthy_target deregisters and re-registers an ELBv2 target", async () => {
    const action = registry.get("detach_unhealthy_target")!;
    const params = action.parseParams({
      targetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/demo/abc123",
      targetId: "i-123",
      port: 8080,
    });
    const snapshot = await action.captureState(params, makeEmptyContext());
    await action.execute(params, makeEmptyContext(), snapshot);
    expect(adapter.state.elbv2TargetRegistered).toBe(false);
    await action.revert(snapshot, makeEmptyContext());
    expect(adapter.state.elbv2TargetRegistered).toBe(true);
  });

  it("extend_ebs_volume only permits growth and records ModifyVolume", async () => {
    const action = registry.get("extend_ebs_volume")!;
    const params = action.parseParams({ volumeId: "vol-123", region: "us-east-1", sizeGiB: 40 });
    expect((await action.preconditions(params, makeEmptyContext())).ok).toBe(true);
    const tooSmall = action.parseParams({ volumeId: "vol-123", region: "us-east-1", sizeGiB: 10 });
    expect((await action.preconditions(tooSmall, makeEmptyContext())).reason).toBe("new_size_must_exceed_current_size");
    const snapshot = await action.captureState(params, makeEmptyContext());
    await action.execute(params, makeEmptyContext(), snapshot);
    expect(adapter.state.ec2VolumeSizeGiB).toBe(40);
    expect(adapter.calls.some((c) => c.api === "ec2:ModifyVolume")).toBe(true);
    expect(action.isReversible).toBe(false);
  });

  it("set_asg_instance_unhealthy marks an ASG instance unhealthy and remains non-reversible", async () => {
    const action = registry.get("set_asg_instance_unhealthy")!;
    const params = action.parseParams({ asgName: "web-asg", instanceId: "i-123" });
    const snapshot = await action.captureState(params, makeEmptyContext());
    await action.execute(params, makeEmptyContext(), snapshot);
    expect(adapter.state.asgInstanceHealth).toBe("Unhealthy");
    expect(adapter.calls.some((c) => c.api === "autoscaling:SetInstanceHealth")).toBe(true);
    expect(action.isReversible).toBe(false);
  });

  it("rerun_failed_deployment creates a new CodeDeploy deployment from the snapshot", async () => {
    const action = registry.get("rerun_failed_deployment")!;
    const params = action.parseParams({ deploymentId: "d-source" });
    const snapshot = await action.captureState(params, makeEmptyContext());
    const result = await action.execute(params, makeEmptyContext(), snapshot);
    expect(result.message).toContain("CodeDeploy deployment");
    expect(adapter.calls.some((c) => c.api === "codedeploy:CreateDeployment")).toBe(true);
    expect(action.isReversible).toBe(false);
  });

  it("scale_node_group scales and reverts an EKS managed nodegroup", async () => {
    const action = registry.get("scale_node_group")!;
    const params = action.parseParams({ clusterName: "demo", nodegroupName: "default", desiredSize: 4 });
    const snapshot = await action.captureState(params, makeEmptyContext());
    await action.execute(params, makeEmptyContext(), snapshot);
    expect(adapter.state.eksNodegroupDesiredSize).toBe(4);
    await action.revert(snapshot, makeEmptyContext());
    expect(adapter.state.eksNodegroupDesiredSize).toBe(2);
  });

  it("reboot_lightsail_instance calls Lightsail reboot and is not reversible", async () => {
    const action = registry.get("reboot_lightsail_instance")!;
    const params = action.parseParams({ instanceName: "blog-instance-1" });
    const snapshot = await action.captureState(params, makeEmptyContext());
    await action.execute(params, makeEmptyContext(), snapshot);
    expect(adapter.state.lightsailInstanceRebooted).toBe(true);
    expect(adapter.calls.some((c) => c.api === "lightsail:RebootInstance")).toBe(true);
    expect(action.isReversible).toBe(false);
  });
});

// ── Snapshot types reference (compile-time check) ────────────────────────────

// Ensure Snapshot type is used correctly in test helpers
type _SnapshotCheck = Snapshot extends { id: string; state: Record<string, unknown> } ? true : never;
const _: _SnapshotCheck = true;
void _;
