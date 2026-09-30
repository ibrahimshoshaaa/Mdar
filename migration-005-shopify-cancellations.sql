ALTER TYPE operation_kind ADD VALUE IF NOT EXISTS 'shopify_return';

BEGIN;
CREATE TABLE shopify_order_returns (
  order_gid text PRIMARY KEY REFERENCES shopify_orders(order_gid),
  operation_id uuid NOT NULL UNIQUE REFERENCES operations(id),
  returned_by uuid NOT NULL REFERENCES users(id),
  returned_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
