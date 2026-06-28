import { randomUUID } from "node:crypto";
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  type MetricAlarm,
} from "@aws-sdk/client-cloudwatch";
import type { AuditStore, ContextGraph, IncidentRepository } from "../core.js";
import type { AwsCredentials } from "../actions.js";
import type { Incident, IncidentType, ServiceContext } from "../types.js";

export interface CloudWatchAlarmsConfig {
  region: string;
  environment: string;
  /** Optional alarm name prefix — limits polling to alarms matching this prefix. */
  alarmNamePrefix?: string;
  pollIntervalMs?: number;
  credentials?: AwsCredentials;
}

// ---------------------------------------------------------------------------
// Alarm → incident type mapping
// ---------------------------------------------------------------------------
// Returns null for alarm namespaces/metrics we don't have a contract for —
// those alarms are ignored rather than creating incidents we can't remediate.

function mapAlarmToIncidentType(alarm: MetricAlarm): IncidentType | null {
  const ns = alarm.Namespace ?? "";
  const metric = alarm.MetricName ?? "";

  if (ns === "AWS/EC2") {
    if (metric === "StatusCheckFailed" || metric === "StatusCheckFailed_Instance" || metric === "StatusCheckFailed_System") {
      return "ec2_instance_status_check_failed";
    }
    if (metric === "disk_used_percent" || metric.toLowerCase().includes("disk")) {
      return "ec2_disk_full";
    }
  }

  if (ns === "AWS/Lambda") {
    if (metric === "Errors") return "lambda_error_spike";
    if (metric === "Throttles") return "lambda_throttling_concurrency_exhausted";
    if (metric === "Duration") return "lambda_timeout_duration_spike";
  }

  if (ns === "AWS/ApplicationELB") {
    if (metric === "HTTPCode_Target_5XX_Count" || metric === "HTTPCode_ELB_5XX_Count") {
      return "post_deploy_5xx_spike";
    }
    if (metric === "TargetResponseTime") return "alb_latency_saturation";
    if (metric === "UnHealthyHostCount") return "alb_target_unhealthy_no_deploy";
  }

  if (ns === "AWS/ECS") {
    if (metric === "RunningTaskCount" || metric === "CPUUtilization" || metric === "MemoryUtilization") {
      return "ecs_service_unhealthy";
    }
  }

  if (ns === "AWS/RDS") {
    if (metric === "DatabaseConnections") return "rds_connection_saturation";
  }

  if (ns === "AWS/SQS") {
    if (metric === "ApproximateNumberOfMessagesVisible" || metric === "NumberOfMessagesSent") {
      return "sqs_worker_backlog_saturation";
    }
  }

  if (ns === "AWS/ElastiCache") {
    if (metric === "Evictions" || metric === "DatabaseMemoryUsagePercentage") {
      return "elasticache_memory_pressure_evictions";
    }
  }

  if (ns === "AWS/AutoScaling") {
    if (metric === "GroupInServiceInstances" || metric === "GroupTotalInstances") {
      return "ec2_asg_unhealthy_hosts";
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Resource + service extraction from alarm dimensions
// ---------------------------------------------------------------------------

interface AlarmResources {
  service: string;
  resources: ServiceContext["resources"];
}

function extractFromAlarm(alarm: MetricAlarm, region: string): AlarmResources {
  const dims = Object.fromEntries(
    (alarm.Dimensions ?? []).map((d) => [d.Name ?? "", d.Value ?? ""])
  );

  const resources: ServiceContext["resources"] = {};
  let service = alarm.AlarmName ?? "unknown-service";

  if (dims["InstanceId"]) {
    resources.ec2 = { instanceId: dims["InstanceId"], region };
    service = dims["InstanceId"];
  }

  if (dims["FunctionName"]) {
    resources.lambda = { functionName: dims["FunctionName"], alias: "live" };
    service = dims["FunctionName"];
  }

  if (dims["ClusterName"] && dims["ServiceName"]) {
    resources.ecs = { cluster: dims["ClusterName"], service: dims["ServiceName"] };
    service = dims["ServiceName"];
  } else if (dims["ClusterName"]) {
    service = dims["ClusterName"];
  }

  if (dims["LoadBalancer"]) {
    // ALB alarms — use LoadBalancer dimension as service name if nothing else
    service = service === alarm.AlarmName ? (dims["LoadBalancer"].split("/")[1] ?? service) : service;
  }

  return { service, resources };
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

export class CloudWatchAlarmsDetector {
  readonly #cw: CloudWatchClient;
  readonly #region: string;
  readonly #environment: string;
  readonly #alarmNamePrefix: string | undefined;
  readonly #pollIntervalMs: number;

  readonly #incidents: IncidentRepository;
  readonly #contexts: ContextGraph;
  readonly #audit: AuditStore;

  // alarmArn → incidentId for alarms currently in ALARM state
  readonly #activeIncidents = new Map<string, string>();

  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: CloudWatchAlarmsConfig,
    incidents: IncidentRepository,
    contexts: ContextGraph,
    audit: AuditStore
  ) {
    this.#region = config.region;
    this.#environment = config.environment;
    this.#alarmNamePrefix = config.alarmNamePrefix;
    this.#pollIntervalMs = config.pollIntervalMs ?? 60_000;
    this.#incidents = incidents;
    this.#contexts = contexts;
    this.#audit = audit;

    const cfg = config.credentials
      ? { region: config.region, credentials: config.credentials }
      : { region: config.region };
    this.#cw = new CloudWatchClient(cfg);
  }

  start(): void {
    console.log(
      `[cloudwatch-alarms] Polling ${this.#region} every ${this.#pollIntervalMs / 1000}s` +
      (this.#alarmNamePrefix ? ` (prefix: ${this.#alarmNamePrefix})` : "")
    );
    void this.#poll();
    this.#timer = setInterval(() => void this.#poll(), this.#pollIntervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  async #poll(): Promise<void> {
    try {
      const response = await this.#cw.send(new DescribeAlarmsCommand({
        StateValue: "ALARM",
        ...(this.#alarmNamePrefix ? { AlarmNamePrefix: this.#alarmNamePrefix } : {}),
        MaxRecords: 100,
      }));

      const currentAlarms = response.MetricAlarms ?? [];
      const currentArns = new Set(currentAlarms.map((a) => a.AlarmArn ?? a.AlarmName ?? ""));

      // Alarms that cleared since last poll — remove from tracking
      for (const arn of this.#activeIncidents.keys()) {
        if (!currentArns.has(arn)) {
          console.log(`[cloudwatch-alarms] Alarm cleared: ${arn}`);
          this.#activeIncidents.delete(arn);
        }
      }

      // New alarms that just entered ALARM state
      for (const alarm of currentAlarms) {
        const arn = alarm.AlarmArn ?? alarm.AlarmName ?? "";
        if (!arn || this.#activeIncidents.has(arn)) continue;

        const incidentType = mapAlarmToIncidentType(alarm);
        if (!incidentType) {
          console.log(`[cloudwatch-alarms] No incident type mapping for ${alarm.Namespace}/${alarm.MetricName} — skipping`);
          continue;
        }

        this.#createIncident(alarm, arn, incidentType);
      }
    } catch (err) {
      console.error(
        "[cloudwatch-alarms] Poll failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  #createIncident(alarm: MetricAlarm, arn: string, incidentType: IncidentType): void {
    const now = new Date().toISOString();
    const id = randomUUID();
    const { service, resources } = extractFromAlarm(alarm, this.#region);
    const alarmName = alarm.AlarmName ?? arn;
    const reason = alarm.StateReason ?? "CloudWatch alarm entered ALARM state";
    const metricLabel = alarm.MetricName ? `${alarm.Namespace}/${alarm.MetricName}` : alarm.Namespace ?? "unknown";

    const incident: Incident = {
      id,
      type: incidentType,
      service,
      environment: this.#environment,
      source: "aws_devops_agent",
      confidence: 0.92,
      evidence: [
        {
          kind: "alarm",
          ref: `cloudwatch://alarm/${this.#region}/${alarmName}`,
          summary: `CloudWatch alarm ${alarmName} entered ALARM state`,
          observedAt: alarm.StateUpdatedTimestamp?.toISOString() ?? now,
          location: {
            resource: arn,
            source: `CloudWatch / ${alarm.Namespace ?? "unknown"}`,
            selector: metricLabel,
          },
          excerpt: [
            `AlarmName:   ${alarmName}`,
            `StateValue:  ALARM`,
            `Namespace:   ${alarm.Namespace ?? "—"}`,
            `MetricName:  ${alarm.MetricName ?? "—"}`,
            `Threshold:   ${alarm.Threshold ?? "—"} (${alarm.ComparisonOperator ?? "—"})`,
            `Period:      ${alarm.Period ?? "—"}s · ${alarm.EvaluationPeriods ?? "—"} periods`,
            `Reason:      ${reason}`,
          ].join("\n"),
          interpretation: reason,
        },
        {
          kind: "metric",
          ref: `cloudwatch://metric/${this.#region}/${alarm.Namespace}/${alarm.MetricName}`,
          summary: `${metricLabel} breached threshold ${alarm.Threshold ?? "?"}`,
          observedAt: now,
          location: {
            resource: arn,
            source: `CloudWatch / ${alarm.Namespace ?? "unknown"} / ${alarm.MetricName ?? "unknown"}`,
            selector: (alarm.Dimensions ?? [])
              .map((d) => `${d.Name}=${d.Value}`)
              .join(", ") || alarmName,
          },
          excerpt: [
            `Metric:      ${metricLabel}`,
            `Threshold:   ${alarm.Threshold ?? "?"}`,
            `Statistic:   ${alarm.Statistic ?? "?"}`,
            `Period:      ${alarm.Period ?? "?"}s`,
            `Dimensions:  ${(alarm.Dimensions ?? []).map((d) => `${d.Name}=${d.Value}`).join(", ") || "none"}`,
          ].join("\n"),
          interpretation: `${metricLabel} crossed the alarm threshold, triggering this incident.`,
        },
      ],
      deployCorrelation: null,
      state: "DETECTED",
      createdAt: now,
    };

    this.#incidents.create(incident);

    this.#contexts.upsert({
      service,
      environment: this.#environment,
      dependencies: [],
      allowedActions: ["escalate"],
      resources,
    });

    this.#audit.append({
      incidentId: id,
      actor: "system",
      actorId: null,
      eventType: "signal",
      payload: {
        detector: "maximal.cloudwatch_alarms",
        source: "aws_devops_agent",
        alarmName,
        alarmArn: arn,
        namespace: alarm.Namespace,
        metricName: alarm.MetricName,
        region: this.#region,
        stateReason: reason,
      },
    });

    this.#activeIncidents.set(arn, id);
    console.error(
      `[cloudwatch-alarms] *** INCIDENT CREATED ${id} *** alarm=${alarmName} type=${incidentType} service=${service}`
    );
  }
}
