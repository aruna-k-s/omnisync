-- Week 6: the update log becomes a hash-chained ledger (docs/specs/ledger.md).
-- Chain columns are set in the append transaction, under the document row lock.
-- Checkpoints are signed statements over document heads; they are append-only too.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM document_updates) THEN
    RAISE EXCEPTION 'migration 003 cannot chain rows written before the ledger existed; export and reset a pre-release database';
  END IF;
END $$;

ALTER TABLE documents
  ADD COLUMN head_hash      bytea  NOT NULL DEFAULT '\x0000000000000000000000000000000000000000000000000000000000000000'
    CHECK (length(head_hash) = 32),
  ADD COLUMN checkpoint_seq bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT documents_checkpoint_within_head CHECK (checkpoint_seq <= head_seq);

ALTER TABLE document_updates
  ADD COLUMN received_at_ms bigint NOT NULL,
  ADD COLUMN key_epoch      int    NOT NULL DEFAULT 0 CHECK (key_epoch >= 0),
  ADD COLUMN prev_hash      bytea  NOT NULL CHECK (length(prev_hash) = 32),
  ADD COLUMN entry_hash     bytea  NOT NULL CHECK (length(entry_hash) = 32),
  ADD COLUMN frame_hash     bytea  NOT NULL CHECK (length(frame_hash) = 32),
  ADD COLUMN payload_hash   bytea  NOT NULL CHECK (length(payload_hash) = 32);

CREATE TABLE ledger_checkpoints (
  n               bigint PRIMARY KEY CHECK (n >= 1),
  created_at_ms   bigint NOT NULL,
  checkpoint_hash bytea  NOT NULL UNIQUE CHECK (length(checkpoint_hash) = 32),
  bytes           bytea  NOT NULL
);

CREATE TRIGGER ledger_checkpoints_append_only
  BEFORE UPDATE OR DELETE ON ledger_checkpoints
  FOR EACH ROW EXECUTE FUNCTION forbid_log_mutation();

-- Kept apart so ledger_checkpoints itself can be fully append-only.
CREATE TABLE ledger_checkpoint_uploads (
  n              bigint PRIMARY KEY REFERENCES ledger_checkpoints(n),
  uploaded_at_ms bigint NOT NULL
);

-- Which certificate bytes vouched for each entry; the verifier needs the signed bytes, not just the fields.
ALTER TABLE certificates ADD COLUMN certificate bytea;

CREATE TABLE document_registry (
  id            text PRIMARY KEY,
  created_by    text   NOT NULL,
  created_at_ms bigint NOT NULL
);
