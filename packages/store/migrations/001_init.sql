-- Week 4: update log, replay high-water marks, snapshot metadata.
-- The log is append-only. Week 6 adds hash-chain columns and makes it the ledger.

CREATE TABLE documents (
  id         text PRIMARY KEY,
  head_seq   bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_updates (
  document_id text   NOT NULL REFERENCES documents(id),
  seq         bigint NOT NULL,
  key_id      bytea  NOT NULL,
  session_id  bigint NOT NULL,
  client_seq  bigint NOT NULL,
  frame       bytea  NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, seq),
  UNIQUE (document_id, key_id, session_id, client_seq)
);

CREATE TABLE update_sessions (
  document_id text   NOT NULL REFERENCES documents(id),
  key_id      bytea  NOT NULL,
  session_id  bigint NOT NULL,
  last_seq    bigint NOT NULL,
  PRIMARY KEY (document_id, key_id, session_id)
);

CREATE TABLE snapshots (
  document_id  text   NOT NULL REFERENCES documents(id),
  version      int    NOT NULL,
  object_key   text   NOT NULL,
  sha256       bytea  NOT NULL,
  up_to_seq    bigint NOT NULL,
  state_vector bytea  NOT NULL,
  size_bytes   int    NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, version)
);

-- The log must never change after the fact. Enforced in the database, not just in code.
CREATE FUNCTION forbid_log_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document_updates is append-only';
END $$;

CREATE TRIGGER document_updates_append_only
  BEFORE UPDATE OR DELETE ON document_updates
  FOR EACH ROW EXECUTE FUNCTION forbid_log_mutation();
