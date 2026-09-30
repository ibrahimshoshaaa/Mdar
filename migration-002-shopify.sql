BEGIN;

CREATE TABLE shopify_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  warehouse_location_id uuid NOT NULL REFERENCES locations(id),
  shopify_location_gid text NOT NULL CHECK (shopify_location_gid ~ '^gid://shopify/Location/[0-9]+$'),
  sync_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shopify_variant_links (
  variant_id uuid PRIMARY KEY REFERENCES variants(id),
  inventory_item_gid text NOT NULL UNIQUE CHECK (inventory_item_gid ~ '^gid://shopify/InventoryItem/[0-9]+$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shopify_sync_queue (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_id uuid NOT NULL REFERENCES variants(id),
  balance_version bigint NOT NULL,
  desired_quantity integer NOT NULL CHECK (desired_quantity >= 0),
  delta integer NOT NULL CHECK (delta <> 0),
  idempotency_key uuid NOT NULL DEFAULT gen_random_uuid(),
  change_from_quantity integer,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','synced','conflict')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variant_id,balance_version)
);
CREATE INDEX shopify_sync_pending ON shopify_sync_queue(status,created_at);

CREATE FUNCTION enqueue_shopify_warehouse_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_delta integer;
BEGIN
  IF current_setting('app.skip_shopify_queue',true) = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN v_delta:=NEW.quantity; ELSE v_delta:=NEW.quantity-OLD.quantity; END IF;
  IF EXISTS (
    SELECT 1 FROM shopify_settings s
    JOIN shopify_variant_links l ON l.variant_id=NEW.variant_id
    WHERE s.warehouse_location_id=NEW.location_id
  ) THEN
    IF v_delta <> 0 THEN
      INSERT INTO shopify_sync_queue(variant_id,balance_version,desired_quantity,delta)
      VALUES(NEW.variant_id,NEW.version,NEW.quantity,v_delta)
      ON CONFLICT(variant_id,balance_version) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER shopify_warehouse_stock_queue
AFTER INSERT OR UPDATE OF quantity ON stock_balances
FOR EACH ROW EXECUTE FUNCTION enqueue_shopify_warehouse_change();

COMMIT;
