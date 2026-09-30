BEGIN;

CREATE TABLE shopify_webhook_events (
  webhook_id text PRIMARY KEY,
  topic text NOT NULL,
  order_gid text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shopify_orders (
  order_gid text PRIMARY KEY,
  order_name text NOT NULL,
  last_topic text NOT NULL,
  financial_status text,
  fulfillment_status text,
  cancelled_at timestamptz,
  order_updated_at timestamptz,
  review_status text NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','reviewed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shopify_order_items (
  order_gid text NOT NULL REFERENCES shopify_orders(order_gid),
  line_item_id text NOT NULL,
  sku text,
  variant_id uuid REFERENCES variants(id),
  quantity integer NOT NULL CHECK(quantity >= 0),
  PRIMARY KEY(order_gid,line_item_id)
);

COMMIT;
