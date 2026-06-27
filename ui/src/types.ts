export interface Evidence {
  kind: string;
  ref: string;
  summary: string;
  value?: number;
  observedAt: string;
  location?: {
    resource: string;
    source: string;
    selector: string;
  };
  excerpt?: string;
  interpretation?: string;
  remediation?: {
    actionType: string;
    explanation: string;
  };
}

export interface Policy {
  decision: "AUTO" | "APPROVE" | "ESCALATE";
  reasons: string[];
  blastRadius: {
    affectedServices: string[];
    environment: string;
    actionType: string;
  };
}

export interface Plan {
  actionType: string;
  params: unknown;
  policy: Policy;
}

export interface Incident {
  id: string;
  type: string;
  service: string;
  environment: string;
  source: string;
  confidence: number;
  evidence: Evidence[];
  deployCorrelation: {
    deployId: string;
    deployedAt: string;
    artifactRef: string;
  } | null;
  state: string;
  createdAt: string;
  plan: Plan | null;
}

export interface Contract {
  incident_type: string;
  min_confidence: number;
  allowed_actions: string[];
  approval: {
    mode: string;
    blast_radius: {
      max_affected_services: number;
      environments: string[];
      allowed_action_types: string[];
      require_reversible: boolean;
    };
  };
  verify: {
    window: string;
    checks: Array<{ metric: string; condition: string }>;
  };
}

export interface Health {
  ok: boolean;
  mode: "observe" | "approve" | "bounded_auto";
  contractCount: number;
  auditChainValid: boolean;
  authEnabled: boolean;
}

export interface AuditRecord {
  id: string;
  ts: string;
  actor: string;
  actorId: string | null;
  eventType: string;
  payload: unknown;
  prevHash: string;
  hash: string;
}
