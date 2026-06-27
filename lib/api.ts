import type { Incident, Contract, AuditRecord, Plan } from './types'

export interface AuditReplay {
  valid: boolean
  records: AuditRecord[]
}

export interface Health {
  ok: boolean
  mode: 'observe' | 'approve' | 'bounded_auto'
  contracts: number
  chainValid: boolean
  authEnabled: boolean
}

interface RawHealth {
  ok: boolean
  mode: Health['mode']
  contractCount?: number
  contracts?: number
  auditChainValid?: boolean
  chainValid?: boolean
  authEnabled?: boolean
}

interface RawContract {
  incident_type: string
  source: string[]
  detect: Record<string, unknown>
  min_confidence: number
  allowed_actions: string[]
  approval: {
    mode: Contract['approval']['mode']
    blast_radius: {
      max_affected_services: number
      environments: string[]
      allowed_action_types: string[]
      require_reversible: boolean
    }
  }
  verify: Contract['verify']
  rollback_if_failed: boolean
  on_resolve: {
    draft_postmortem: boolean
    learn_contract: boolean
  }
  notify: {
    slack_channel: string
  }
}

interface RawPolicy {
  decision?: Plan['decision']
  reasons?: string[]
  blastRadius?: Plan['blastRadius']
}

interface RawPlan {
  actionType: string
  decision?: Plan['decision']
  reasons?: string[]
  blastRadius?: Plan['blastRadius']
  policy?: RawPolicy
}

interface RawIncident extends Omit<Incident, 'plan'> {
  plan?: RawPlan | null
}

function planFromApi(plan: RawPlan): Plan {
  return {
    actionType: plan.actionType,
    decision: plan.decision ?? plan.policy?.decision ?? 'ESCALATE',
    reasons: plan.reasons ?? plan.policy?.reasons ?? [],
    blastRadius: plan.blastRadius ?? plan.policy?.blastRadius,
  }
}

function incidentFromApi(incident: RawIncident): Incident {
  const { plan, ...rest } = incident
  return {
    ...rest,
    ...(plan ? { plan: planFromApi(plan) } : {}),
  }
}

function contractFromApi(contract: RawContract): Contract {
  return {
    incidentType: contract.incident_type,
    source: contract.source,
    detect: contract.detect,
    minConfidence: contract.min_confidence,
    allowedActions: contract.allowed_actions,
    approval: {
      mode: contract.approval.mode,
      blastRadius: {
        maxAffectedServices: contract.approval.blast_radius.max_affected_services,
        environments: contract.approval.blast_radius.environments,
        allowedActionTypes: contract.approval.blast_radius.allowed_action_types,
        requireReversible: contract.approval.blast_radius.require_reversible,
      },
    },
    verify: contract.verify,
    rollbackIfFailed: contract.rollback_if_failed,
    onResolve: {
      draftPostmortem: contract.on_resolve.draft_postmortem,
      learnContract: contract.on_resolve.learn_contract,
    },
    notify: {
      slackChannel: contract.notify.slack_channel,
    },
  }
}

function healthFromApi(health: RawHealth): Health {
  return {
    ok: health.ok,
    mode: health.mode,
    contracts: health.contracts ?? health.contractCount ?? 0,
    chainValid: health.chainValid ?? health.auditChainValid ?? false,
    authEnabled: health.authEnabled ?? false,
  }
}

function token(): string {
  if (typeof window === 'undefined') return ''
  const localToken = localStorage.getItem('maximal_token')
  if (localToken) return localToken

  const cookieToken = document.cookie
    .split('; ')
    .find(row => row.startsWith('maximal_token='))
    ?.split('=')[1]

  return cookieToken ? decodeURIComponent(cookieToken) : ''
}

function headers(hasBody = false): HeadersInit {
  const t = token()
  return {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { ...headers(init?.body !== undefined), ...init?.headers } })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  health: async () => healthFromApi(await request<RawHealth>('/api/health')),

  incidents: {
    list: async () => (await request<RawIncident[]>('/api/incidents')).map(incidentFromApi),
    plan: async (id: string) => planFromApi(await request<RawPlan>(`/api/incidents/${id}/plan`, { method: 'POST' })),
    approve: (id: string) => request<Incident>(`/api/incidents/${id}/approve`, { method: 'POST' }),
    deny: (id: string) => request<Incident>(`/api/incidents/${id}/deny`, { method: 'POST' }),
    replay: (id: string) => request<AuditReplay>(`/api/incidents/${id}/replay`),
    demo: () =>
      request<Incident>('/api/incidents/demo', {
        method: 'POST',
        body: JSON.stringify({
          type: 'post_deploy_5xx_spike',
          confidence: 0.97,
          environment: 'production',
        }),
      }),
    simulateFail: (id: string) =>
      request<unknown>(`/api/incidents/${id}/simulate-verification-failure`, { method: 'POST' }),
  },

  contracts: {
    list: async () => (await request<RawContract[]>('/api/contracts')).map(contractFromApi),
  },

  auth: {
    login: (username: string, password: string) =>
      request<{ token: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  },

  connectors: {
    list: () => request<import('./types').ConnectorStatus[]>('/api/connectors'),
    update: (id: string, data: Partial<import('./types').ConnectorStatus>) =>
      request<import('./types').ConnectorStatus>(`/api/connectors/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
  },

  settings: {
    trust: {
      list: () => request<import('./types').ServiceTrustConfig[]>('/api/settings/trust'),
      update: (id: string, level: import('./types').TrustLevel) =>
        request<import('./types').ServiceTrustConfig>(`/api/settings/trust/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ trustLevel: level }),
        }),
    },
  },

  subscription: {
    get: () => request<import('./types').SubscriptionInfo>('/api/subscription'),
  },
}
