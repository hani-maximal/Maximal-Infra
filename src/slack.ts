import pkg from "@slack/bolt";
import type { App } from "@slack/bolt";
const { App: SlackApp, LogLevel } = pkg;
import type { Orchestrator, PlannedAction } from "./orchestrator.js";
import type { Incident } from "./types.js";

interface MessageRef {
  channel: string;
  ts: string;
}

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function createSlackApp(
  botToken: string,
  signingSecret: string,
  appToken: string
): App {
  return new SlackApp({
    token: botToken,
    signingSecret,
    appToken,
    socketMode: true,
    logLevel: LogLevel.WARN
  });
}

export class SlackNotifier {
  readonly #app: App;
  readonly #orchestrator: Orchestrator;
  readonly #refs = new Map<string, MessageRef>();

  constructor(app: App, orchestrator: Orchestrator) {
    this.#app = app;
    this.#orchestrator = orchestrator;
    this.#registerActions();
  }

  #registerActions(): void {
    this.#app.action("approve_incident", async ({ action, ack, body }: any) => {
      await ack();
      const incidentId = action.value;
      if (!incidentId) return;
      try {
        const incident = await this.#orchestrator.approve(incidentId, body.user.id);
        await this.notifyOutcome(incidentId, incident);
      } catch (err) {
        await this.#postError(incidentId, err instanceof Error ? err.message : "Approval failed");
      }
    });

    this.#app.action("deny_incident", async ({ action, ack, body }: any) => {
      await ack();
      const incidentId = action.value;
      if (!incidentId) return;
      try {
        const incident = await this.#orchestrator.deny(incidentId, body.user.id);
        await this.notifyOutcome(incidentId, incident);
      } catch (err) {
        await this.#postError(incidentId, err instanceof Error ? err.message : "Denial failed");
      }
    });
  }

  async requestApproval(incident: Incident, plan: PlannedAction, channel: string): Promise<void> {
    const pct = Math.round(incident.confidence * 100);
    const summary = escapeMrkdwn(incident.evidence[0]?.summary ?? "No evidence summary available.");
    const result = await this.#app.client.chat.postMessage({
      channel,
      text: `Incident: ${incident.service} — approval required for \`${plan.actionType}\``,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: `Incident: ${incident.service}`, emoji: false }
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Type*\n${incident.type}` },
            { type: "mrkdwn", text: `*Environment*\n${incident.environment}` },
            { type: "mrkdwn", text: `*Confidence*\n${pct}%` },
            { type: "mrkdwn", text: `*Proposed action*\n\`${plan.actionType}\`` }
          ]
        },
        { type: "section", text: { type: "mrkdwn", text: summary } },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Approve", emoji: false },
              style: "primary",
              action_id: "approve_incident",
              value: incident.id
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Deny", emoji: false },
              style: "danger",
              action_id: "deny_incident",
              value: incident.id
            }
          ]
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `ID: \`${incident.id}\`` }]
        }
      ]
    });
    const ts = result.ts;
    if (ts) this.#refs.set(incident.id, { channel, ts });
  }

  async notifyOutcome(incidentId: string, incident: Incident): Promise<void> {
    const ref = this.#refs.get(incidentId);
    if (!ref) return;
    const approved = incident.state !== "ESCALATED";
    const icon = approved ? ":white_check_mark:" : ":no_entry:";
    const label = approved ? "Approved — executing" : "Denied — escalated to on-call";
    await this.#app.client.chat.update({
      channel: ref.channel,
      ts: ref.ts,
      text: `${incident.service} — ${label}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${icon} *${incident.service}* — ${label}\n_Incident \`${incidentId}\`_`
          }
        }
      ]
    });
  }

  async #postError(incidentId: string, message: string): Promise<void> {
    const ref = this.#refs.get(incidentId);
    if (!ref) return;
    await this.#app.client.chat.postMessage({
      channel: ref.channel,
      thread_ts: ref.ts,
      text: `:warning: ${message} — incident \`${incidentId}\``
    });
  }
}
