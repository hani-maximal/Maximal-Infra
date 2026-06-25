import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ActionRegistry, RemediationAction } from "./core.js";
import { ActionResult, ServiceContext, Snapshot } from "./types.js";

interface AwsState {
  ecsTaskDefinition: string;
  lambdaVersion: string;
  deploymentGeneration: number;
}

export class MockAwsAdapter {
  readonly calls: Array<{ api: string; input: unknown; at: string }> = [];
  readonly state: AwsState = {
    ecsTaskDefinition: "task-def:42",
    lambdaVersion: "42",
    deploymentGeneration: 7
  };

  async call(api: string, input: unknown): Promise<void> {
    this.calls.push({ api, input, at: new Date().toISOString() });
  }
}

function result(
  adapter: MockAwsAdapter,
  snapshot: Snapshot,
  actionType: string,
  message: string,
  start: number
): ActionResult {
  return {
    ok: true,
    actionType,
    awsCalls: adapter.calls.slice(start),
    snapshotId: snapshot.id,
    message
  };
}

export function createActionRegistry(adapter: MockAwsAdapter): ActionRegistry {
  const registry = new ActionRegistry();

  const ecsParams = z.object({ previousTaskDefinition: z.string().min(1) });
  const ecsRollback: RemediationAction<z.infer<typeof ecsParams>> = {
    type: "rollback_ecs_task_definition",
    isReversible: true,
    parseParams: (input) => ecsParams.parse(input),
    blastRadius: (_params, context) => ({
      affectedServices: [context.service],
      environment: context.environment,
      actionType: "rollback_ecs_task_definition"
    }),
    preconditions: async (_params, context) => ({
      ok: Boolean(context.resources.ecs),
      ...(context.resources.ecs ? {} : { reason: "missing_ecs_resource" })
    }),
    captureState: async (_params, context) => ({
      id: randomUUID(),
      actionType: "rollback_ecs_task_definition",
      resource: `${context.resources.ecs?.cluster}/${context.resources.ecs?.service}`,
      state: { taskDefinition: adapter.state.ecsTaskDefinition },
      capturedAt: new Date().toISOString()
    }),
    execute: async (params, context, snapshot) => {
      const start = adapter.calls.length;
      await adapter.call("ecs:UpdateService", {
        ...context.resources.ecs,
        taskDefinition: params.previousTaskDefinition,
        forceNewDeployment: true
      });
      adapter.state.ecsTaskDefinition = params.previousTaskDefinition;
      return result(adapter, snapshot, "rollback_ecs_task_definition", "ECS service rolled back", start);
    },
    revert: async (snapshot, context) => {
      const start = adapter.calls.length;
      const taskDefinition = z.string().parse(snapshot.state.taskDefinition);
      await adapter.call("ecs:UpdateService", {
        ...context.resources.ecs,
        taskDefinition,
        forceNewDeployment: true
      });
      adapter.state.ecsTaskDefinition = taskDefinition;
      return result(adapter, snapshot, "rollback_ecs_task_definition", "ECS rollback reverted", start);
    }
  };
  registry.register(ecsRollback);

  const lambdaParams = z.object({ previousVersion: z.string().regex(/^\d+$/) });
  const lambdaRollback: RemediationAction<z.infer<typeof lambdaParams>> = {
    type: "rollback_lambda_alias",
    isReversible: true,
    parseParams: (input) => lambdaParams.parse(input),
    blastRadius: (_params, context) => ({
      affectedServices: [context.service],
      environment: context.environment,
      actionType: "rollback_lambda_alias"
    }),
    preconditions: async (_params, context) => ({
      ok: Boolean(context.resources.lambda),
      ...(context.resources.lambda ? {} : { reason: "missing_lambda_resource" })
    }),
    captureState: async (_params, context) => ({
      id: randomUUID(),
      actionType: "rollback_lambda_alias",
      resource: `${context.resources.lambda?.functionName}:${context.resources.lambda?.alias}`,
      state: { functionVersion: adapter.state.lambdaVersion },
      capturedAt: new Date().toISOString()
    }),
    execute: async (params, context, snapshot) => {
      const start = adapter.calls.length;
      await adapter.call("lambda:UpdateAlias", {
        ...context.resources.lambda,
        functionVersion: params.previousVersion
      });
      adapter.state.lambdaVersion = params.previousVersion;
      return result(adapter, snapshot, "rollback_lambda_alias", "Lambda alias rolled back", start);
    },
    revert: async (snapshot, context) => {
      const start = adapter.calls.length;
      const functionVersion = z.string().parse(snapshot.state.functionVersion);
      await adapter.call("lambda:UpdateAlias", {
        ...context.resources.lambda,
        functionVersion
      });
      adapter.state.lambdaVersion = functionVersion;
      return result(adapter, snapshot, "rollback_lambda_alias", "Lambda rollback reverted", start);
    }
  };
  registry.register(lambdaRollback);

  const forceParams = z.object({ reason: z.enum(["unhealthy_tasks", "stuck_deployment"]) });
  const forceDeployment: RemediationAction<z.infer<typeof forceParams>> = {
    type: "force_new_ecs_deployment",
    isReversible: false,
    parseParams: (input) => forceParams.parse(input),
    blastRadius: (_params, context) => ({
      affectedServices: [context.service],
      environment: context.environment,
      actionType: "force_new_ecs_deployment"
    }),
    preconditions: async (_params, context) => ({
      ok: Boolean(context.resources.ecs),
      ...(context.resources.ecs ? {} : { reason: "missing_ecs_resource" })
    }),
    captureState: async (_params, context) => ({
      id: randomUUID(),
      actionType: "force_new_ecs_deployment",
      resource: `${context.resources.ecs?.cluster}/${context.resources.ecs?.service}`,
      state: { deploymentGeneration: adapter.state.deploymentGeneration },
      capturedAt: new Date().toISOString()
    }),
    execute: async (_params, context, snapshot) => {
      const start = adapter.calls.length;
      await adapter.call("ecs:UpdateService", { ...context.resources.ecs, forceNewDeployment: true });
      adapter.state.deploymentGeneration += 1;
      return result(adapter, snapshot, "force_new_ecs_deployment", "New ECS deployment forced", start);
    },
    revert: async (snapshot, _context) => {
      adapter.state.deploymentGeneration = z.number().parse(snapshot.state.deploymentGeneration);
      return {
        ok: true,
        actionType: "force_new_ecs_deployment",
        awsCalls: [],
        snapshotId: snapshot.id,
        message: "Deployment generation marker restored; AWS deployment itself is not reversible"
      };
    }
  };
  registry.register(forceDeployment);

  return registry;
}
