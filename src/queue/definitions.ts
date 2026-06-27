// Typed job payloads for every BullMQ queue.
// Keep these minimal — workers load full data from Postgres using the IDs.

export interface OutcomeWriterJob {
  tenantId: string;
  incidentId: string;
}

export interface CalibrationJob {
  tenantId: string;
}

export interface ContractLearnerJob {
  tenantId: string;
  incidentId: string;
}

export interface BaselineLearnJob {
  tenantId: string;
  service: string;
  environment: string;
}
