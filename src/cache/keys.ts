// All cache keys are namespaced under "mx:" to avoid collisions with other
// apps on the same Redis instance in non-prod environments.
//
// Tenant-scoped keys include the tenantId so a single Redis instance can
// serve multiple tenants (SOC2: data isolation without separate clusters).

export const CacheKeys = {
  // ServiceContext for an environment:service pair.
  // Invalidated when the context graph is updated.
  contextGraph: (tenantId: string, env: string, service: string) =>
    `mx:${tenantId}:ctx:${env}:${service}`,

  // Classifier response keyed by a sha256 fingerprint of the evidence set.
  // Safe to cache because the same evidence always produces the same
  // classification — new evidence = new fingerprint = cache miss.
  classifierResponse: (evidenceHash: string) =>
    `mx:clf:${evidenceHash}`,

  // Calibration snapshot for a tenant + incident type (summary stats).
  calibration: (tenantId: string, incidentType: string) =>
    `mx:${tenantId}:cal:${incidentType}`,

  // JWT revocation set (sorted set keyed by jti, score = expiry unix ts).
  // Used to invalidate tokens on logout before they naturally expire.
  jwtRevoked: (tenantId: string) =>
    `mx:${tenantId}:jwt:revoked`,
} as const;

export const TTL = {
  contextGraph: 300,        // 5 min — refresh on context graph upsert
  classifierResponse: 1800, // 30 min — evidence fingerprint is deterministic
  calibration: 3_600,       // 1 h — updated by weekly calibration job
  jwtRevoked: 86_400,       // 24 h — matches JWT max expiry
} as const;
