import type { AuditRecord, Contract, Health, Incident } from "./types.js";

export class UnauthorizedError extends Error {
  constructor() {
    super("Session expired. Please sign in again.");
    this.name = "UnauthorizedError";
  }
}

let _token: string | null = null;

export function setApiToken(token: string | null): void {
  _token = token;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (_token) headers["authorization"] = `Bearer ${_token}`;
  const response = await fetch(url, { headers, ...init });
  if (response.status === 401) throw new UnauthorizedError();
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Request failed");
  return body;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ token: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    }),
  logout: () =>
    request("/api/auth/logout", { method: "POST", body: "{}" }),
  health: () => request<Health>("/api/health"),
  incidents: () => request<Incident[]>("/api/incidents"),
  contracts: () => request<Contract[]>("/api/contracts"),
  replay: (id: string) =>
    request<{ valid: boolean; records: AuditRecord[] }>(`/api/incidents/${id}/replay`),
  simulate: (type: string) =>
    request<Incident>("/api/incidents/demo", {
      method: "POST",
      body: JSON.stringify({ type, confidence: 0.97, environment: "staging" })
    }),
  plan: (id: string) =>
    request(`/api/incidents/${id}/plan`, { method: "POST", body: "{}" }),
  approve: (id: string) =>
    request(`/api/incidents/${id}/approve`, { method: "POST", body: "{}" }),
  deny: (id: string) =>
    request(`/api/incidents/${id}/deny`, { method: "POST", body: "{}" }),
  failVerification: (id: string) =>
    request(`/api/incidents/${id}/simulate-verification-failure`, {
      method: "POST",
      body: "{}"
    })
};
