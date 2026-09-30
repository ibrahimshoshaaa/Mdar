BEGIN;

CREATE TABLE cashier_devices (
  location_id uuid PRIMARY KEY REFERENCES locations(id),
  device_hash text NOT NULL,
  cashier_id uuid NOT NULL REFERENCES users(id),
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sessions ADD COLUMN device_hash text;

COMMIT;
