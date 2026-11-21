// ─────────────────────────────────────────────────────────────
// REAL API LAYER: keep this part
// ─────────────────────────────────────────────────────────────
const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
export const USE_MOCK = false; // ← delete this + the MOCK section below when the backend is live

export class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;   // HTTP status (0 = network failure)
    this.code = code;       // e.g. LOCK_CONTENTION, INSUFFICIENT_STOCK
    this.details = details;
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the API server.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      body?.code ?? `HTTP_${res.status}`,
      body?.message ?? res.statusText,
      body
    );
  }
  return body;
}

/**
 * CONTRACT
 * GET  /api/inventory/trends?days=30 → [{ date, depleted, restocked }]
 * GET  /api/alerts                   → [{ alert_id, sku, product_name, bin_id, current_qty, reorder_threshold, created_at }]
 * POST /api/orders/fulfill {order_id}→ { order_id, status, items_picked, transaction_ids: [] }
 *      errors: 404 NOT_FOUND | 409 LOCK_CONTENTION | 422 INSUFFICIENT_STOCK  → { code, message }
 * GET  /api/transactions?page=&limit=→ { data: [{ transaction_id, sku, bin_id, quantity_change, reason, created_at }],
 *                                        page, total_pages, total }
 */
export const getTrends = (days = 30) =>
  USE_MOCK ? mock.trends(days) : request(`/api/inventory/trends?days=${days}`);

export const getAlerts = () =>
  USE_MOCK ? mock.alerts() : request('/api/alerts');

export const fulfillOrder = (orderId) =>
  USE_MOCK
    ? mock.fulfill(orderId)
    : request('/api/orders/fulfill', {
        method: 'POST',
        body: JSON.stringify({ order_id: orderId }),
      });

export const getTransactions = (page = 1, limit = 15) =>
  USE_MOCK
    ? mock.transactions(page, limit)
    : request(`/api/transactions?page=${page}&limit=${limit}`);

// ─────────────────────────────────────────────────────────────
// MOCK SECTION: delete everything below (and USE_MOCK above)
// ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SKUS = ['WH-AX-1001', 'WH-AX-1002', 'WH-BR-2040', 'WH-CK-3310', 'WH-DL-4107', 'WH-EV-5521'];
const BINS = ['A-01-04', 'A-03-12', 'B-02-07', 'C-05-01', 'D-04-09'];
const REASONS = ['PICK', 'PICK', 'RESTOCK', 'PICK', 'DAMAGE'];

const LEDGER = Array.from({ length: 137 }, (_, i) => {
  const reason = REASONS[i % 5];
  const quantity_change =
    reason === 'PICK' ? -(1 + ((i * 3) % 12))
    : reason === 'RESTOCK' ? 20 + ((i * 7) % 80)
    : -(1 + (i % 3));
  return {
    transaction_id: `TXN-${48137 - i}`,
    sku: SKUS[(i * 5) % SKUS.length],
    bin_id: BINS[(i * 3) % BINS.length],
    quantity_change,
    reason,
    created_at: new Date(Date.now() - i * 37 * 60_000).toISOString(),
  };
});

const mock = {
  async trends(days) {
    await sleep(500);
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(Date.now() - (days - 1 - i) * 864e5);
      return {
        date: d.toISOString().slice(0, 10),
        depleted: Math.round(300 + 120 * Math.sin(i / 4) + i * 6 + ((i * 37) % 41)),
        restocked: Math.round(180 + 90 * Math.cos(i / 5) + ((i * 53) % 37)),
      };
    });
  },

  async alerts() {
    await sleep(400);
    return [
      { alert_id: 9012, sku: 'WH-AX-1003', product_name: 'Hex Bolt M8 (100pk)', bin_id: 'A-03-12', current_qty: 4, reorder_threshold: 50, created_at: new Date(Date.now() - 12 * 60_000).toISOString() },
      { alert_id: 9011, sku: 'WH-CK-3310', product_name: 'Cable Ties 300mm', bin_id: 'C-05-01', current_qty: 18, reorder_threshold: 60, created_at: new Date(Date.now() - 95 * 60_000).toISOString() },
      { alert_id: 9009, sku: 'WH-DL-4107', product_name: 'Pallet Wrap 500mm', bin_id: 'D-04-09', current_qty: 9, reorder_threshold: 25, created_at: new Date(Date.now() - 4 * 3600_000).toISOString() },
      { alert_id: 9004, sku: 'WH-BR-2040', product_name: 'Barcode Labels 4x6', bin_id: 'B-02-07', current_qty: 31, reorder_threshold: 40, created_at: new Date(Date.now() - 9 * 3600_000).toISOString() },
    ];
  },

  // Try: ORD-1001 (ok) · ORD-1002 (422) · ORD-1003 (409) · anything else (404)
  async fulfill(orderId) {
    await sleep(1600);
    const id = orderId.trim().toUpperCase();
    if (id === 'ORD-1002')
      throw new ApiError(422, 'INSUFFICIENT_STOCK', 'Insufficient stock for WH-AX-1003 (requested 40, available 4). Rollback executed.');
    if (id === 'ORD-1003')
      throw new ApiError(409, 'LOCK_CONTENTION', 'Row lock on bin A-03-12 held by another worker. Retry.');
    if (!/^ORD-\d+$/.test(id) || id === 'ORD-0000')
      throw new ApiError(404, 'NOT_FOUND', `Order ${id} does not exist.`);
    return {
      order_id: id,
      status: 'FULFILLED',
      items_picked: 17,
      transaction_ids: ['TXN-48138', 'TXN-48139', 'TXN-48140'],
    };
  },

  async transactions(page, limit) {
    await sleep(350);
    const start = (page - 1) * limit;
    return {
      data: LEDGER.slice(start, start + limit),
      page,
      total_pages: Math.ceil(LEDGER.length / limit),
      total: LEDGER.length,
    };
  },
};