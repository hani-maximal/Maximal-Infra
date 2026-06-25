CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY,
  type text NOT NULL,
  service text NOT NULL,
  environment text NOT NULL,
  source text NOT NULL,
  confidence numeric(4, 3) NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_records (
  sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  incident_id uuid NOT NULL REFERENCES incidents(id),
  ts timestamptz NOT NULL,
  actor text NOT NULL,
  actor_id text,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  prev_hash text NOT NULL,
  hash text NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS audit_records_incident_timeline
  ON audit_records (incident_id, sequence_id);

CREATE OR REPLACE FUNCTION maximal_reject_audit_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_records is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_records_no_update ON audit_records;
CREATE TRIGGER audit_records_no_update
BEFORE UPDATE OR DELETE ON audit_records
FOR EACH ROW EXECUTE FUNCTION maximal_reject_audit_mutation();
