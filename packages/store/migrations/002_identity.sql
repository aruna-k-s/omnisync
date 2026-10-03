-- Week 5: principals, certificates, document access lists, audit trail.
-- The audit trail is append-only like the update log. Certificates change only by being revoked.

CREATE TABLE principals (
  id           text PRIMARY KEY,
  oidc_issuer  text NOT NULL,
  oidc_subject text NOT NULL,
  email        text NOT NULL,
  display_name text NOT NULL,
  org_role     text NOT NULL CHECK (org_role IN ('member', 'admin')),
  disabled_at  bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (oidc_issuer, oidc_subject)
);

CREATE TABLE certificates (
  serial        bytea PRIMARY KEY CHECK (length(serial) = 16),
  principal_id  text   NOT NULL REFERENCES principals(id),
  key_id        bytea  NOT NULL CHECK (length(key_id) = 8),
  public_key    bytea  NOT NULL CHECK (length(public_key) = 32),
  issued_at     bigint NOT NULL,
  not_before    bigint NOT NULL,
  not_after     bigint NOT NULL,
  revoked_at    bigint,
  revoke_reason text
);
CREATE INDEX certificates_principal ON certificates (principal_id);

CREATE TABLE document_grants (
  document_id  text NOT NULL,
  principal_id text NOT NULL REFERENCES principals(id),
  role         text NOT NULL CHECK (role IN ('read', 'write', 'merge', 'admin')),
  granted_by   text NOT NULL,
  granted_at   bigint NOT NULL,
  PRIMARY KEY (document_id, principal_id)
);
CREATE INDEX document_grants_principal ON document_grants (principal_id);

CREATE TABLE audit_events (
  id      bigserial PRIMARY KEY,
  at      bigint NOT NULL,
  actor   text   NOT NULL,
  action  text   NOT NULL,
  target  text   NOT NULL,
  detail  text   NOT NULL DEFAULT ''
);

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_log_mutation();

-- Which certificate signed each stored update. Nullable: rows written before identity existed.
ALTER TABLE document_updates ADD COLUMN cert_serial bytea;
