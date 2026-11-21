-- =====================================================================
-- Warehouse Inventory Management System: PostgreSQL schema
--   createdb warehouse_db && psql -d warehouse_db -f init.sql
-- Postgres DDL is transactional: the whole script is one atomic unit.
-- =====================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- 1. CORE TABLES
-- ---------------------------------------------------------------------
CREATE TABLE products (
    product_id        INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name              TEXT          NOT NULL,
    sku               TEXT          NOT NULL UNIQUE,
    price             NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    reorder_threshold INT           NOT NULL DEFAULT 10 CHECK (reorder_threshold >= 0)
);

CREATE TABLE warehouses (
    warehouse_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         TEXT NOT NULL,
    location     TEXT NOT NULL
);

CREATE TABLE bins (
    bin_id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    warehouse_id INT  NOT NULL REFERENCES warehouses(warehouse_id) ON DELETE RESTRICT,
    aisle        TEXT NOT NULL,
    -- Human-readable code (e.g. 'A-03-12'). Globally unique because the API
    -- exposes it as the bin identifier.
    bin_code     TEXT NOT NULL UNIQUE,
    capacity     INT  NOT NULL CHECK (capacity > 0)
);

-- Inventory = CURRENT STATE (product x bin -> quantity).
-- The ledger below is the HISTORY. The fulfillment transaction updates both atomically.
CREATE TABLE inventory (
    product_id INT NOT NULL REFERENCES products(product_id) ON DELETE RESTRICT,
    bin_id     INT NOT NULL REFERENCES bins(bin_id)         ON DELETE RESTRICT,
    quantity   INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, bin_id),
    -- Negative stock is mathematically impossible, even through a manual UPDATE in psql.
    CONSTRAINT chk_inventory_quantity_non_negative CHECK (quantity >= 0)
);
CREATE INDEX idx_inventory_bin ON inventory (bin_id);

CREATE TABLE orders (
    -- Starts at 1001 so the API can expose 'ORD-1001'.
    order_id      INT GENERATED ALWAYS AS IDENTITY (START WITH 1001) PRIMARY KEY,
    customer_name TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'Pending'
                  CHECK (status IN ('Pending', 'Fulfilled', 'Cancelled')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    fulfilled_at  TIMESTAMPTZ,
    -- Status and timestamp can never disagree.
    CONSTRAINT chk_orders_fulfilled_at
        CHECK ((status = 'Fulfilled') = (fulfilled_at IS NOT NULL))
);

CREATE TABLE order_items (
    order_item_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id      INT NOT NULL REFERENCES orders(order_id)     ON DELETE CASCADE,
    product_id    INT NOT NULL REFERENCES products(product_id) ON DELETE RESTRICT,
    quantity      INT NOT NULL CHECK (quantity > 0),
    UNIQUE (order_id, product_id)
);

-- ---------------------------------------------------------------------
-- 2. THE LEDGER: immutable, append-only
-- ---------------------------------------------------------------------
CREATE TABLE inventory_transactions (
    transaction_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id      INT  NOT NULL REFERENCES products(product_id),
    bin_id          INT  NOT NULL REFERENCES bins(bin_id),
    order_id        INT  REFERENCES orders(order_id),            -- NULL for restock/damage
    txn_type        TEXT NOT NULL
                    CHECK (txn_type IN ('PICK', 'RESTOCK', 'DAMAGE', 'ADJUSTMENT')),
    quantity_change INT  NOT NULL CHECK (quantity_change <> 0),  -- negative = stock out
    quantity_after  INT  NOT NULL CHECK (quantity_after >= 0),   -- bin balance after the movement
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_txn_direction CHECK (
           (txn_type IN ('PICK', 'DAMAGE') AND quantity_change < 0)
        OR (txn_type = 'RESTOCK'           AND quantity_change > 0)
        OR  txn_type = 'ADJUSTMENT'
    )
);
CREATE INDEX idx_txn_created_at   ON inventory_transactions (created_at DESC);
CREATE INDEX idx_txn_product_time ON inventory_transactions (product_id, created_at DESC);

-- Immutability enforced by the DATABASE, not by application discipline.
-- (In production also connect the app as a role with only SELECT/INSERT here,
--  so the trigger cannot simply be dropped.)
CREATE FUNCTION fn_ledger_is_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'inventory_transactions is append-only: % is not allowed', TG_OP
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_no_update_delete
    BEFORE UPDATE OR DELETE ON inventory_transactions
    FOR EACH ROW EXECUTE FUNCTION fn_ledger_is_append_only();

CREATE TRIGGER trg_ledger_no_truncate
    BEFORE TRUNCATE ON inventory_transactions
    FOR EACH STATEMENT EXECUTE FUNCTION fn_ledger_is_append_only();

-- ---------------------------------------------------------------------
-- 3. RESTOCK ALERTS + TRIGGER (per product x bin)
-- ---------------------------------------------------------------------
CREATE TABLE restock_alerts (
    alert_id          INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id        INT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
    bin_id            INT NOT NULL REFERENCES bins(bin_id)         ON DELETE CASCADE,
    current_quantity  INT NOT NULL,
    reorder_threshold INT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at       TIMESTAMPTZ
);

-- At most ONE open alert per (product, bin). The database de-duplicates alerts.
CREATE UNIQUE INDEX uq_restock_alerts_one_open_per_stock_row
    ON restock_alerts (product_id, bin_id) WHERE status = 'OPEN';

CREATE FUNCTION fn_check_reorder_threshold() RETURNS trigger AS $$
DECLARE
    v_threshold INT;
BEGIN
    SELECT reorder_threshold INTO v_threshold
      FROM products WHERE product_id = NEW.product_id;

    IF NEW.quantity < v_threshold THEN
        -- No explicit locking needed: the UPDATE that fired this trigger already
        -- holds the row lock on this (product, bin), so concurrent writers to the
        -- same stock row are serialized until we commit.
        INSERT INTO restock_alerts (product_id, bin_id, current_quantity, reorder_threshold)
        VALUES (NEW.product_id, NEW.bin_id, NEW.quantity, v_threshold)
        ON CONFLICT (product_id, bin_id) WHERE status = 'OPEN'
        DO UPDATE SET current_quantity  = EXCLUDED.current_quantity,
                      reorder_threshold = EXCLUDED.reorder_threshold;
    ELSE
        -- Stock recovered: auto-resolve any open alert for this bin.
        UPDATE restock_alerts
           SET status = 'RESOLVED', resolved_at = now()
         WHERE product_id = NEW.product_id AND bin_id = NEW.bin_id AND status = 'OPEN';
    END IF;

    RETURN NULL;  -- ignored for AFTER triggers
END;
$$ LANGUAGE plpgsql;

-- Runs inside the SAME transaction as the stock change: if fulfillment rolls
-- back, the alert rolls back with it.
CREATE TRIGGER trg_inventory_reorder_check
    AFTER INSERT OR UPDATE OF quantity ON inventory
    FOR EACH ROW EXECUTE FUNCTION fn_check_reorder_threshold();

-- ---------------------------------------------------------------------
-- 4. SEED DATA (optional; matches the frontend mock SKUs/bins)
-- ---------------------------------------------------------------------
INSERT INTO products (name, sku, price, reorder_threshold) VALUES
    ('Steel Shelf Bracket',      'WH-AX-1001',  14.90, 30),
    ('Hex Nut M8 (100pk)',       'WH-AX-1002',   6.25, 30),
    ('Hex Bolt M8 (100pk)',      'WH-AX-1003',   8.40, 50),
    ('Barcode Labels 4x6',       'WH-BR-2040',  19.99, 40),
    ('Cable Ties 300mm',         'WH-CK-3310',   4.75, 60),
    ('Pallet Wrap 500mm',        'WH-DL-4107',  11.30, 25),
    ('Safety Gloves (Box)',      'WH-EV-5521',  24.75, 20);

INSERT INTO warehouses (name, location) VALUES
    ('Main DC',  'Delhi, IN'),
    ('Port Hub', 'Mumbai, IN');

INSERT INTO bins (warehouse_id, aisle, bin_code, capacity)
SELECT w.warehouse_id, v.aisle, v.bin_code, 500
FROM (VALUES ('Main DC',  'A', 'A-01-04'),
             ('Main DC',  'A', 'A-03-12'),
             ('Main DC',  'B', 'B-02-07'),
             ('Port Hub', 'C', 'C-05-01'),
             ('Port Hub', 'D', 'D-04-09')) AS v(wh, aisle, bin_code)
JOIN warehouses w ON w.name = v.wh;

-- Several rows start below threshold, so the trigger creates alerts at seed time.
INSERT INTO inventory (product_id, bin_id, quantity)
SELECT p.product_id, b.bin_id, v.qty
FROM (VALUES ('WH-AX-1001', 'A-01-04', 120), ('WH-AX-1001', 'B-02-07', 60),
             ('WH-AX-1002', 'A-01-04',  90),
             ('WH-AX-1003', 'A-03-12',   4),
             ('WH-BR-2040', 'B-02-07',  31),
             ('WH-CK-3310', 'C-05-01',  18),
             ('WH-DL-4107', 'D-04-09',   9),
             ('WH-EV-5521', 'D-04-09',  75), ('WH-EV-5521', 'C-05-01', 40))
      AS v(sku, bin_code, qty)
JOIN products p ON p.sku = v.sku
JOIN bins b     ON b.bin_code = v.bin_code;

-- Orders get IDs 1001, 1002, 1003 on a fresh database.
INSERT INTO orders (customer_name) VALUES ('Acme Logistics'), ('Globex Corp'), ('Initech');

INSERT INTO order_items (order_id, product_id, quantity)
SELECT v.order_id, p.product_id, v.qty
FROM (VALUES (1001, 'WH-AX-1001', 10),   -- ORD-1001: succeeds (17 units total)
             (1001, 'WH-AX-1002',  7),
             (1002, 'WH-AX-1003', 40),   -- ORD-1002: only 4 in stock, so 422 + rollback
             (1003, 'WH-EV-5521', 60))   -- ORD-1003: succeeds AND trips the reorder trigger (75→15 < 20)
      AS v(order_id, sku, qty)
JOIN products p ON p.sku = v.sku;

-- Synthetic history for the trends chart (quantity_after is illustrative here).
INSERT INTO inventory_transactions
       (product_id, bin_id, txn_type, quantity_change, quantity_after, created_at)
SELECT i.product_id, i.bin_id, 'PICK',
       -(1 + floor(random() * 15))::int,
       i.quantity,
       now() - make_interval(days => g.d) - make_interval(hours => (random() * 10)::int)
FROM generate_series(1, 90) AS g(d)
CROSS JOIN inventory i;

INSERT INTO inventory_transactions
       (product_id, bin_id, txn_type, quantity_change, quantity_after, created_at)
SELECT i.product_id, i.bin_id, 'RESTOCK', 40, i.quantity,
       now() - make_interval(days => g.d)
FROM generate_series(3, 90, 7) AS g(d)
CROSS JOIN inventory i;

-- ---------------------------------------------------------------------
-- 5. MATERIALIZED VIEW: Daily_Stock_Trends (rolling 90 days; API slices ?days=)
-- ---------------------------------------------------------------------
-- generate_series guarantees a row for EVERY day (zeros on quiet days), so the
-- Recharts line never has gaps.
CREATE MATERIALIZED VIEW daily_stock_trends AS
WITH days AS (
    SELECT ((now() AT TIME ZONE 'UTC')::date - g) AS trend_date
    FROM generate_series(0, 89) AS g
),
daily AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date                      AS d,
           SUM(-quantity_change) FILTER (WHERE quantity_change < 0)   AS depleted,
           SUM( quantity_change) FILTER (WHERE quantity_change > 0)   AS restocked,
           COUNT(*)                                                   AS txn_count
    FROM inventory_transactions
    WHERE created_at >= now() - interval '91 days'
    GROUP BY 1
)
SELECT days.trend_date,
       COALESCE(daily.depleted,  0)::int AS units_depleted,
       COALESCE(daily.restocked, 0)::int AS units_restocked,
       COALESCE(daily.txn_count, 0)::int AS transaction_count
FROM days
LEFT JOIN daily ON daily.d = days.trend_date;

-- UNIQUE index required for REFRESH ... CONCURRENTLY (reads never blocked).
CREATE UNIQUE INDEX uq_daily_stock_trends_date ON daily_stock_trends (trend_date);

COMMIT;