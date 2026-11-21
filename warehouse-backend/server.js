// =====================================================================
// server.js: Warehouse Inventory API (Express + node-postgres, raw SQL)
// No ORM by design: every query, lock and transaction boundary is explicit.
// =====================================================================
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pg from 'pg';

const { Pool } = pg;

// Transactions are per-CONNECTION: every statement of one transaction must go
// through the SAME client from pool.connect(), never through pool.query().
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
pool.on('error', (err) => console.error('Idle client error:', err));

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173' })); // Vite dev server
app.use(express.json());

// ---------------------------------------------------------------------
// Error model. Matches apiService.js: body = { code, message, details }
// ---------------------------------------------------------------------
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Translate raw PostgreSQL SQLSTATE codes into the frontend's error codes.
function toAppError(err) {
  if (err instanceof AppError) return err;
  switch (err.code) {
    case '55P03': // lock_not_available: lock_timeout expired waiting for a row lock
      return new AppError(409, 'LOCK_CONTENTION', 'Row lock held by another worker. Retry.');
    case '40P01': // deadlock_detected: Postgres killed this txn to break a lock cycle
      return new AppError(409, 'LOCK_CONTENTION', 'Deadlock detected between workers. Retry.');
    case '23514': // check_violation, e.g. quantity >= 0 (last line of defence)
      return new AppError(422, 'CONSTRAINT_VIOLATION',
        'Constraint violation. Rollback executed.', { constraint: err.constraint });
    case '23503': // foreign_key_violation
      return new AppError(422, 'FOREIGN_KEY_VIOLATION',
        'Referential integrity violation. Rollback executed.', { constraint: err.constraint });
    default:
      return new AppError(500, 'INTERNAL_ERROR', 'Internal server error.'); // never leak SQL internals
  }
}

// Express 4 does not catch rejected promises from async handlers on its own.
const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------------------------------------------------------------------
// Materialized view refresh (coalesced, never blocks a request)
// ---------------------------------------------------------------------
let refreshing = false;
let refreshQueued = false;

async function refreshTrends() {
  if (refreshing) { refreshQueued = true; return; }
  refreshing = true;
  try {
    // CONCURRENTLY can't run inside a transaction block, so use pool.query() on its own.
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY daily_stock_trends');
  } catch (err) {
    console.error('Trend refresh failed:', err.message);
  } finally {
    refreshing = false;
    if (refreshQueued) { refreshQueued = false; refreshTrends(); }
  }
}
setInterval(refreshTrends, 5 * 60 * 1000).unref(); // keeps the rolling window sliding

// =====================================================================
// READ ENDPOINTS
// =====================================================================

// GET /api/inventory/trends?days=30 → [{ date, depleted, restocked }]
app.get('/api/inventory/trends', asyncHandler(async (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  const { rows } = await pool.query(`
    SELECT to_char(trend_date, 'YYYY-MM-DD') AS date,
           units_depleted  AS depleted,
           units_restocked AS restocked
    FROM daily_stock_trends
    WHERE trend_date > (now() AT TIME ZONE 'UTC')::date - $1::int
    ORDER BY trend_date ASC
  `, [days]);
  res.json(rows);
}));

// GET /api/alerts → [{ alert_id, sku, product_name, bin_id, current_qty, reorder_threshold, created_at }]
// Alerts are written by trg_inventory_reorder_check. The app never creates them.
app.get('/api/alerts', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT a.alert_id,
           p.sku,
           p.name             AS product_name,
           b.bin_code         AS bin_id,
           a.current_quantity AS current_qty,
           a.reorder_threshold,
           a.created_at
    FROM restock_alerts a
    JOIN products p ON p.product_id = a.product_id
    JOIN bins     b ON b.bin_id     = a.bin_id
    WHERE a.status = 'OPEN'
    ORDER BY a.created_at DESC
  `);
  res.json(rows);
}));

// GET /api/transactions?page=1&limit=15
//   → { data: [{ transaction_id, sku, bin_id, quantity_change, reason, created_at }], page, total_pages, total }
app.get('/api/transactions', asyncHandler(async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 15));
  const offset = (page - 1) * limit;

  const [dataRes, countRes] = await Promise.all([
    pool.query(`
      SELECT 'TXN-' || t.transaction_id AS transaction_id,
             p.sku,
             b.bin_code                 AS bin_id,
             t.quantity_change,
             t.txn_type                 AS reason,
             t.created_at
      FROM inventory_transactions t
      JOIN products p ON p.product_id = t.product_id
      JOIN bins     b ON b.bin_id     = t.bin_id
      ORDER BY t.transaction_id DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]),
    pool.query('SELECT COUNT(*)::int AS total FROM inventory_transactions'),
  ]);

  const total = countRes.rows[0].total;
  res.json({ data: dataRes.rows, page, total_pages: Math.ceil(total / limit), total });
}));

// =====================================================================
// THE CROWN JEWEL: ACID ORDER FULFILLMENT
// =====================================================================
//
//  A - Atomicity   : BEGIN ... COMMIT. Any failure → ROLLBACK, so stock
//                    deduction, ledger rows, trigger-generated alerts and
//                    the order status change either ALL happen or NONE do.
//  C - Consistency : CHECK (quantity >= 0), FKs, and the status/timestamp
//                    constraint reject any state that violates invariants.
//  I - Isolation   : SELECT ... FOR UPDATE locks the order row and the
//                    inventory rows, so concurrent workers are serialized.
//  D - Durability  : once COMMIT returns, the change survives a crash (WAL).
//
async function fulfillOrder(orderId) {
  const client = await pool.connect();   // one dedicated connection = one transaction
  let discardClient = false;

  try {
    // STEP 1: BEGIN. READ COMMITTED (default) is sufficient because we take
    // explicit row locks below.
    await client.query('BEGIN');

    // Don't wait forever for another worker's lock. After 3s Postgres raises
    // 55P03, which becomes HTTP 409 LOCK_CONTENTION. SET LOCAL lasts only for
    // this transaction.
    await client.query(`SET LOCAL lock_timeout = '3s'`);

    // Lock the ORDER row first. If two workers submit the same order, the second
    // blocks here until the first commits, then sees status='Fulfilled' and is
    // rejected, so double-fulfillment is impossible.
    const orderRes = await client.query(
      'SELECT status FROM orders WHERE order_id = $1 FOR UPDATE',
      [orderId]
    );
    if (orderRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', `Order ORD-${orderId} does not exist.`);
    }
    if (orderRes.rows[0].status !== 'Pending') {
      throw new AppError(409, 'ORDER_NOT_PENDING',
        `Order ORD-${orderId} is already ${orderRes.rows[0].status.toUpperCase()}.`);
    }

    // STEP 2: fetch the items this order needs.
    const itemsRes = await client.query(
      `SELECT oi.product_id, p.sku, oi.quantity
       FROM order_items oi
       JOIN products p USING (product_id)
       WHERE oi.order_id = $1
       ORDER BY oi.product_id`,
      [orderId]
    );
    if (itemsRes.rowCount === 0) {
      throw new AppError(422, 'EMPTY_ORDER', `Order ORD-${orderId} has no items. Rollback executed.`);
    }

    // STEP 3: ROW-LEVEL LOCKING.
    //  - ORDER BY product_id, bin_id: every worker locks rows in the SAME global
    //    order, which prevents deadlocks (the classic A→B vs B→A cycle).
    //  - FOR UPDATE OF i: lock only inventory rows, not the joined rows.
    //  - quantity > 0 in WHERE: under READ COMMITTED, if a row we waited on was
    //    drained by another worker, Postgres re-checks the predicate against the
    //    new row version, so we never act on stale stock.
    const productIds = itemsRes.rows.map((r) => r.product_id);
    const stockRes = await client.query(
      `SELECT i.product_id, i.bin_id, i.quantity
       FROM inventory i
       WHERE i.product_id = ANY($1::int[]) AND i.quantity > 0
       ORDER BY i.product_id, i.bin_id
       FOR UPDATE OF i`,
      [productIds]
    );

    // STEP 4: sufficiency check. These rows are locked, so what we read cannot
    // change until COMMIT/ROLLBACK, which makes the allocation safe.
    const binsByProduct = new Map();
    for (const row of stockRes.rows) {
      if (!binsByProduct.has(row.product_id)) binsByProduct.set(row.product_id, []);
      binsByProduct.get(row.product_id).push(row);
    }

    const picks = [];
    const shortages = [];
    for (const item of itemsRes.rows) {
      // Draw from the fullest bins first (fewest picks per item).
      const bins = [...(binsByProduct.get(item.product_id) ?? [])]
        .sort((a, b) => b.quantity - a.quantity || a.bin_id - b.bin_id);

      let remaining = item.quantity;
      for (const bin of bins) {
        if (remaining === 0) break;
        const take = Math.min(bin.quantity, remaining);
        picks.push({ product_id: item.product_id, bin_id: bin.bin_id, take });
        remaining -= take;
      }
      if (remaining > 0) {
        shortages.push({ sku: item.sku, requested: item.quantity, available: item.quantity - remaining });
      }
    }

    if (shortages.length > 0) {
      // Throwing lands in the catch block, which issues the ROLLBACK. One
      // rollback path for every failure keeps the logic airtight.
      const msg = shortages
        .map((s) => `Insufficient stock for ${s.sku} (requested ${s.requested}, available ${s.available})`)
        .join('; ');
      throw new AppError(422, 'INSUFFICIENT_STOCK', `${msg}. Rollback executed.`, { shortages });
    }

    // STEPS 5 + 6: deduct stock and write the audit trail.
    // If a deduction ever went negative, CHECK (quantity >= 0) would raise
    // 23514 here and the whole transaction would roll back.
    const transactionIds = [];
    let itemsPicked = 0;
    for (const pick of picks) {
      const upd = await client.query(
        `UPDATE inventory
            SET quantity = quantity - $1, updated_at = now()
          WHERE product_id = $2 AND bin_id = $3
          RETURNING quantity`,
        [pick.take, pick.product_id, pick.bin_id]
      );
      // The AFTER UPDATE trigger has now run inside this transaction. If this bin
      // fell below the product's reorder_threshold, a restock_alerts row exists,
      // invisible to everyone else until COMMIT.

      const led = await client.query(
        `INSERT INTO inventory_transactions
                (product_id, bin_id, order_id, txn_type, quantity_change, quantity_after)
         VALUES ($1, $2, $3, 'PICK', $4, $5)
         RETURNING 'TXN-' || transaction_id AS transaction_id`,
        [pick.product_id, pick.bin_id, orderId, -pick.take, upd.rows[0].quantity]
      );

      transactionIds.push(led.rows[0].transaction_id);
      itemsPicked += pick.take;
    }

    // STEP 7: mark the order fulfilled (chk_orders_fulfilled_at keeps status
    // and timestamp consistent).
    const doneRes = await client.query(
      `UPDATE orders SET status = 'Fulfilled', fulfilled_at = now()
        WHERE order_id = $1
        RETURNING status`,
      [orderId]
    );

    // STEP 8: COMMIT. This is the point of no return: Durability kicks in and
    // every lock is released.
    await client.query('COMMIT');

    return {
      order_id: `ORD-${orderId}`,
      status: doneRes.rows[0].status.toUpperCase(),   // 'FULFILLED'
      items_picked: itemsPicked,
      transaction_ids: transactionIds,
    };

  } catch (err) {
    // STEP 9: guaranteed ROLLBACK for ANY failure: business rule (422), lock
    // timeout (409), deadlock, constraint violation, or a plain Node.js bug
    // midway through. Undoes the deduction, ledger rows, alerts and status change.
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('ROLLBACK failed, discarding connection:', rollbackErr);
      discardClient = true;   // never return a broken connection to the pool
    }
    throw err;                // the error middleware maps it to an HTTP response
  } finally {
    client.release(discardClient); // release(true) destroys the connection instead of pooling it
  }
}

// POST /api/orders/fulfill   body: { "order_id": "ORD-1001" }  (a bare number also works)
app.post('/api/orders/fulfill', asyncHandler(async (req, res) => {
  const raw = String(req.body?.order_id ?? '').trim().toUpperCase();
  if (!raw) throw new AppError(400, 'BAD_REQUEST', 'order_id is required.');

  // Same behaviour as the mock: anything that isn't a valid order ref is a 404.
  const match = /^(?:ORD-)?(\d{1,9})$/.exec(raw);   // ≤9 digits fits in a Postgres INT
  if (!match) throw new AppError(404, 'NOT_FOUND', `Order ${raw} does not exist.`);

  const result = await fulfillOrder(parseInt(match[1], 10));

  refreshTrends(); // fire-and-forget, only AFTER commit, so analytics never see uncommitted data
  res.status(200).json(result);
}));

// =====================================================================
// Centralized error middleware → { code, message, details }
// =====================================================================
app.use((err, req, res, _next) => {
  const appErr = toAppError(err);
  if (appErr.status >= 500) console.error(err);
  res.status(appErr.status).json({
    code: appErr.code,
    message: appErr.message,
    details: appErr.details ?? null,
  });
});

// ---------------------------------------------------------------------
// Boot + graceful shutdown (let in-flight transactions finish)
// ---------------------------------------------------------------------
const PORT = process.env.PORT ?? 3000;  // matches the frontend's default BASE_URL
const server = app.listen(PORT, () => console.log(`Warehouse API listening on :${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(async () => { await pool.end(); process.exit(0); });
  });
}