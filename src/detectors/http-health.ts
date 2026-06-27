import { randomUUID } from "node:crypto";
import type { AuditStore, ContextGraph, IncidentRepository } from "../core.js";
import type { Incident } from "../types.js";

export interface HttpHealthConfig {
  url: string;
  service: string;
  environment: string;
  instanceId?: string;
  region?: string;
  pollIntervalMs?: number;
  failureThreshold?: number;
  successThreshold?: number;
}

export class HttpHealthDetector {
  readonly #url: string;
  readonly #service: string;
  readonly #environment: string;
  readonly #instanceId: string;
  readonly #region: string;
  readonly #pollIntervalMs: number;
  readonly #failureThreshold: number;
  readonly #successThreshold: number;

  readonly #incidents: IncidentRepository;
  readonly #contexts: ContextGraph;
  readonly #audit: AuditStore;

  #consecutiveFailures = 0;
  #consecutiveSuccesses = 0;
  #activeIncidentId: string | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: HttpHealthConfig,
    incidents: IncidentRepository,
    contexts: ContextGraph,
    audit: AuditStore
  ) {
    this.#url = config.url;
    this.#service = config.service;
    this.#environment = config.environment;
    this.#instanceId = config.instanceId ?? "";
    this.#region = config.region ?? "us-east-1";
    this.#pollIntervalMs = config.pollIntervalMs ?? 30_000;
    this.#failureThreshold = config.failureThreshold ?? 3;
    this.#successThreshold = config.successThreshold ?? 2;
    this.#incidents = incidents;
    this.#contexts = contexts;
    this.#audit = audit;
  }

  start(): void {
    console.log(
      `[http-health] Polling ${this.#url} every ${this.#pollIntervalMs / 1000}s ` +
      `(incident after ${this.#failureThreshold} consecutive failures)`
    );
    void this.#check();
    this.#timer = setInterval(() => void this.#check(), this.#pollIntervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  async #check(): Promise<void> {
    const start = Date.now();
    try {
      const res = await fetch(this.#url, {
        signal: AbortSignal.timeout(8_000),
        headers: { "User-Agent": "Maximal-HealthProbe/1.0" },
        redirect: "follow"
      });
      const latencyMs = Date.now() - start;
      if (res.ok) {
        this.#onSuccess(res.status, latencyMs);
      } else {
        this.#onFailure(res.status, latencyMs, `HTTP ${res.status}`);
      }
    } catch (err) {
      const latencyMs = Date.now() - start;
      const reason = err instanceof Error ? err.message : "connection failed";
      this.#onFailure(null, latencyMs, reason);
    }
  }

  #onSuccess(status: number, latencyMs: number): void {
    this.#consecutiveFailures = 0;
    this.#consecutiveSuccesses++;

    if (this.#activeIncidentId && this.#consecutiveSuccesses >= this.#successThreshold) {
      console.log(`[http-health] ${this.#url} recovered (HTTP ${status}, ${latencyMs}ms) — resetting`);
      this.#activeIncidentId = null;
    } else {
      console.log(`[http-health] ${this.#url} OK — HTTP ${status} in ${latencyMs}ms`);
    }
  }

  #onFailure(status: number | null, latencyMs: number, reason: string): void {
    this.#consecutiveSuccesses = 0;
    this.#consecutiveFailures++;

    const statusStr = status != null ? `HTTP ${status}` : "no response";
    console.warn(
      `[http-health] ${this.#url} FAIL #${this.#consecutiveFailures}/${this.#failureThreshold}` +
      ` — ${reason} (${latencyMs}ms)`
    );

    if (this.#consecutiveFailures >= this.#failureThreshold && !this.#activeIncidentId) {
      this.#createIncident(statusStr, latencyMs);
    }
  }

  #createIncident(statusStr: string, latencyMs: number): void {
    const now = new Date().toISOString();
    const id = randomUUID();

    const incident: Incident = {
      id,
      type: "ec2_instance_status_check_failed",
      service: this.#service,
      environment: this.#environment,
      source: "self_detect",
      confidence: 0.95,
      evidence: [
        {
          kind: "metric",
          ref: `http-probe://${this.#service}/status`,
          summary: `${this.#service} unreachable — ${statusStr} for ${this.#consecutiveFailures} consecutive health checks`,
          value: latencyMs,
          observedAt: now,
          location: {
            resource: this.#url,
            source: "Maximal HTTP health probe",
            selector: `${this.#failureThreshold} consecutive checks · ${latencyMs}ms last response`
          },
          excerpt: [
            `target:    ${this.#url}`,
            `status:    ${statusStr}`,
            `latency:   ${latencyMs}ms`,
            `failures:  ${this.#consecutiveFailures} consecutive`,
            `threshold: ${this.#failureThreshold} failures`,
            this.#instanceId ? `instance:  ${this.#instanceId} (${this.#region})` : ""
          ]
            .filter(Boolean)
            .join("\n"),
          interpretation:
            `${this.#service} has been unreachable for ${this.#consecutiveFailures} consecutive probes. ` +
            `The EC2 instance may be stopped, crashed, or the process may have exited.`,
          remediation: {
            actionType: "restart_ec2_instance",
            explanation: this.#instanceId
              ? `Starting EC2 instance ${this.#instanceId} (${this.#region}) will restore service ` +
                `if the instance was stopped or requires a reboot.`
              : "Starting the EC2 instance will restore service if it was stopped or requires a reboot."
          }
        },
        {
          kind: "alarm",
          ref: `http-probe://${this.#service}/consecutive-failures`,
          summary: `${this.#service} synthetic alarm: ${this.#consecutiveFailures}/${this.#failureThreshold} consecutive probe failures`,
          observedAt: now,
          location: {
            resource: this.#url,
            source: "Maximal HTTP health probe",
            selector: `consecutive_failures >= ${this.#failureThreshold}`
          },
          excerpt: [
            `AlarmName: ${this.#service}/http-probe/consecutive-failures`,
            `StateValue: ALARM`,
            `Threshold: ${this.#failureThreshold} consecutive failures`,
            `ObservedValue: ${this.#consecutiveFailures}`,
            `LastStatus: ${statusStr}`,
            `LastLatencyMs: ${latencyMs}`
          ].join("\n"),
          interpretation:
            `Probe failure count crossed the configured threshold of ${this.#failureThreshold}, ` +
            `triggering this incident. All ${this.#consecutiveFailures} probes returned no healthy response.`,
          remediation: {
            actionType: "restart_ec2_instance",
            explanation: this.#instanceId
              ? `Restarting ${this.#instanceId} (${this.#region}) should clear the alarm once the HTTP endpoint recovers.`
              : "Restarting the EC2 instance should clear the alarm once the HTTP endpoint recovers."
          }
        }
      ],
      deployCorrelation: null,
      state: "DETECTED",
      createdAt: now
    };

    this.#incidents.create(incident);

    this.#contexts.upsert({
      service: this.#service,
      environment: this.#environment,
      dependencies: [],
      allowedActions: ["restart_ec2_instance"],
      resources: this.#instanceId
        ? { ec2: { instanceId: this.#instanceId, region: this.#region } }
        : {}
    });

    this.#audit.append({
      incidentId: id,
      actor: "system",
      actorId: null,
      eventType: "signal",
      payload: {
        source: "self_detect",
        url: this.#url,
        consecutiveFailures: this.#consecutiveFailures,
        status: statusStr,
        latencyMs
      }
    });

    this.#activeIncidentId = id;
    console.error(
      `[http-health] *** INCIDENT CREATED ${id} *** ${this.#service} is DOWN — ` +
      `open the dashboard to evaluate the plan`
    );
  }
}
