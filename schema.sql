BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE location_kind AS ENUM ('warehouse', 'branch');
CREATE TYPE user_role AS ENUM ('admin', 'branch_manager', 'cashier', 'stock_manager');
CREATE TYPE operation_kind AS ENUM ('opening', 'receipt', 'sale', 'refund', 'transfer_out', 'transfer_in', 'adjustment');

CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  kind location_kind NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role user_role NOT NULL,
  active boolean NOT NULL DEFAULT true,
  session_version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_locations (
  user_id uuid NOT NULL REFERENCES users(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  PRIMARY KEY (user_id, location_id)
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  brand text,
  category text,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  sku text NOT NULL UNIQUE,
  size text NOT NULL,
  color text NOT NULL,
  sale_price numeric(14,2) NOT NULL CHECK (sale_price >= 0),
  cost numeric(14,2) CHECK (cost >= 0),
  UNIQUE (product_id, size, color)
);

CREATE TABLE stock_balances (
  location_id uuid NOT NULL REFERENCES locations(id),
  variant_id uuid NOT NULL REFERENCES variants(id),
  quantity integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, variant_id)
);

CREATE TABLE operations (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  request_hash text NOT NULL,
  location_id uuid NOT NULL REFERENCES locations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  device_id uuid,
  client_created_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  result jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  session_version integer NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id ON sessions(user_id);

CREATE TABLE sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL UNIQUE REFERENCES operations(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  cashier_id uuid NOT NULL REFERENCES users(id),
  total numeric(14,2) NOT NULL CHECK (total >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sale_items (
  sale_id uuid NOT NULL REFERENCES sales(id),
  variant_id uuid NOT NULL REFERENCES variants(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  PRIMARY KEY (sale_id, variant_id)
);

CREATE TABLE stock_movements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES operations(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  variant_id uuid NOT NULL REFERENCES variants(id),
  kind operation_kind NOT NULL,
  delta integer NOT NULL CHECK (delta <> 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, location_id, variant_id, kind)
);

CREATE TABLE transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL UNIQUE REFERENCES operations(id),
  source_id uuid NOT NULL REFERENCES locations(id),
  destination_id uuid NOT NULL REFERENCES locations(id),
  variant_id uuid NOT NULL REFERENCES variants(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  requested_by uuid NOT NULL REFERENCES users(id),
  completed_at timestamptz,
  CHECK (source_id <> destination_id)
);

CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  location_id uuid REFERENCES locations(id),
  action text NOT NULL,
  target_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stock_movements_location_time ON stock_movements(location_id, created_at DESC);
CREATE INDEX sales_location_time ON sales(location_id, created_at DESC);
CREATE INDEX audit_logs_actor_time ON audit_logs(actor_id, created_at DESC);

COMMIT;
