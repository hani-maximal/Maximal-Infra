import {
  IncidentRepository,
  ContractRegistry,
  ContextGraph,
  AuditStore,
  DeterministicVerifier,
} from "./core.js";
import { Orchestrator } from "./orchestrator.js";
import type { ActionRegistry } from "./core.js";
import type { AutonomyMode } from "./types.js";
import { getDb } from "./db/client.js";

export interface TenantBundle {
  orchestrator: Orchestrator;
  contracts: ContractRegistry;
  incidents: IncidentRepository;
  audit: AuditStore;
  contexts: ContextGraph;
}

// Per-tenant factory. Lazily creates a fully-wired bundle (orchestrator +
// contract registry + incident repository + audit store) for any tenantId.
// The default tenant's bundle is pre-registered at startup so tests and
// single-tenant deploys get the same in-memory instances as before.
export class TenantRegistry {
  readonly #bundles = new Map<string, TenantBundle>();
  readonly #actions: ActionRegistry;
  readonly #mode: AutonomyMode;
  readonly #contractsDir: string;

  constructor(actions: ActionRegistry, mode: AutonomyMode, contractsDir: string) {
    this.#actions = actions;
    this.#mode = mode;
    this.#contractsDir = contractsDir;
  }

  // Pre-register a bundle (used for the default tenant at startup).
  register(tenantId: string, bundle: TenantBundle): void {
    this.#bundles.set(tenantId, bundle);
  }

  // Return the bundle for a known tenant, or null if not yet created.
  get(tenantId: string): TenantBundle | null {
    return this.#bundles.get(tenantId) ?? null;
  }

  // Return the bundle, creating it on first access.
  // defaultContracts is the filesystem-loaded registry used as a fallback
  // when S3 is not configured or returns nothing for this tenant.
  async getOrCreate(tenantId: string, defaultContracts: ContractRegistry): Promise<TenantBundle> {
    const existing = this.#bundles.get(tenantId);
    if (existing) return existing;

    const incidents = new IncidentRepository();
    const contracts = new ContractRegistry();
    const contexts = new ContextGraph();
    const audit = new AuditStore();
    const verifier = new DeterministicVerifier();

    const db = getDb();
    if (db) {
      incidents.setDb(db, tenantId);
      audit.setDb(db, tenantId);
      await incidents.loadFromDb().catch((err: unknown) => {
        console.warn(`[tenant] Failed to load incidents for ${tenantId}:`, err instanceof Error ? err.message : err);
      });
    }

    // Load contracts from S3 with tenant-specific prefix; fall back to defaults
    if (process.env.CONTRACTS_BUCKET) {
      await contracts.loadFromS3(tenantId).catch((err: unknown) => {
        console.warn(`[tenant] S3 contract load failed for ${tenantId}:`, err instanceof Error ? err.message : err);
      });
    }
    if (contracts.contracts.size === 0) {
      for (const [type, contract] of defaultContracts.contracts) {
        contracts.contracts.set(type, contract);
      }
    }

    const orchestrator = new Orchestrator(
      incidents,
      contracts,
      contexts,
      this.#actions,
      audit,
      verifier,
      this.#mode,
      tenantId,
    );

    const bundle: TenantBundle = { orchestrator, contracts, incidents, audit, contexts };
    this.#bundles.set(tenantId, bundle);
    console.info(`[tenant] Created bundle for tenant ${tenantId} (${contracts.contracts.size} contracts)`);
    return bundle;
  }

  // Hot-reload contracts for a tenant from S3. Called on Redis pub/sub reload signal.
  async reloadContracts(tenantId: string): Promise<void> {
    const bundle = this.#bundles.get(tenantId);
    if (bundle) {
      await bundle.contracts.reload(tenantId);
    }
  }

  // All registered tenantIds (for observability / health check).
  tenantIds(): string[] {
    return [...this.#bundles.keys()];
  }
}
