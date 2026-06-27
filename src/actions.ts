import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ECSClient,
  DescribeServicesCommand,
  UpdateServiceCommand
} from "@aws-sdk/client-ecs";
import {
  LambdaClient,
  GetAliasCommand,
  UpdateAliasCommand,
  GetFunctionConcurrencyCommand,
  PutFunctionConcurrencyCommand,
  DeleteFunctionConcurrencyCommand
} from "@aws-sdk/client-lambda";
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  ModifyVolumeCommand,
  StartInstancesCommand,
  RebootInstancesCommand
} from "@aws-sdk/client-ec2";
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  SetDesiredCapacityCommand,
  SetInstanceHealthCommand
} from "@aws-sdk/client-auto-scaling";
import {
  LightsailClient,
  GetContainerServicesCommand,
  GetContainerServiceDeploymentsCommand,
  CreateContainerServiceDeploymentCommand,
  DetachInstancesFromLoadBalancerCommand,
  AttachInstancesToLoadBalancerCommand,
  RebootInstanceCommand
} from "@aws-sdk/client-lightsail";
import {
  ElasticLoadBalancingV2Client,
  DeregisterTargetsCommand,
  RegisterTargetsCommand
} from "@aws-sdk/client-elastic-load-balancing-v2";
import {
  CodeDeployClient,
  CreateDeploymentCommand,
  GetDeploymentCommand,
  type RevisionLocation
} from "@aws-sdk/client-codedeploy";
import {
  EKSClient,
  DescribeNodegroupCommand,
  UpdateNodegroupConfigCommand
} from "@aws-sdk/client-eks";
import Anthropic from "@anthropic-ai/sdk";
import { ActionRegistry, RemediationAction } from "./core.js";
import type { GitHubAdapterInterface } from "./github.js";
import { ActionResult, ServiceContext, Snapshot } from "./types.js";

export interface AwsCall {
  api: string;
  input: unknown;
  at: string;
}

export interface LightsailDeploymentSnapshot {
  containers: Record<string, unknown>;
  publicEndpoint: Record<string, unknown> | null;
  version: number;
  state: string;
}

// ── Shared interface ──────────────────────────────────────────────────────────

export interface AwsAdapterInterface {
  readonly calls: AwsCall[];

  // ECS — task definition ops
  ecsDescribeService(cluster: string, service: string): Promise<{ taskDefinition: string }>;
  ecsUpdateService(cluster: string, service: string, taskDefinition: string | undefined, forceNewDeployment: boolean): Promise<void>;

  // ECS — desired count ops (scale up/down)
  ecsGetDesiredCount(cluster: string, service: string): Promise<{ desiredCount: number }>;
  ecsSetDesiredCount(cluster: string, service: string, desiredCount: number): Promise<void>;

  // Lambda — alias ops
  lambdaGetAlias(functionName: string, aliasName: string): Promise<{ functionVersion: string }>;
  lambdaUpdateAlias(functionName: string, aliasName: string, functionVersion: string): Promise<void>;

  // Lambda — reserved concurrency ops
  lambdaGetReservedConcurrency(functionName: string): Promise<{ reservedConcurrency: number | null }>;
  lambdaSetReservedConcurrency(functionName: string, reservedConcurrency: number): Promise<void>;
  lambdaDeleteReservedConcurrency(functionName: string): Promise<void>;

  // EC2
  ec2DescribeInstance(instanceId: string, region: string): Promise<{ state: string }>;
  ec2StartInstances(instanceId: string, region: string): Promise<void>;
  ec2RebootInstances(instanceId: string, region: string): Promise<void>;
  ec2DescribeVolume(volumeId: string, region: string): Promise<{ sizeGiB: number; volumeType: string; iops: number | null; throughput: number | null }>;
  ec2ModifyVolume(volumeId: string, region: string, sizeGiB: number): Promise<void>;

  // AutoScaling
  asgGetDesiredCapacity(asgName: string): Promise<{ desiredCapacity: number; minSize: number; maxSize: number }>;
  asgSetDesiredCapacity(asgName: string, desiredCapacity: number): Promise<void>;
  asgSetInstanceHealth(asgName: string, instanceId: string, healthStatus: "Healthy" | "Unhealthy", shouldRespectGracePeriod: boolean): Promise<void>;

  // ELBv2
  elbv2DeregisterTarget(targetGroupArn: string, targetId: string, port: number | null): Promise<void>;
  elbv2RegisterTarget(targetGroupArn: string, targetId: string, port: number | null): Promise<void>;

  // CodeDeploy
  codedeployGetDeployment(deploymentId: string): Promise<{ applicationName: string; deploymentGroupName: string | null; revision: unknown | null }>;
  codedeployCreateDeployment(applicationName: string, deploymentGroupName: string | null, revision: unknown | null): Promise<{ deploymentId: string }>;

  // EKS
  eksGetNodegroup(clusterName: string, nodegroupName: string): Promise<{ desiredSize: number; minSize: number; maxSize: number }>;
  eksUpdateNodegroup(clusterName: string, nodegroupName: string, desiredSize: number, minSize?: number, maxSize?: number): Promise<void>;

  // Lightsail — container service
  lightsailGetDeployments(serviceName: string): Promise<{ current: LightsailDeploymentSnapshot | null; lastActive: LightsailDeploymentSnapshot | null }>;
  lightsailCreateDeployment(serviceName: string, containers: Record<string, unknown>, publicEndpoint: Record<string, unknown> | null): Promise<void>;

  // Lightsail — load balancer
  lightsailDetachInstance(loadBalancerName: string, instanceName: string): Promise<void>;
  lightsailAttachInstance(loadBalancerName: string, instanceName: string): Promise<void>;
  lightsailRebootInstance(instanceName: string): Promise<void>;
}

// ── Mock adapter (tests / dry-run) ────────────────────────────────────────────

interface MockAwsState {
  ecsTaskDefinition: string;
  ecsDesiredCount: number;
  lambdaVersion: string;
  lambdaReservedConcurrency: number | null;
  deploymentGeneration: number;
  ec2InstanceState: string;
  ec2VolumeSizeGiB: number;
  ec2VolumeType: string;
  ec2VolumeIops: number | null;
  ec2VolumeThroughput: number | null;
  asgDesiredCapacity: number;
  asgMinSize: number;
  asgMaxSize: number;
  asgInstanceHealth: "Healthy" | "Unhealthy";
  elbv2TargetRegistered: boolean;
  codedeployDeploymentGeneration: number;
  eksNodegroupDesiredSize: number;
  eksNodegroupMinSize: number;
  eksNodegroupMaxSize: number;
  lightsailDeploymentVersion: number;
  lightsailInstanceAttached: boolean;
  lightsailInstanceRebooted: boolean;
}

export class MockAwsAdapter implements AwsAdapterInterface {
  readonly calls: AwsCall[] = [];
  readonly state: MockAwsState = {
    ecsTaskDefinition: "task-def:42",
    ecsDesiredCount: 2,
    lambdaVersion: "42",
    lambdaReservedConcurrency: null,
    deploymentGeneration: 7,
    ec2InstanceState: "running",
    ec2VolumeSizeGiB: 20,
    ec2VolumeType: "gp3",
    ec2VolumeIops: 3000,
    ec2VolumeThroughput: 125,
    asgDesiredCapacity: 3,
    asgMinSize: 2,
    asgMaxSize: 10,
    asgInstanceHealth: "Healthy",
    elbv2TargetRegistered: true,
    codedeployDeploymentGeneration: 41,
    eksNodegroupDesiredSize: 2,
    eksNodegroupMinSize: 1,
    eksNodegroupMaxSize: 6,
    lightsailDeploymentVersion: 2,
    lightsailInstanceAttached: true,
    lightsailInstanceRebooted: false,
  };

  #log(api: string, input: unknown): void {
    this.calls.push({ api, input, at: new Date().toISOString() });
  }

  async ecsDescribeService(_cluster: string, _service: string) {
    return { taskDefinition: this.state.ecsTaskDefinition };
  }

  async ecsUpdateService(cluster: string, service: string, taskDefinition: string | undefined, forceNewDeployment: boolean) {
    this.#log("ecs:UpdateService", { cluster, service, taskDefinition, forceNewDeployment });
    if (taskDefinition) {
      this.state.ecsTaskDefinition = taskDefinition;
    } else if (forceNewDeployment) {
      this.state.deploymentGeneration += 1;
    }
  }

  async ecsGetDesiredCount(_cluster: string, _service: string) {
    return { desiredCount: this.state.ecsDesiredCount };
  }

  async ecsSetDesiredCount(cluster: string, service: string, desiredCount: number) {
    this.#log("ecs:UpdateService(desiredCount)", { cluster, service, desiredCount });
    this.state.ecsDesiredCount = desiredCount;
  }

  async lambdaGetAlias(_functionName: string, _aliasName: string) {
    return { functionVersion: this.state.lambdaVersion };
  }

  async lambdaUpdateAlias(functionName: string, aliasName: string, functionVersion: string) {
    this.#log("lambda:UpdateAlias", { functionName, aliasName, functionVersion });
    this.state.lambdaVersion = functionVersion;
  }

  async lambdaGetReservedConcurrency(_functionName: string) {
    return { reservedConcurrency: this.state.lambdaReservedConcurrency };
  }

  async lambdaSetReservedConcurrency(functionName: string, reservedConcurrency: number) {
    this.#log("lambda:PutFunctionConcurrency", { functionName, reservedConcurrency });
    this.state.lambdaReservedConcurrency = reservedConcurrency;
  }

  async lambdaDeleteReservedConcurrency(functionName: string) {
    this.#log("lambda:DeleteFunctionConcurrency", { functionName });
    this.state.lambdaReservedConcurrency = null;
  }

  async ec2DescribeInstance(_instanceId: string, _region: string) {
    return { state: this.state.ec2InstanceState };
  }

  async ec2StartInstances(instanceId: string, region: string) {
    this.#log("ec2:StartInstances", { instanceId, region });
    this.state.ec2InstanceState = "running";
  }

  async ec2RebootInstances(instanceId: string, region: string) {
    this.#log("ec2:RebootInstances", { instanceId, region });
  }

  async ec2DescribeVolume(_volumeId: string, _region: string) {
    return {
      sizeGiB: this.state.ec2VolumeSizeGiB,
      volumeType: this.state.ec2VolumeType,
      iops: this.state.ec2VolumeIops,
      throughput: this.state.ec2VolumeThroughput,
    };
  }

  async ec2ModifyVolume(volumeId: string, region: string, sizeGiB: number) {
    this.#log("ec2:ModifyVolume", { volumeId, region, sizeGiB });
    this.state.ec2VolumeSizeGiB = sizeGiB;
  }

  async asgGetDesiredCapacity(_asgName: string) {
    return {
      desiredCapacity: this.state.asgDesiredCapacity,
      minSize: this.state.asgMinSize,
      maxSize: this.state.asgMaxSize,
    };
  }

  async asgSetDesiredCapacity(asgName: string, desiredCapacity: number) {
    this.#log("autoscaling:SetDesiredCapacity", { asgName, desiredCapacity });
    this.state.asgDesiredCapacity = desiredCapacity;
  }

  async asgSetInstanceHealth(asgName: string, instanceId: string, healthStatus: "Healthy" | "Unhealthy", shouldRespectGracePeriod: boolean) {
    this.#log("autoscaling:SetInstanceHealth", { asgName, instanceId, healthStatus, shouldRespectGracePeriod });
    this.state.asgInstanceHealth = healthStatus;
  }

  async elbv2DeregisterTarget(targetGroupArn: string, targetId: string, port: number | null) {
    this.#log("elasticloadbalancing:DeregisterTargets", { targetGroupArn, targetId, port });
    this.state.elbv2TargetRegistered = false;
  }

  async elbv2RegisterTarget(targetGroupArn: string, targetId: string, port: number | null) {
    this.#log("elasticloadbalancing:RegisterTargets", { targetGroupArn, targetId, port });
    this.state.elbv2TargetRegistered = true;
  }

  async codedeployGetDeployment(_deploymentId: string) {
    return {
      applicationName: "demo-app",
      deploymentGroupName: "demo-dg",
      revision: {
        revisionType: "S3",
        s3Location: { bucket: "demo-bucket", key: "app.zip", bundleType: "zip" },
      },
    };
  }

  async codedeployCreateDeployment(applicationName: string, deploymentGroupName: string | null, revision: unknown | null) {
    this.state.codedeployDeploymentGeneration += 1;
    const deploymentId = `d-${this.state.codedeployDeploymentGeneration}`;
    this.#log("codedeploy:CreateDeployment", { applicationName, deploymentGroupName, revision, deploymentId });
    return { deploymentId };
  }

  async eksGetNodegroup(_clusterName: string, _nodegroupName: string) {
    return {
      desiredSize: this.state.eksNodegroupDesiredSize,
      minSize: this.state.eksNodegroupMinSize,
      maxSize: this.state.eksNodegroupMaxSize,
    };
  }

  async eksUpdateNodegroup(clusterName: string, nodegroupName: string, desiredSize: number, minSize?: number, maxSize?: number) {
    this.#log("eks:UpdateNodegroupConfig", { clusterName, nodegroupName, desiredSize, minSize, maxSize });
    this.state.eksNodegroupDesiredSize = desiredSize;
    if (minSize !== undefined) this.state.eksNodegroupMinSize = minSize;
    if (maxSize !== undefined) this.state.eksNodegroupMaxSize = maxSize;
  }

  async lightsailGetDeployments(serviceName: string) {
    const v = this.state.lightsailDeploymentVersion;
    return {
      current: {
        containers: { app: { image: `registry/app:v${v}`, ports: { "8080": "HTTP" as const } } },
        publicEndpoint: { containerName: "app", containerPort: 8080 },
        version: v,
        state: "FAILED",
      } as LightsailDeploymentSnapshot,
      lastActive: v > 1
        ? {
            containers: { app: { image: `registry/app:v${v - 1}`, ports: { "8080": "HTTP" as const } } },
            publicEndpoint: { containerName: "app", containerPort: 8080 },
            version: v - 1,
            state: "ACTIVE",
          } as LightsailDeploymentSnapshot
        : null,
    };
    void serviceName;
  }

  async lightsailCreateDeployment(serviceName: string, containers: Record<string, unknown>, publicEndpoint: Record<string, unknown> | null) {
    this.#log("lightsail:CreateContainerServiceDeployment", { serviceName, containers, publicEndpoint });
    this.state.lightsailDeploymentVersion += 1;
  }

  async lightsailDetachInstance(loadBalancerName: string, instanceName: string) {
    this.#log("lightsail:DetachInstancesFromLoadBalancer", { loadBalancerName, instanceName });
    this.state.lightsailInstanceAttached = false;
  }

  async lightsailAttachInstance(loadBalancerName: string, instanceName: string) {
    this.#log("lightsail:AttachInstancesToLoadBalancer", { loadBalancerName, instanceName });
    this.state.lightsailInstanceAttached = true;
  }

  async lightsailRebootInstance(instanceName: string) {
    this.#log("lightsail:RebootInstance", { instanceName });
    this.state.lightsailInstanceRebooted = true;
  }
}

// ── Real AWS adapter ──────────────────────────────────────────────────────────

export class AwsAdapter implements AwsAdapterInterface {
  readonly calls: AwsCall[] = [];
  readonly #ecs: ECSClient;
  readonly #lambda: LambdaClient;
  readonly #asg: AutoScalingClient;
  readonly #lightsail: LightsailClient;
  readonly #elbv2: ElasticLoadBalancingV2Client;
  readonly #codedeploy: CodeDeployClient;
  readonly #eks: EKSClient;
  readonly #ec2ByRegion = new Map<string, EC2Client>();
  readonly #defaultRegion: string;

  constructor(region = "us-east-1") {
    this.#defaultRegion = region;
    this.#ecs = new ECSClient({ region });
    this.#lambda = new LambdaClient({ region });
    this.#asg = new AutoScalingClient({ region });
    this.#lightsail = new LightsailClient({ region });
    this.#elbv2 = new ElasticLoadBalancingV2Client({ region });
    this.#codedeploy = new CodeDeployClient({ region });
    this.#eks = new EKSClient({ region });
  }

  #log(api: string, input: unknown): void {
    this.calls.push({ api, input, at: new Date().toISOString() });
  }

  #ec2Client(region: string): EC2Client {
    if (!this.#ec2ByRegion.has(region)) {
      this.#ec2ByRegion.set(region, new EC2Client({ region }));
    }
    return this.#ec2ByRegion.get(region)!;
  }

  async ecsDescribeService(cluster: string, service: string) {
    const res = await this.#ecs.send(new DescribeServicesCommand({ cluster, services: [service] }));
    const svc = res.services?.[0];
    if (!svc?.taskDefinition) {
      throw new Error(`ECS service not found: ${cluster}/${service}`);
    }
    return { taskDefinition: svc.taskDefinition };
  }

  async ecsUpdateService(cluster: string, service: string, taskDefinition: string | undefined, forceNewDeployment: boolean) {
    this.#log("ecs:UpdateService", { cluster, service, taskDefinition, forceNewDeployment });
    await this.#ecs.send(new UpdateServiceCommand({ cluster, service, taskDefinition, forceNewDeployment }));
  }

  async ecsGetDesiredCount(cluster: string, service: string) {
    const res = await this.#ecs.send(new DescribeServicesCommand({ cluster, services: [service] }));
    const svc = res.services?.[0];
    if (!svc) throw new Error(`ECS service not found: ${cluster}/${service}`);
    return { desiredCount: svc.desiredCount ?? 0 };
  }

  async ecsSetDesiredCount(cluster: string, service: string, desiredCount: number) {
    this.#log("ecs:UpdateService(desiredCount)", { cluster, service, desiredCount });
    await this.#ecs.send(new UpdateServiceCommand({ cluster, service, desiredCount }));
  }

  async lambdaGetAlias(functionName: string, aliasName: string) {
    const res = await this.#lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: aliasName }));
    if (!res.FunctionVersion) {
      throw new Error(`Lambda alias not found: ${functionName}:${aliasName}`);
    }
    return { functionVersion: res.FunctionVersion };
  }

  async lambdaUpdateAlias(functionName: string, aliasName: string, functionVersion: string) {
    this.#log("lambda:UpdateAlias", { functionName, aliasName, functionVersion });
    await this.#lambda.send(new UpdateAliasCommand({ FunctionName: functionName, Name: aliasName, FunctionVersion: functionVersion }));
  }

  async lambdaGetReservedConcurrency(functionName: string) {
    const res = await this.#lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: functionName }));
    return { reservedConcurrency: res.ReservedConcurrentExecutions ?? null };
  }

  async lambdaSetReservedConcurrency(functionName: string, reservedConcurrency: number) {
    this.#log("lambda:PutFunctionConcurrency", { functionName, reservedConcurrency });
    await this.#lambda.send(new PutFunctionConcurrencyCommand({ FunctionName: functionName, ReservedConcurrentExecutions: reservedConcurrency }));
  }

  async lambdaDeleteReservedConcurrency(functionName: string) {
    this.#log("lambda:DeleteFunctionConcurrency", { functionName });
    await this.#lambda.send(new DeleteFunctionConcurrencyCommand({ FunctionName: functionName }));
  }

  async ec2DescribeInstance(instanceId: string, region: string) {
    const res = await this.#ec2Client(region).send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = res.Reservations?.[0]?.Instances?.[0];
    if (!instance) {
      throw new Error(`EC2 instance not found: ${instanceId} in ${region}`);
    }
    return { state: instance.State?.Name ?? "unknown" };
  }

  async ec2StartInstances(instanceId: string, region: string) {
    this.#log("ec2:StartInstances", { instanceId, region });
    await this.#ec2Client(region).send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  }

  async ec2RebootInstances(instanceId: string, region: string) {
    this.#log("ec2:RebootInstances", { instanceId, region });
    await this.#ec2Client(region).send(new RebootInstancesCommand({ InstanceIds: [instanceId] }));
  }

  async ec2DescribeVolume(volumeId: string, region: string) {
    const res = await this.#ec2Client(region).send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    const volume = res.Volumes?.[0];
    if (!volume || volume.Size === undefined || !volume.VolumeType) {
      throw new Error(`EBS volume not found: ${volumeId} in ${region}`);
    }
    return {
      sizeGiB: volume.Size,
      volumeType: volume.VolumeType,
      iops: volume.Iops ?? null,
      throughput: volume.Throughput ?? null,
    };
  }

  async ec2ModifyVolume(volumeId: string, region: string, sizeGiB: number) {
    this.#log("ec2:ModifyVolume", { volumeId, region, sizeGiB });
    await this.#ec2Client(region).send(new ModifyVolumeCommand({ VolumeId: volumeId, Size: sizeGiB }));
  }

  async asgGetDesiredCapacity(asgName: string) {
    const res = await this.#asg.send(new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [asgName] }));
    const group = res.AutoScalingGroups?.[0];
    if (!group) throw new Error(`ASG not found: ${asgName}`);
    return {
      desiredCapacity: group.DesiredCapacity ?? 0,
      minSize: group.MinSize ?? 0,
      maxSize: group.MaxSize ?? 0,
    };
  }

  async asgSetDesiredCapacity(asgName: string, desiredCapacity: number) {
    this.#log("autoscaling:SetDesiredCapacity", { asgName, desiredCapacity });
    await this.#asg.send(new SetDesiredCapacityCommand({
      AutoScalingGroupName: asgName,
      DesiredCapacity: desiredCapacity,
      HonorCooldown: false,
    }));
  }

  async asgSetInstanceHealth(asgName: string, instanceId: string, healthStatus: "Healthy" | "Unhealthy", shouldRespectGracePeriod: boolean) {
    this.#log("autoscaling:SetInstanceHealth", { asgName, instanceId, healthStatus, shouldRespectGracePeriod });
    await this.#asg.send(new SetInstanceHealthCommand({
      InstanceId: instanceId,
      HealthStatus: healthStatus,
      ShouldRespectGracePeriod: shouldRespectGracePeriod,
    }));
  }

  async elbv2DeregisterTarget(targetGroupArn: string, targetId: string, port: number | null) {
    this.#log("elasticloadbalancing:DeregisterTargets", { targetGroupArn, targetId, port });
    await this.#elbv2.send(new DeregisterTargetsCommand({
      TargetGroupArn: targetGroupArn,
      Targets: [{ Id: targetId, ...(port !== null ? { Port: port } : {}) }],
    }));
  }

  async elbv2RegisterTarget(targetGroupArn: string, targetId: string, port: number | null) {
    this.#log("elasticloadbalancing:RegisterTargets", { targetGroupArn, targetId, port });
    await this.#elbv2.send(new RegisterTargetsCommand({
      TargetGroupArn: targetGroupArn,
      Targets: [{ Id: targetId, ...(port !== null ? { Port: port } : {}) }],
    }));
  }

  async codedeployGetDeployment(deploymentId: string) {
    const res = await this.#codedeploy.send(new GetDeploymentCommand({ deploymentId }));
    const info = res.deploymentInfo;
    if (!info?.applicationName) {
      throw new Error(`CodeDeploy deployment not found: ${deploymentId}`);
    }
    return {
      applicationName: info.applicationName,
      deploymentGroupName: info.deploymentGroupName ?? null,
      revision: info.revision ?? null,
    };
  }

  async codedeployCreateDeployment(applicationName: string, deploymentGroupName: string | null, revision: unknown | null) {
    this.#log("codedeploy:CreateDeployment", { applicationName, deploymentGroupName, revision });
    const res = await this.#codedeploy.send(new CreateDeploymentCommand({
      applicationName,
      ...(deploymentGroupName ? { deploymentGroupName } : {}),
      ...(revision ? { revision: revision as RevisionLocation } : {}),
    }));
    if (!res.deploymentId) throw new Error("CodeDeploy CreateDeployment returned no deploymentId");
    return { deploymentId: res.deploymentId };
  }

  async eksGetNodegroup(clusterName: string, nodegroupName: string) {
    const res = await this.#eks.send(new DescribeNodegroupCommand({ clusterName, nodegroupName }));
    const scaling = res.nodegroup?.scalingConfig;
    if (!scaling) throw new Error(`EKS nodegroup not found: ${clusterName}/${nodegroupName}`);
    return {
      desiredSize: scaling.desiredSize ?? 0,
      minSize: scaling.minSize ?? 0,
      maxSize: scaling.maxSize ?? 0,
    };
  }

  async eksUpdateNodegroup(clusterName: string, nodegroupName: string, desiredSize: number, minSize?: number, maxSize?: number) {
    this.#log("eks:UpdateNodegroupConfig", { clusterName, nodegroupName, desiredSize, minSize, maxSize });
    await this.#eks.send(new UpdateNodegroupConfigCommand({
      clusterName,
      nodegroupName,
      scalingConfig: {
        desiredSize,
        ...(minSize !== undefined ? { minSize } : {}),
        ...(maxSize !== undefined ? { maxSize } : {}),
      },
    }));
  }

  async lightsailGetDeployments(serviceName: string) {
    const deploymentsRes = await this.#lightsail.send(
      new GetContainerServiceDeploymentsCommand({ serviceName })
    );
    const deployments = deploymentsRes.deployments ?? [];

    const toSnapshot = (d: (typeof deployments)[number]): LightsailDeploymentSnapshot => ({
      containers: (d.containers ?? {}) as Record<string, unknown>,
      publicEndpoint: d.publicEndpoint ? {
        containerName: d.publicEndpoint.containerName,
        containerPort: d.publicEndpoint.containerPort,
      } : null,
      version: d.version ?? 0,
      state: d.state ?? "UNKNOWN",
    });

    // Current is the highest-version deployment; lastActive is the most recent with state ACTIVE
    const sorted = [...deployments].sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
    const current = sorted[0] ? toSnapshot(sorted[0]) : null;
    const lastActive = sorted.find((d) => d.state === "ACTIVE" && d.version !== sorted[0]?.version);
    return { current, lastActive: lastActive ? toSnapshot(lastActive) : null };
  }

  async lightsailCreateDeployment(serviceName: string, containers: Record<string, unknown>, publicEndpoint: Record<string, unknown> | null) {
    this.#log("lightsail:CreateContainerServiceDeployment", { serviceName, containers, publicEndpoint });
    await this.#lightsail.send(new CreateContainerServiceDeploymentCommand({
      serviceName,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      containers: containers as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicEndpoint: publicEndpoint as any ?? undefined,
    }));
  }

  async lightsailDetachInstance(loadBalancerName: string, instanceName: string) {
    this.#log("lightsail:DetachInstancesFromLoadBalancer", { loadBalancerName, instanceName });
    await this.#lightsail.send(new DetachInstancesFromLoadBalancerCommand({
      loadBalancerName,
      instanceNames: [instanceName],
    }));
  }

  async lightsailAttachInstance(loadBalancerName: string, instanceName: string) {
    this.#log("lightsail:AttachInstancesToLoadBalancer", { loadBalancerName, instanceName });
    await this.#lightsail.send(new AttachInstancesToLoadBalancerCommand({
      loadBalancerName,
      instanceNames: [instanceName],
    }));
  }

  async lightsailRebootInstance(instanceName: string) {
    this.#log("lightsail:RebootInstance", { instanceName });
    await this.#lightsail.send(new RebootInstanceCommand({ instanceName }));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function result(
  adapter: AwsAdapterInterface,
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

// ── Action registry ───────────────────────────────────────────────────────────

export function createActionRegistry(adapter: AwsAdapterInterface, github?: GitHubAdapterInterface): ActionRegistry {
  const registry = new ActionRegistry();

  // ── ECS task definition rollback ──────────────────────────────────────────
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
    captureState: async (_params, context) => {
      const ecs = context.resources.ecs!;
      const { taskDefinition } = await adapter.ecsDescribeService(ecs.cluster, ecs.service);
      return {
        id: randomUUID(),
        actionType: "rollback_ecs_task_definition",
        resource: `${ecs.cluster}/${ecs.service}`,
        state: { taskDefinition },
        capturedAt: new Date().toISOString()
      };
    },
    execute: async (params, context, snapshot) => {
      const start = adapter.calls.length;
      const ecs = context.resources.ecs!;
      await adapter.ecsUpdateService(ecs.cluster, ecs.service, params.previousTaskDefinition, true);
      return result(adapter, snapshot, "rollback_ecs_task_definition", "ECS service rolled back", start);
    },
    revert: async (snapshot, context) => {
      const start = adapter.calls.length;
      const taskDefinition = z.string().parse(snapshot.state.taskDefinition);
      const ecs = context.resources.ecs!;
      await adapter.ecsUpdateService(ecs.cluster, ecs.service, taskDefinition, true);
      return result(adapter, snapshot, "rollback_ecs_task_definition", "ECS rollback reverted", start);
    }
  };
  registry.register(ecsRollback);

  // ── Lambda alias rollback ─────────────────────────────────────────────────
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
    captureState: async (_params, context) => {
      const lam = context.resources.lambda!;
      const { functionVersion } = await adapter.lambdaGetAlias(lam.functionName, lam.alias);
      return {
        id: randomUUID(),
        actionType: "rollback_lambda_alias",
        resource: `${lam.functionName}:${lam.alias}`,
        state: { functionVersion },
        capturedAt: new Date().toISOString()
      };
    },
    execute: async (params, context, snapshot) => {
      const start = adapter.calls.length;
      const lam = context.resources.lambda!;
      await adapter.lambdaUpdateAlias(lam.functionName, lam.alias, params.previousVersion);
      return result(adapter, snapshot, "rollback_lambda_alias", "Lambda alias rolled back", start);
    },
    revert: async (snapshot, context) => {
      const start = adapter.calls.length;
      const functionVersion = z.string().parse(snapshot.state.functionVersion);
      const lam = context.resources.lambda!;
      await adapter.lambdaUpdateAlias(lam.functionName, lam.alias, functionVersion);
      return result(adapter, snapshot, "rollback_lambda_alias", "Lambda rollback reverted", start);
    }
  };
  registry.register(lambdaRollback);

  // ── Force new ECS deployment ──────────────────────────────────────────────
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
    captureState: async (_params, context) => {
      const ecs = context.resources.ecs!;
      const { taskDefinition } = await adapter.ecsDescribeService(ecs.cluster, ecs.service);
      return {
        id: randomUUID(),
        actionType: "force_new_ecs_deployment",
        resource: `${ecs.cluster}/${ecs.service}`,
        state: { taskDefinition },
        capturedAt: new Date().toISOString()
      };
    },
    execute: async (_params, context, snapshot) => {
      const start = adapter.calls.length;
      const ecs = context.resources.ecs!;
      await adapter.ecsUpdateService(ecs.cluster, ecs.service, undefined, true);
      return result(adapter, snapshot, "force_new_ecs_deployment", "New ECS deployment forced", start);
    },
    revert: async (snapshot, _context) => ({
      ok: true,
      actionType: "force_new_ecs_deployment",
      awsCalls: [],
      snapshotId: snapshot.id,
      message: "Deployment generation marker restored; AWS deployment itself is not reversible"
    })
  };
  registry.register(forceDeployment);

  // ── EC2 instance restart ──────────────────────────────────────────────────
  const ec2Params = z.object({
    instanceId: z.string().min(1),
    region: z.string().default("us-east-1")
  });
  const restartEc2Instance: RemediationAction<z.infer<typeof ec2Params>> = {
    type: "restart_ec2_instance",
    isReversible: true,
    parseParams: (input) => ec2Params.parse(input),
    blastRadius: (_params, context) => ({
      affectedServices: [context.service],
      environment: context.environment,
      actionType: "restart_ec2_instance"
    }),
    preconditions: async (params, _context) => {
      if (!params.instanceId) return { ok: false, reason: "missing_instance_id" };
      return { ok: true };
    },
    captureState: async (params, _context) => {
      const { state } = await adapter.ec2DescribeInstance(params.instanceId, params.region);
      return {
        id: randomUUID(),
        actionType: "restart_ec2_instance",
        resource: `arn:aws:ec2:${params.region}:*:instance/${params.instanceId}`,
        state: { instanceId: params.instanceId, priorState: state },
        capturedAt: new Date().toISOString()
      };
    },
    execute: async (params, _context, snapshot) => {
      const start = adapter.calls.length;
      await adapter.ec2RebootInstances(params.instanceId, params.region);
      return result(adapter, snapshot, "restart_ec2_instance", "EC2 instance reboot initiated", start);
    },
    revert: async (snapshot, _context) => {
      const instanceId = z.string().parse(snapshot.state.instanceId);
      const regionMatch = snapshot.resource.match(/arn:aws:ec2:([^:]+):/);
      const region = regionMatch?.[1] ?? "us-east-1";
      const start = adapter.calls.length;
      await adapter.ec2StartInstances(instanceId, region);
      return result(adapter, snapshot, "restart_ec2_instance", "EC2 instance start initiated", start);
    }
  };
  registry.register(restartEc2Instance);

  // ── ECS service scale-up (reversible) ────────────────────────────────────
  // Used by: sqs_worker_backlog_saturation, alb_latency_saturation, fargate_service_unhealthy
  const scaleEcsParams = z.object({
    desiredCount: z.number().int().positive(),
    reason: z.enum(["backlog_saturation", "latency_saturation", "capacity_shortage", "unhealthy_tasks"]),
  });
  const scaleEcsService: RemediationAction<z.infer<typeof scaleEcsParams>> = {
    type: "scale_ecs_service",
    isReversible: true,
    parseParams: (input) => scaleEcsParams.parse(input),
    blastRadius: (_params, context) => ({
      affectedServices: [context.service],
      environment: context.environment,
      actionType: "scale_ecs_service",
    }),
    preconditions: async (_params, context) => ({
      ok: Boolean(context.resources.ecs),
      ...(context.resources.ecs ? {} : { reason: "missing_ecs_resource" }),
    }),
    captureState: async (_params, context) => {
      const ecs = context.resources.ecs!;
      const { desiredCount } = await adapter.ecsGetDesiredCount(ecs.cluster, ecs.service);
      return {
        id: randomUUID(),
        actionType: "scale_ecs_service",
        resource: `${ecs.cluster}/${ecs.service}`,
        state: { desiredCount },
        capturedAt: new Date().toISOString(),
      };
    },
    execute: async (params, context, snapshot) => {
      const start = adapter.calls.length;
      const ecs = context.resources.ecs!;
      await adapter.ecsSetDesiredCount(ecs.cluster, ecs.service, params.desiredCount);
      return result(adapter, snapshot, "scale_ecs_service", `ECS desired count set to ${params.desiredCount}`, start);
    },
    revert: async (snapshot, context) => {
      const start = adapter.calls.length;
      const desiredCount = z.number().int().nonnegative().parse(snapshot.state.desiredCount);
      const ecs = context.resources.ecs!;
      await adapter.ecsSetDesiredCount(ecs.cluster, ecs.service, desiredCount);
      return result(adapter, snapshot, "scale_ecs_service", `ECS desired count restored to ${desiredCount}`, start);
    },
  };
  registry.register(scaleEcsService);

  // ── ECS service scale-down (human-only, load-shedding) ───────────────────
  // Used by: rds_connection_saturation (always_human gate; no auto path)
  const scaleEcsDownParams = z.object({
    desiredCount: z.number().int().nonnegative(),
    reason: z.enum(["connection_saturation", "load_shedding"]),
  });
  const scaleEcsServiceDown: RemediationAction<z.infer<typeof scaleEcsDownParams>> = {
    type: "scale_ecs_service_down",
    isReversible: true,
    parseParams: (input) => scaleEcsDownParams.parse(input),
    blastRadius: (_params, context) => ({
      affectedServices: [context.service],
      environment: context.environment,
      actionType: "scale_ecs_service_down",
    }),
    preconditions: async (params, context) => {
      if (!context.resources.ecs) return { ok: false, reason: "missing_ecs_resource" };
      if (params.desiredCount === 0) return { ok: false, reason: "cannot_scale_to_zero" };
      return { ok: true };
    },
    captureState: async (_params, context) => {
      const ecs = context.resources.ecs!;
      const { desiredCount } = await adapter.ecsGetDesiredCount(ecs.cluster, ecs.service);
      return {
        id: randomUUID(),
        actionType: "scale_ecs_service_down",
        resource: `${ecs.cluster}/${ecs.service}`,
        state: { desiredCount },
        capturedAt: new Date().toISOString(),
      };
    },
    execute: async (params, context, snapshot) => {
      const start = adapter.calls.length;
      const ecs = context.resources.ecs!;
      await adapter.ecsSetDesiredCount(ecs.cluster, ecs.service, params.desiredCount);
      return result(adapter, snapshot, "scale_ecs_service_down", `ECS desired count reduced to ${params.desiredCount}`, start);
    },
    revert: async (snapshot, context) => {
      const start = adapter.calls.length;
      const desiredCount = z.number().int().nonnegative().parse(snapshot.state.desiredCount);
      const ecs = context.resources.ecs!;
      await adapter.ecsSetDesiredCount(ecs.cluster, ecs.service, desiredCount);
      return result(adapter, snapshot, "scale_ecs_service_down", `ECS desired count restored to ${desiredCount}`, start);
    },
  };
  registry.register(scaleEcsServiceDown);

  // ── Lambda reserved concurrency restore ───────────────────────────────────
  // Used by: lambda_throttling_concurrency_exhausted
  const restoreConcurrencyParams = z.object({
    reservedConcurrency: z.number().int().positive(),
  });
  const restoreLambdaReservedConcurrency: RemediationAction<z.infer<typeof restoreConcurrencyParams>> = {
    type: "restore_lambda_reserved_concurrency",
    isReversible: true,
    parseParams: (input) => restoreConcurrencyParams.parse(input),
    blastRadius: (_params, context) => ({
      affectedServices: [context.service],
      environment: context.environment,
      actionType: "restore_lambda_reserved_concurrency",
    }),
    preconditions: async (_params, context) => ({
      ok: Boolean(context.resources.lambda),
      ...(context.resources.lambda ? {} : { reason: "missing_lambda_resource" }),
    }),
    captureState: async (_params, context) => {
      const lam = context.resources.lambda!;
      const { reservedConcurrency } = await adapter.lambdaGetReservedConcurrency(lam.functionName);
      return {
        id: randomUUID(),
        actionType: "restore_lambda_reserved_concurrency",
        resource: `arn:aws:lambda:*:*:function:${lam.functionName}`,
        state: { reservedConcurrency },
        capturedAt: new Date().toISOString(),
      };
    },
    execute: async (params, context, snapshot) => {
      const start = adapter.calls.length;
      const lam = context.resources.lambda!;
      await adapter.lambdaSetReservedConcurrency(lam.functionName, params.reservedConcurrency);
      return result(adapter, snapshot, "restore_lambda_reserved_concurrency", `Lambda reserved concurrency set to ${params.reservedConcurrency}`, start);
    },
    revert: async (snapshot, context) => {
      const start = adapter.calls.length;
      const lam = context.resources.lambda!;
      const prior = snapshot.state.reservedConcurrency;
      if (prior === null || prior === undefined) {
        await adapter.lambdaDeleteReservedConcurrency(lam.functionName);
        return result(adapter, snapshot, "restore_lambda_reserved_concurrency", "Lambda reserved concurrency removed (restored to unreserved)", start);
      }
      const reservedConcurrency = z.number().int().positive().parse(prior);
      await adapter.lambdaSetReservedConcurrency(lam.functionName, reservedConcurrency);
      return result(adapter, snapshot, "restore_lambda_reserved_concurrency", `Lambda reserved concurrency restored to ${reservedConcurrency}`, start);
    },
  };
  registry.register(restoreLambdaReservedConcurrency);

  // ── ASG scale-out ─────────────────────────────────────────────────────────
  // Used by: ec2_asg_unhealthy_hosts, ecs_task_placement_capacity_failed
  const scaleOutAsgParams = z.object({
    asgName: z.string().min(1),
    desiredCapacity: z.number().int().positive(),
  });
  const scaleOutAsg: RemediationAction<z.infer<typeof scaleOutAsgParams>> = {
    type: "scale_out_asg",
    isReversible: true,
    parseParams: (input) => scaleOutAsgParams.parse(input),
    blastRadius: (_params, context) => ({
      affectedServices: [context.service],
      environment: context.environment,
      actionType: "scale_out_asg",
    }),
    preconditions: async (params, _context) => {
      if (!params.asgName) return { ok: false, reason: "missing_asg_name" };
      const { desiredCapacity, maxSize } = await adapter.asgGetDesiredCapacity(params.asgName);
      if (params.desiredCapacity <= desiredCapacity) {
        return { ok: false, reason: "desired_capacity_not_greater_than_current" };
      }
      if (params.desiredCapacity > maxSize) {
        return { ok: false, reason: "desired_capacity_exceeds_asg_max" };
      }
      return { ok: true };
    },
    captureState: async (params, _context) => {
      const { desiredCapacity } = await adapter.asgGetDesiredCapacity(params.asgName);
      return {
        id: randomUUID(),
        actionType: "scale_out_asg",
        resource: `arn:aws:autoscaling:*:*:autoScalingGroup:*:autoScalingGroupName/${params.asgName}`,
        state: { asgName: params.asgName, desiredCapacity },
        capturedAt: new Date().toISOString(),
      };
    },
    execute: async (params, _context, snapshot) => {
      const start = adapter.calls.length;
      await adapter.asgSetDesiredCapacity(params.asgName, params.desiredCapacity);
      return result(adapter, snapshot, "scale_out_asg", `ASG ${params.asgName} scaled to ${params.desiredCapacity}`, start);
    },
    revert: async (snapshot, _context) => {
      const start = adapter.calls.length;
      const asgName = z.string().parse(snapshot.state.asgName);
      const desiredCapacity = z.number().int().nonnegative().parse(snapshot.state.desiredCapacity);
      await adapter.asgSetDesiredCapacity(asgName, desiredCapacity);
      return result(adapter, snapshot, "scale_out_asg", `ASG ${asgName} scaled back to ${desiredCapacity}`, start);
    },
  };
  registry.register(scaleOutAsg);

  // ── Lightsail container service deployment rollback ───────────────────────
  // Used by: lightsail_container_deployment_failed
  const lightsailDeployParams = z.object({
    serviceName: z.string().min(1),
  });
  const rollbackLightsailContainerDeployment: RemediationAction<z.infer<typeof lightsailDeployParams>> = {
    type: "rollback_lightsail_container_deployment",
    isReversible: true,
    parseParams: (input) => lightsailDeployParams.parse(input),
    blastRadius: (_params, context) => ({
      affectedServices: [context.service],
      environment: context.environment,
      actionType: "rollback_lightsail_container_deployment",
    }),
    preconditions: async (params, _context) => {
      const { lastActive } = await adapter.lightsailGetDeployments(params.serviceName);
      if (!lastActive) {
        return { ok: false, reason: "no_previous_active_deployment_to_roll_back_to" };
      }
      return { ok: true };
    },
    captureState: async (params, _context) => {
      const { current } = await adapter.lightsailGetDeployments(params.serviceName);
      return {
        id: randomUUID(),
        actionType: "rollback_lightsail_container_deployment",
        resource: `lightsail:container-service:${params.serviceName}`,
        state: {
          serviceName: params.serviceName,
          containers: current?.containers ?? {},
          publicEndpoint: current?.publicEndpoint ?? null,
          version: current?.version ?? 0,
        },
        capturedAt: new Date().toISOString(),
      };
    },
    execute: async (params, _context, snapshot) => {
      const start = adapter.calls.length;
      const { lastActive } = await adapter.lightsailGetDeployments(params.serviceName);
      if (!lastActive) throw new Error("No previous active deployment found at execution time");
      await adapter.lightsailCreateDeployment(params.serviceName, lastActive.containers, lastActive.publicEndpoint);
      return result(adapter, snapshot, "rollback_lightsail_container_deployment", `Lightsail service ${params.serviceName} rolled back to v${lastActive.version}`, start);
    },
    revert: async (snapshot, _context) => {
      const start = adapter.calls.length;
      const serviceName = z.string().parse(snapshot.state.serviceName);
      const containers = (snapshot.state.containers ?? {}) as Record<string, unknown>;
      const publicEndpoint = (snapshot.state.publicEndpoint ?? null) as Record<string, unknown> | null;
      await adapter.lightsailCreateDeployment(serviceName, containers, publicEndpoint);
      return result(adapter, snapshot, "rollback_lightsail_container_deployment", `Lightsail service ${serviceName} reverted to pre-rollback state`, start);
    },
  };
  registry.register(rollbackLightsailContainerDeployment);

  // ── Lightsail LB instance detach ──────────────────────────────────────────
  // Used by: lightsail_instance_unhealthy (auto path); reboot is human-only
  const detachLbParams = z.object({
    loadBalancerName: z.string().min(1),
    instanceName: z.string().min(1),
  });
  const detachFromLightsailLb: RemediationAction<z.infer<typeof detachLbParams>> = {
    type: "detach_from_lightsail_lb",
    isReversible: true,
    parseParams: (input) => detachLbParams.parse(input),
    blastRadius: (_params, context) => ({
      affectedServices: [context.service],
      environment: context.environment,
      actionType: "detach_from_lightsail_lb",
    }),
    preconditions: async (params, _context) => {
      if (!params.loadBalancerName) return { ok: false, reason: "missing_load_balancer_name" };
      if (!params.instanceName) return { ok: false, reason: "missing_instance_name" };
      return { ok: true };
    },
    captureState: async (params, _context) => ({
      id: randomUUID(),
      actionType: "detach_from_lightsail_lb",
      resource: `lightsail:load-balancer:${params.loadBalancerName}`,
      state: {
        loadBalancerName: params.loadBalancerName,
        instanceName: params.instanceName,
        wasAttached: true,
      },
      capturedAt: new Date().toISOString(),
    }),
    execute: async (params, _context, snapshot) => {
      const start = adapter.calls.length;
      await adapter.lightsailDetachInstance(params.loadBalancerName, params.instanceName);
      return result(adapter, snapshot, "detach_from_lightsail_lb", `Instance ${params.instanceName} detached from LB ${params.loadBalancerName}`, start);
    },
    revert: async (snapshot, _context) => {
      const start = adapter.calls.length;
      const loadBalancerName = z.string().parse(snapshot.state.loadBalancerName);
      const instanceName = z.string().parse(snapshot.state.instanceName);
      await adapter.lightsailAttachInstance(loadBalancerName, instanceName);
      return result(adapter, snapshot, "detach_from_lightsail_lb", `Instance ${instanceName} re-attached to LB ${loadBalancerName}`, start);
    },
  };
  registry.register(detachFromLightsailLb);

  // ELBv2 target deregistration. Used by contracts that need to remove one
  // unhealthy target from rotation while keeping the target group intact.
  const detachTargetParams = z.object({
    targetGroupArn: z.string().min(1),
    targetId: z.string().min(1),
    port: z.number().int().positive().nullable().default(null),
    reason: z.enum(["unhealthy_target", "disk_full", "dependency_isolation"]).default("unhealthy_target"),
  });
  const detachUnhealthyTarget: RemediationAction<z.infer<typeof detachTargetParams>> = {
    type: "detach_unhealthy_target",
    isReversible: true,
    parseParams: (input) => detachTargetParams.parse(input),
    blastRadius: (_params, context) => ({
      affectedServices: [context.service],
      environment: context.environment,
      actionType: "detach_unhealthy_target",
    }),
    preconditions: async (params, _context) => {
      if (!params.targetGroupArn) return { ok: false, reason: "missing_target_group_arn" };
      if (!params.targetId) return { ok: false, reason: "missing_target_id" };
      return { ok: true };
    },
    captureState: async (params, _context) => ({
      id: randomUUID(),
      actionType: "detach_unhealthy_target",
      resource: `${params.targetGroupArn}/${params.targetId}`,
      state: {
        targetGroupArn: params.targetGroupArn,
        targetId: params.targetId,
        port: params.port,
        wasRegistered: true,
      },
      capturedAt: new Date().toISOString(),
    }),
    execute: async (params, _context, snapshot) => {
      const start = adapter.calls.length;
      await adapter.elbv2DeregisterTarget(params.targetGroupArn, params.targetId, params.port);
      return result(adapter, snapshot, "detach_unhealthy_target", `Target ${params.targetId} deregistered from target group`, start);
    },
    revert: async (snapshot, _context) => {
      const start = adapter.calls.length;
      const targetGroupArn = z.string().parse(snapshot.state.targetGroupArn);
      const targetId = z.string().parse(snapshot.state.targetId);
      const port = snapshot.state.port === null || snapshot.state.port === undefined
        ? null
        : z.number().int().positive().parse(snapshot.state.port);
      await adapter.elbv2RegisterTarget(targetGroupArn, targetId, port);
      return result(adapter, snapshot, "detach_unhealthy_target", `Target ${targetId} re-registered with target group`, start);
    },
  };
  registry.register(detachUnhealthyTarget);

  const extendEbsParams = z.object({
    volumeId: z.string().min(1),
    region: z.string().default("us-east-1"),
    sizeGiB: z.number().int().positive(),
  });
  const extendEbsVolume: RemediationAction<z.infer<typeof extendEbsParams>> = {
    type: "extend_ebs_volume",
    isReversible: false,
    parseParams: (input) => extendEbsParams.parse(input),
    blastRadius: (_params, context) => ({
      affectedServices: [context.service],
      environment: context.environment,
      actionType: "extend_ebs_volume",
    }),
    preconditions: async (params, _context) => {
      const current = await adapter.ec2DescribeVolume(params.volumeId, params.region);
      if (params.sizeGiB <= current.sizeGiB) {
        return { ok: false, reason: "new_size_must_exceed_current_size" };
      }
      return { ok: true };
    },
    captureState: async (params, _context) => {
      const current = await adapter.ec2DescribeVolume(params.volumeId, params.region);
      return {
        id: randomUUID(),
        actionType: "extend_ebs_volume",
        resource: `arn:aws:ec2:${params.region}:*:volume/${params.volumeId}`,
        state: { volumeId: params.volumeId, region: params.region, ...current },
        capturedAt: new Date().toISOString(),
      };
    },
    execute: async (params, _context, snapshot) => {
      const start = adapter.calls.length;
      await adapter.ec2ModifyVolume(params.volumeId, params.region, params.sizeGiB);
      return result(adapter, snapshot, "extend_ebs_volume", `EBS volume ${params.volumeId} resize requested to ${params.sizeGiB} GiB`, start);
    },
    revert: async (snapshot, _context) => ({
      ok: true,
      actionType: "extend_ebs_volume",
      awsCalls: [],
      snapshotId: snapshot.id,
      message: "EBS volumes cannot be shrunk via AWS after extension; revert is manual restore/migration",
    }),
  };
  registry.register(extendEbsVolume);

  const asgUnhealthyParams = z.object({
    asgName: z.string().min(1),
    instanceId: z.string().min(1),
    shouldRespectGracePeriod: z.boolean().default(false),
  });
  const setAsgInstanceUnhealthy: RemediationAction<z.infer<typeof asgUnhealthyParams>> = {
    type: "set_asg_instance_unhealthy",
    isReversible: false,
    parseParams: (input) => asgUnhealthyParams.parse(input),
    blastRadius: (_params, context) => ({
      affectedServices: [context.service],
      environment: context.environment,
      actionType: "set_asg_instance_unhealthy",
    }),
    preconditions: async (params, _context) => {
      if (!params.asgName) return { ok: false, reason: "missing_asg_name" };
      if (!params.instanceId) return { ok: false, reason: "missing_instance_id" };
      return { ok: true };
    },
    captureState: async (params, _context) => ({
      id: randomUUID(),
      actionType: "set_asg_instance_unhealthy",
      resource: `arn:aws:autoscaling:*:*:autoScalingGroup:*:autoScalingGroupName/${params.asgName}/instance/${params.instanceId}`,
      state: { asgName: params.asgName, instanceId: params.instanceId, priorHealthStatus: "Healthy" },
      capturedAt: new Date().toISOString(),
    }),
    execute: async (params, _context, snapshot) => {
      const start = adapter.calls.length;
      await adapter.asgSetInstanceHealth(params.asgName, params.instanceId, "Unhealthy", params.shouldRespectGracePeriod);
      return result(adapter, snapshot, "set_asg_instance_unhealthy", `Instance ${params.instanceId} marked unhealthy in ${params.asgName}`, start);
    },
    revert: async (snapshot, _context) => ({
      ok: true,
      actionType: "set_asg_instance_unhealthy",
      awsCalls: [],
      snapshotId: snapshot.id,
      message: "ASG replacement may already be in progress; revert requires human review",
    }),
  };
  registry.register(setAsgInstanceUnhealthy);

  const rerunDeploymentParams = z.object({
    deploymentId: z.string().min(1),
  });
  const rerunFailedDeployment: RemediationAction<z.infer<typeof rerunDeploymentParams>> = {
    type: "rerun_failed_deployment",
    isReversible: false,
    parseParams: (input) => rerunDeploymentParams.parse(input),
    blastRadius: (_params, context) => ({
      affectedServices: [context.service],
      environment: context.environment,
      actionType: "rerun_failed_deployment",
    }),
    preconditions: async (params, _context) => {
      await adapter.codedeployGetDeployment(params.deploymentId);
      return { ok: true };
    },
    captureState: async (params, _context) => {
      const deployment = await adapter.codedeployGetDeployment(params.deploymentId);
      return {
        id: randomUUID(),
        actionType: "rerun_failed_deployment",
        resource: `codedeploy:deployment:${params.deploymentId}`,
        state: { sourceDeploymentId: params.deploymentId, ...deployment },
        capturedAt: new Date().toISOString(),
      };
    },
    execute: async (_params, _context, snapshot) => {
      const start = adapter.calls.length;
      const applicationName = z.string().parse(snapshot.state.applicationName);
      const deploymentGroupName = snapshot.state.deploymentGroupName === null || snapshot.state.deploymentGroupName === undefined
        ? null
        : z.string().parse(snapshot.state.deploymentGroupName);
      const revision = snapshot.state.revision ?? null;
      const deployment = await adapter.codedeployCreateDeployment(applicationName, deploymentGroupName, revision);
      return result(adapter, snapshot, "rerun_failed_deployment", `CodeDeploy deployment ${deployment.deploymentId} created`, start);
    },
    revert: async (snapshot, _context) => ({
      ok: true,
      actionType: "rerun_failed_deployment",
      awsCalls: [],
      snapshotId: snapshot.id,
      message: "CodeDeploy rerun cannot be undone generically; stop/rollback must be handled by deployment strategy",
    }),
  };
  registry.register(rerunFailedDeployment);

  const scaleNodeGroupParams = z.object({
    clusterName: z.string().min(1),
    nodegroupName: z.string().min(1),
    desiredSize: z.number().int().positive(),
    minSize: z.number().int().nonnegative().optional(),
    maxSize: z.number().int().positive().optional(),
  });
  const scaleNodeGroup: RemediationAction<z.infer<typeof scaleNodeGroupParams>> = {
    type: "scale_node_group",
    isReversible: true,
    parseParams: (input) => scaleNodeGroupParams.parse(input),
    blastRadius: (_params, context) => ({
      affectedServices: [context.service],
      environment: context.environment,
      actionType: "scale_node_group",
    }),
    preconditions: async (params, _context) => {
      const current = await adapter.eksGetNodegroup(params.clusterName, params.nodegroupName);
      if (params.desiredSize <= current.desiredSize) {
        return { ok: false, reason: "desired_size_not_greater_than_current" };
      }
      const effectiveMax = params.maxSize ?? current.maxSize;
      if (params.desiredSize > effectiveMax) {
        return { ok: false, reason: "desired_size_exceeds_nodegroup_max" };
      }
      return { ok: true };
    },
    captureState: async (params, _context) => {
      const current = await adapter.eksGetNodegroup(params.clusterName, params.nodegroupName);
      return {
        id: randomUUID(),
        actionType: "scale_node_group",
        resource: `arn:aws:eks:*:*:nodegroup/${params.clusterName}/${params.nodegroupName}`,
        state: { clusterName: params.clusterName, nodegroupName: params.nodegroupName, ...current },
        capturedAt: new Date().toISOString(),
      };
    },
    execute: async (params, _context, snapshot) => {
      const start = adapter.calls.length;
      await adapter.eksUpdateNodegroup(params.clusterName, params.nodegroupName, params.desiredSize, params.minSize, params.maxSize);
      return result(adapter, snapshot, "scale_node_group", `EKS nodegroup ${params.nodegroupName} desired size set to ${params.desiredSize}`, start);
    },
    revert: async (snapshot, _context) => {
      const start = adapter.calls.length;
      const clusterName = z.string().parse(snapshot.state.clusterName);
      const nodegroupName = z.string().parse(snapshot.state.nodegroupName);
      const desiredSize = z.number().int().nonnegative().parse(snapshot.state.desiredSize);
      const minSize = z.number().int().nonnegative().parse(snapshot.state.minSize);
      const maxSize = z.number().int().positive().parse(snapshot.state.maxSize);
      await adapter.eksUpdateNodegroup(clusterName, nodegroupName, desiredSize, minSize, maxSize);
      return result(adapter, snapshot, "scale_node_group", `EKS nodegroup ${nodegroupName} scaling restored`, start);
    },
  };
  registry.register(scaleNodeGroup);

  const rebootLightsailParams = z.object({
    instanceName: z.string().min(1),
  });
  const rebootLightsailInstance: RemediationAction<z.infer<typeof rebootLightsailParams>> = {
    type: "reboot_lightsail_instance",
    isReversible: false,
    parseParams: (input) => rebootLightsailParams.parse(input),
    blastRadius: (_params, context) => ({
      affectedServices: [context.service],
      environment: context.environment,
      actionType: "reboot_lightsail_instance",
    }),
    preconditions: async (params, _context) => ({
      ok: Boolean(params.instanceName),
      ...(params.instanceName ? {} : { reason: "missing_instance_name" }),
    }),
    captureState: async (params, _context) => ({
      id: randomUUID(),
      actionType: "reboot_lightsail_instance",
      resource: `lightsail:instance:${params.instanceName}`,
      state: { instanceName: params.instanceName },
      capturedAt: new Date().toISOString(),
    }),
    execute: async (params, _context, snapshot) => {
      const start = adapter.calls.length;
      await adapter.lightsailRebootInstance(params.instanceName);
      return result(adapter, snapshot, "reboot_lightsail_instance", `Lightsail instance ${params.instanceName} reboot requested`, start);
    },
    revert: async (snapshot, _context) => ({
      ok: true,
      actionType: "reboot_lightsail_instance",
      awsCalls: [],
      snapshotId: snapshot.id,
      message: "Lightsail reboot is not reversible; monitor verification and escalate if unhealthy",
    }),
  };
  registry.register(rebootLightsailInstance);

  // ── Open fix-as-code PR (GitHub) ──────────────────────────────────────────
  // Fallback action for 10+ contracts. After primary auto-remediation, this
  // drafts a targeted config change PR so a human can merge the durable fix.
  // Used by: post_deploy_5xx_spike, lambda_error_spike, rds_connection_saturation,
  // elasticache_memory_pressure_evictions, ecs_image_pull_failed,
  // ecs_task_placement_capacity_failed, fargate_task_oom_kill,
  // sqs_worker_backlog_saturation, ec2_disk_full, lambda_timeout_duration_spike
  if (github) {
    const fixPrParams = z.object({
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/repo"),
      baseBranch: z.string().min(1).default("main"),
      targetFile: z.string().min(1),
      incidentSummary: z.string().min(1).max(2_000),
    });
    const openFixAsCodePr: RemediationAction<z.infer<typeof fixPrParams>> = {
      type: "open_fix_as_code_pr",
      isReversible: true,
      parseParams: (input) => fixPrParams.parse(input),
      blastRadius: (_params, context) => ({
        affectedServices: [context.service],
        environment: context.environment,
        actionType: "open_fix_as_code_pr",
      }),
      preconditions: async (params, _context) => {
        if (!params.repo) return { ok: false, reason: "missing_repo" };
        if (!params.targetFile) return { ok: false, reason: "missing_target_file" };
        return { ok: true };
      },
      captureState: async (params, _context) => {
        const file = await github.getFileContent(params.repo, params.targetFile, params.baseBranch);
        return {
          id: randomUUID(),
          actionType: "open_fix_as_code_pr",
          resource: `github:${params.repo}/${params.targetFile}@${params.baseBranch}`,
          state: { repo: params.repo, targetFile: params.targetFile, content: file.content, sha: file.sha },
          capturedAt: new Date().toISOString(),
        };
      },
      execute: async (params, context, snapshot) => {
        const start = 0;

        // Draft the config change with Claude
        let patchContent = snapshot.state.content as string;
        let prBody = `Auto-drafted by Maximal after ${context.service} incident.\n\nIncident summary: ${params.incidentSummary}`;

        const anthropicKey = process.env.ANTHROPIC_API_KEY;
        if (anthropicKey) {
          try {
            const client = new Anthropic({ apiKey: anthropicKey });
            const response = await client.messages.create({
              model: "claude-opus-4-8",
              max_tokens: 2_048,
              messages: [{
                role: "user",
                content: [
                  "You are Maximal's config-change drafter. Given an infrastructure incident summary and the current file content, propose a minimal config change that addresses the root cause.",
                  "Rules: only change what's needed, preserve file format and comments, output ONLY the updated file content followed by ---PR_BODY--- and then a concise PR description (≤ 400 chars).",
                  `\nIncident: ${params.incidentSummary}`,
                  `\nService: ${context.service} (${context.environment})`,
                  `\nFile: ${params.targetFile}\n\`\`\`\n${(snapshot.state.content as string).slice(0, 3_000)}\n\`\`\``
                ].join("\n"),
              }],
            });
            const text = response.content[0]?.type === "text" ? response.content[0].text : null;
            if (text) {
              const sepIdx = text.indexOf("---PR_BODY---");
              if (sepIdx !== -1) {
                patchContent = text.slice(0, sepIdx).trim() + "\n";
                prBody = text.slice(sepIdx + 13).trim().slice(0, 400);
              }
            }
          } catch {
            // Fall through with original content + generic body
          }
        }

        const branchName = `maximal/fix-${context.service}-${Date.now()}`;
        // Get the current head SHA for the base branch
        const currentFile = await github.getFileContent(params.repo, params.targetFile, params.baseBranch);
        await github.createBranch(params.repo, branchName, currentFile.sha);
        await github.commitFile(
          params.repo,
          params.targetFile,
          patchContent,
          `fix(${context.service}): Maximal auto-drafted config change`,
          branchName,
          currentFile.sha,
        );
        const pr = await github.createPr(
          params.repo,
          `fix(${context.service}): Maximal fix-as-code`,
          prBody,
          branchName,
          params.baseBranch,
        );

        return {
          ok: true,
          actionType: "open_fix_as_code_pr",
          awsCalls: [],
          snapshotId: snapshot.id,
          message: `PR #${pr.pullNumber} opened on ${params.repo}: ${branchName}`,
        };
        void start;
      },
      revert: async (snapshot, _context) => {
        const pr = snapshot.state as unknown as { pullNumber?: number; repo?: string };
        if (pr.pullNumber && pr.repo) {
          await github.closePr(pr.repo, pr.pullNumber);
        }
        return {
          ok: true,
          actionType: "open_fix_as_code_pr",
          awsCalls: [],
          snapshotId: snapshot.id,
          message: pr.pullNumber ? `PR #${pr.pullNumber} closed` : "No PR to close (revert no-op)",
        };
      },
    };
    registry.register(openFixAsCodePr);

  // ── Open revert PR ────────────────────────────────────────────────────────
  // Creates a revert commit on a new branch and opens a PR against the base
  // branch. Targets EC2 (and any instance-based) services where there is no
  // AWS-native runtime rollback — the PR is the revert mechanism, and the
  // team's existing CD pipeline handles the redeploy after merge.
  //
  // Safety constraint: only reverts the branch tip. If the bad commit is not
  // the current HEAD of baseBranch (i.e. subsequent commits have landed),
  // preconditions fail and the incident escalates — we cannot safely produce
  // a conflict-free revert commit without human-assisted merge resolution.
  const revertPrParams = z.object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/repo"),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-char git SHA"),
    baseBranch: z.string().min(1).default("main"),
    incidentSummary: z.string().min(1).max(2_000),
  });
  const openRevertPr: RemediationAction<z.infer<typeof revertPrParams>> = {
    type: "open_revert_pr",
    isReversible: true,
    parseParams: (input) => revertPrParams.parse(input),
    blastRadius: (_params, context) => ({
      affectedServices: [context.service],
      environment: context.environment,
      actionType: "open_revert_pr",
    }),
    preconditions: async (params, _context) => {
      if (!params.repo) return { ok: false, reason: "missing_repo" };
      if (!params.commitSha) return { ok: false, reason: "missing_commit_sha" };
      const { sha: headSha } = await github.getBranchHead(params.repo, params.baseBranch);
      // Null adapter returns all-zeros — skip the tip check in dry-run mode
      if (headSha !== "0000000000000000000000000000000000000000" && headSha !== params.commitSha) {
        return { ok: false, reason: "commit_is_not_branch_tip_cannot_safely_auto_revert" };
      }
      return { ok: true };
    },
    captureState: async (params, _context) => {
      const { sha: headSha } = await github.getBranchHead(params.repo, params.baseBranch);
      const badCommit = await github.getCommit(params.repo, params.commitSha);
      const parentCommit = await github.getCommit(params.repo, badCommit.parentSha);
      // Branch name is deterministic from SHA so revert() can find the open PR
      const branchName = `maximal/revert-${params.commitSha.slice(0, 8)}`;
      return {
        id: randomUUID(),
        actionType: "open_revert_pr",
        resource: `github:${params.repo}@${params.baseBranch}`,
        state: {
          repo: params.repo,
          baseBranch: params.baseBranch,
          commitSha: params.commitSha,
          commitMessage: badCommit.message,
          parentTreeSha: parentCommit.treeSha,
          headSha,
          branchName,
        },
        capturedAt: new Date().toISOString(),
      };
    },
    execute: async (params, context, snapshot) => {
      const { repo, baseBranch, commitSha, commitMessage, parentTreeSha, headSha, branchName } =
        snapshot.state as {
          repo: string; baseBranch: string; commitSha: string; commitMessage: string;
          parentTreeSha: string; headSha: string; branchName: string;
        };

      const firstLine = (commitMessage as string).split("\n")[0] ?? commitMessage;
      const revertMessage = [
        `Revert "${firstLine}"`,
        "",
        `This reverts commit ${commitSha}.`,
        "",
        `Auto-created by Maximal during incident response on ${context.service} (${context.environment}).`,
        `Incident summary: ${params.incidentSummary.slice(0, 400)}`,
      ].join("\n");

      const { sha: revertSha } = await github.createCommit(repo, {
        message: revertMessage,
        treeSha: parentTreeSha,
        parentShas: [headSha],
      });

      await github.createRef(repo, `refs/heads/${branchName}`, revertSha);

      const pr = await github.createPr(
        repo,
        `revert(${context.service}): Revert breaking deploy — Maximal`,
        [
          `## Automated revert`,
          ``,
          `Maximal detected a service outage on \`${context.service}\` (${context.environment}) correlated with a recent deploy and opened this revert automatically.`,
          ``,
          `**Reverts commit:** \`${commitSha}\``,
          `**Original message:** ${firstLine}`,
          ``,
          `**Incident summary:** ${params.incidentSummary.slice(0, 500)}`,
          ``,
          `> ⚠️ Review before merging. Merging will trigger your standard CI/CD deployment pipeline to redeploy \`${baseBranch}\` to production.`,
        ].join("\n"),
        branchName,
        baseBranch,
      );

      return {
        ok: true,
        actionType: "open_revert_pr",
        awsCalls: [],
        snapshotId: snapshot.id,
        message: `Revert PR #${pr.pullNumber} opened on ${repo}: ${branchName}`,
      };
    },
    revert: async (snapshot, _context) => {
      const { repo, branchName } = snapshot.state as { repo: string; branchName: string };
      const pullNumber = await github.findPullRequestByBranch(repo, branchName);
      if (pullNumber) {
        await github.closePr(repo, pullNumber);
        return {
          ok: true,
          actionType: "open_revert_pr",
          awsCalls: [],
          snapshotId: snapshot.id,
          message: `Revert PR #${pullNumber} closed (remediation rolled back)`,
        };
      }
      return {
        ok: true,
        actionType: "open_revert_pr",
        awsCalls: [],
        snapshotId: snapshot.id,
        message: "No open revert PR found to close — may have already been merged or closed manually",
      };
    },
  };
    registry.register(openRevertPr);
  }

  return registry;
}
