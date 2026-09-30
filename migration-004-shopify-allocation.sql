-- PostgreSQL requires a new enum value to be committed before it can be used.
ALTER TYPE operation_kind ADD VALUE IF NOT EXISTS 'shopify_sale';

BEGIN;
CREATE TABLE shopify_order_allocations (
  order_gid text PRIMARY KEY REFERENCES shopify_orders(order_gid),
  operation_id uuid NOT NULL UNIQUE REFERENCES operations(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  allocated_by uuid NOT NULL REFERENCES users(id),
  allocated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
