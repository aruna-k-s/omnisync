-- Week 8d: pending device-code logins (docs/specs/device-login.md).
-- Only the SHA-256 of the secret device code is stored, so reading the table does not let anyone poll as the device.
-- Rows are short-lived (10 minutes) and are deleted when handed over or expired; this is working state, not a log.

CREATE TABLE device_auths (
  device_hash  bytea  PRIMARY KEY CHECK (length(device_hash) = 32),
  user_code    text   NOT NULL UNIQUE CHECK (user_code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{8}$'),
  label        text   NOT NULL CHECK (length(label) <= 64),
  created_at   bigint NOT NULL,
  expires_at   bigint NOT NULL,
  status       text   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  principal_id text   REFERENCES principals(id),
  last_poll_at bigint,
  CHECK ((status = 'approved') = (principal_id IS NOT NULL))
);
CREATE INDEX device_auths_expiry ON device_auths (expires_at);
