export interface Evidence {
  kind: 'metric' | 'log' | 'deploy_event' | 'cloudtrail' | 'alarm'
  ref: string
  summary: string
  value?: number
  observedAt: string
}

export interface DeployCorrelation {
  deployId: string
  deployedAt: string
  artifactRef: string
}

export type IncidentState =
  | 'DETECTED' | 'CLASSIFIED' | 'CONTRACT_MATCHED' | 'AWAITING_APPROVAL'
  | 'EXECUTING' | 'VERIFYING' | 'RESOLVED' | 'ROLLING_BACK'
  | 'ROLLED_BACK' | 'ESCALATED' | 'CLOSED'

export interface Plan {
  actionType: string
  decision: 'AUTO' | 'APPROVE' | 'ESCALATE'
  reasons: string[]
  blastRadius?: { maxAffectedServices: number; environments: string[] }
}

export interface Incident {
  id: string
  type: string
  service: string
  environment: string
  source: string
  confidence: number
  evidence: Evidence[]
  deployCorrelation: DeployCorrelation | null
  state: IncidentState
  createdAt: string
  plan?: Plan
}

export interface AuditRecord {
  id: string
  incidentId: string
  ts: string
  actor: 'system' | 'human'
  actorId: string | null
  eventType: string
  payload: unknown
  prevHash: string
  hash: string
}

export interface Contract {
  incidentType: string
  source: string[]
  detect: Record<string, unknown>
  minConfidence: number
  allowedActions: string[]
  approval: {
    mode: 'always_human' | 'auto_under_blast_radius'
    blastRadius: {
      maxAffectedServices: number
      environments: string[]
      allowedActionTypes: string[]
      requireReversible: boolean
    }
  }
  verify: {
    window: string
    checks: Array<{ metric: string; condition: string }>
  }
  rollbackIfFailed: boolean
  onResolve: { draftPostmortem: boolean; learnContract: boolean }
  notify: { slackChannel: string }
}

export type TrustLevel = 'observe' | 'approve' | 'bounded_auto' | 'expanded_auto'

export type SubscriptionTier = 'starter' | 'team' | 'scale' | 'enterprise'

export interface TierLimits {
  maxServices: number | null
  allowedModes: string[]
  slackWorkflows: boolean
  customTrustConfigs: boolean
  auditExport: boolean
  allowedConnectors: string[]
  sso: boolean
  customContracts: boolean
}

export interface SubscriptionInfo {
  tier: SubscriptionTier
  limits: TierLimits
  usage: {
    serviceCount: number
  }
}

export interface ConnectorStatus {
  id: string
  name: string
  connected: boolean
  detail?: string
  connectedAt?: string
}

export interface ServiceTrustConfig {
  id: string
  service: string
  environment: string
  trustLevel: TrustLevel
  updatedAt: string
  updatedBy: string
}
