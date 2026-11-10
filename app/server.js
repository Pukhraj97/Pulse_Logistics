const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const initSqlJs = require('sql.js');

const port = Number(process.env.PORT || 4174);
const publicDirectory = path.join(__dirname, 'public');
const bottleRates = { pet: 0.25, beer: 0.08, water: 0.15, can: 0.25 };
const orderIdPattern = /^(?:[0-9]{4}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const pickupSlots = new Set([
  '10:00-11:00', '11:00-12:00', '12:00-13:00', '13:00-14:00', '14:00-15:00',
  '15:00-16:00', '16:00-17:00', '17:00-18:00', '18:00-19:00',
]);

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class LocalSqlitePool {
  constructor() {
    this.filePath = path.resolve(process.env.PULSE_DB_PATH || path.join(__dirname, 'data', 'pickup-orders.sqlite'));
    this.database = null;
    this.inTransaction = false;
    this.queue = Promise.resolve();
    this.ready = this.initialize();
  }

  async initialize() {
    const SQL = await initSqlJs({
      locateFile: (fileName) => require.resolve(`sql.js/dist/${fileName}`),
    });
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const database = fs.existsSync(this.filePath)
      ? new SQL.Database(fs.readFileSync(this.filePath))
      : new SQL.Database();
    database.run(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    const orderColumns = database.exec('PRAGMA table_info(pickup_orders)')[0].values;
    if (!orderColumns.some((column) => column[1] === 'idempotency_key')) {
      database.run('ALTER TABLE pickup_orders ADD COLUMN idempotency_key TEXT');
    }
    if (!orderColumns.some((column) => column[1] === 'request_hash')) {
      database.run('ALTER TABLE pickup_orders ADD COLUMN request_hash TEXT');
    }
    database.run(
      'CREATE UNIQUE INDEX IF NOT EXISTS pickup_orders_idempotency_key ON pickup_orders(idempotency_key) WHERE idempotency_key IS NOT NULL',
    );
    this.database = database;
    this.persist();
  }

  persist() {
    fs.writeFileSync(this.filePath, Buffer.from(this.database.export()));
  }

  async connect() {
    await this.ready;
    const releaseLock = await this.acquireLock();
    let released = false;
    return {
      query: this.queryUnlocked.bind(this),
      release() {
        if (released) return;
        released = true;
        releaseLock();
      },
    };
  }

  async query(sql, params = []) {
    await this.ready;
    const releaseLock = await this.acquireLock();
    try {
      return this.queryUnlocked(sql, params);
    } finally {
      releaseLock();
    }
  }

  async acquireLock() {
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  queryUnlocked(sql, params = []) {
    const boundValues = [];
    const statementSql = sql.replace(/\$(\d+)/g, (_match, index) => {
      boundValues.push(params[Number(index) - 1]);
      return '?';
    });
    const statement = this.database.prepare(statementSql);
    try {
      statement.bind(boundValues);
      const isSelect = /^\s*SELECT\b/i.test(statementSql);
      const rows = [];
      if (isSelect) {
        while (statement.step()) rows.push(statement.getAsObject());
      } else {
        statement.step();
      }

      const command = statementSql.trim().toUpperCase();
      if (/^BEGIN(?:\s|$)/.test(command)) this.inTransaction = true;
      if (command === 'ROLLBACK') this.inTransaction = false;
      if (command === 'COMMIT') {
        this.inTransaction = false;
        this.persist();
      } else if (!isSelect && !this.inTransaction && !/^(?:PRAGMA|BEGIN|ROLLBACK)\b/.test(command)) {
        this.persist();
      }
      return { rows, rowCount: isSelect ? rows.length : this.database.getRowsModified() };
    } finally {
      statement.free();
    }
  }

  async end() {
    await this.ready;
    this.persist();
    this.database.close();
  }
}

const database = new LocalSqlitePool();

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function serveAsset(response, fileName) {
  const filePath = path.join(publicDirectory, fileName);
  if (!filePath.startsWith(publicDirectory) || !fs.existsSync(filePath)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  const contentType = fileName.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8';
  response.writeHead(200, { 'content-type': contentType });
  response.end(fs.readFileSync(filePath));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) throw new ApiError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON');
  }
}

function validateOrder(body) {
  const customer = body && body.customer;
  const namePattern = /^[\p{L}\p{M}]+(?:[ '\u2019-][\p{L}\p{M}]+)*$/u;
  const controlCharacters = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
  const requiredText = (value, label, maxLength) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
      throw new ApiError(400, `${label} is required and must be at most ${maxLength} characters`);
    }
    return value.trim();
  };
  const name = (value, label) => {
    const normalized = requiredText(value, label, 100).normalize('NFC');
    if (!namePattern.test(normalized)) {
      throw new ApiError(400, `${label} must contain letters, spaces, apostrophes, or hyphens`);
    }
    return normalized;
  };
  const street = requiredText(customer && customer.street, 'Street', 200);
  if (controlCharacters.test(street)) throw new ApiError(400, 'Street contains unsupported characters');
  const phone = requiredText(customer && customer.phone, 'Phone number', 32);
  if (!/^[+0-9(). -]{6,32}$/.test(phone) || phone.replace(/\D/g, '').length < 6) {
    throw new ApiError(400, 'Phone number is invalid');
  }
  const order = {
    customer: {
      firstName: name(customer && customer.firstName, 'First name'),
      lastName: name(customer && customer.lastName, 'Last name'),
      street,
      zipCode: requiredText(customer && customer.zipCode, 'ZIP code', 5),
      phone,
    },
    pickupTimeSlot: body && body.pickupTimeSlot,
    items: body && body.items,
  };
  if (!/^[0-9]{5}$/.test(order.customer.zipCode)) throw new ApiError(400, 'ZIP code must contain five digits');
  if (!pickupSlots.has(order.pickupTimeSlot)) throw new ApiError(400, 'Pickup time slot is invalid');
  if (!Array.isArray(order.items) || order.items.length < 1 || order.items.length > 4) {
    throw new ApiError(400, 'Order must contain between one and four bottle categories');
  }

  const seenTypes = new Set();
  order.items = order.items.map((item) => {
    if (!item || !Object.hasOwn(bottleRates, item.type) || seenTypes.has(item.type)) {
      throw new ApiError(400, 'Bottle category is invalid or duplicated');
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000) {
      throw new ApiError(400, 'Bottle quantity must be an integer between 1 and 1000');
    }
    seenTypes.add(item.type);
    return { type: item.type, quantity: item.quantity, unitRefund: bottleRates[item.type] };
  });
  return order;
}

async function createOrder(request, response) {
  const idempotencyKey = request.headers['idempotency-key'];
  if (typeof idempotencyKey !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
    return sendJson(response, 400, { error: 'A valid Idempotency-Key UUID header is required' });
  }

  let order;
  try {
    order = validateOrder(await readJsonBody(request));
  } catch (error) {
    if (error instanceof ApiError) return sendJson(response, error.status, { error: error.message });
    throw error;
  }

  const totalRefund = order.items.reduce((total, item) => total + item.unitRefund * item.quantity, 0).toFixed(2);
  const requestHash = crypto.createHash('sha256').update(JSON.stringify(order)).digest('hex');
  let id;
  let client;
  let duplicateOrder;
  try {
    client = await database.connect();
    try {
      await client.query('BEGIN IMMEDIATE');
      const existing = await client.query(
        'SELECT id, request_hash FROM pickup_orders WHERE idempotency_key = $1',
        [idempotencyKey],
      );
      if (existing.rowCount) {
        if (existing.rows[0].request_hash !== requestHash) {
          await client.query('ROLLBACK');
          return sendJson(response, 409, { error: 'Idempotency-Key was already used with different order data' });
        }
        duplicateOrder = await readOrder(client, existing.rows[0].id);
        await client.query('COMMIT');
      } else {
        const references = await client.query(
          "SELECT id FROM pickup_orders WHERE length(id) = 4 AND id GLOB '[0-9][0-9][0-9][0-9]'",
        );
        const usedReferences = new Set(references.rows.map((row) => row.id));
        const availableReferences = Array.from({ length: 9000 }, (_value, index) => String(index + 1000))
          .filter((reference) => !usedReferences.has(reference));
        if (availableReferences.length === 0) {
          throw new ApiError(503, 'No four-digit order references are available');
        }
        id = availableReferences[crypto.randomInt(availableReferences.length)];

        await client.query(
          `INSERT INTO pickup_orders
            (id, first_name, last_name, street, zip_code, phone, pickup_time_slot, total_refund, idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            id,
            order.customer.firstName,
            order.customer.lastName,
            order.customer.street,
            order.customer.zipCode,
            order.customer.phone,
            order.pickupTimeSlot,
            totalRefund,
            idempotencyKey,
            requestHash,
          ],
        );
        for (const item of order.items) {
          await client.query(
            `INSERT INTO pickup_order_items (order_id, bottle_type, quantity, unit_refund)
             VALUES ($1, $2, $3, $4)`,
            [id, item.type, item.quantity, item.unitRefund.toFixed(2)],
          );
        }
        await client.query('COMMIT');
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof ApiError) {
      return sendJson(response, error.status, { error: error.message });
    }
    console.error('Failed to save pickup order:', error);
    return sendJson(response, 503, { error: 'Order storage is unavailable' });
  }

  if (duplicateOrder) return sendJson(response, 200, { data: duplicateOrder });
  return sendJson(response, 201, {
    data: { id, status: 'confirmed', pickupTimeSlot: order.pickupTimeSlot, totalRefund, items: order.items },
  });
}

async function readOrder(client, id) {
  const result = await client.query(
    'SELECT id, pickup_time_slot, status, total_refund, created_at FROM pickup_orders WHERE id = $1',
    [id],
  );
  if (!result.rowCount) return null;
  const order = result.rows[0];
  const items = await client.query(
    'SELECT bottle_type AS type, quantity, unit_refund AS "unitRefund" FROM pickup_order_items WHERE order_id = $1 ORDER BY bottle_type',
    [id],
  );
  return {
    id: order.id,
    status: order.status,
    pickupTimeSlot: order.pickup_time_slot,
    totalRefund: Number(order.total_refund).toFixed(2),
    createdAt: order.created_at,
    items: items.rows.map((item) => ({ ...item, unitRefund: Number(item.unitRefund) })),
  };
}

async function getOrder(response, id) {
  if (!orderIdPattern.test(id)) {
    return sendJson(response, 404, { error: 'Order not found' });
  }

  try {
    const order = await readOrder(database, id);
    return order
      ? sendJson(response, 200, { data: order })
      : sendJson(response, 404, { error: 'Order not found' });
  } catch (error) {
    console.error('Failed to retrieve pickup order:', error);
    return sendJson(response, 503, { error: 'Order storage is unavailable' });
  }
}

async function listOrders(response) {
  try {
    const result = await database.query(
      `SELECT
         o.id,
         o.first_name || ' ' || o.last_name AS customer_name,
         o.pickup_time_slot,
         o.status,
         o.total_refund,
         o.created_at,
         i.bottle_type AS type,
         i.quantity,
         i.unit_refund AS unit_refund
       FROM pickup_orders o
       LEFT JOIN pickup_order_items i ON i.order_id = o.id
       ORDER BY o.created_at DESC, o.id DESC, i.bottle_type`,
    );
    const orders = new Map();
    for (const row of result.rows) {
      let order = orders.get(row.id);
      if (!order) {
        order = {
          id: row.id,
          customerName: row.customer_name,
          pickupTimeSlot: row.pickup_time_slot,
          status: row.status,
          totalRefund: Number(row.total_refund).toFixed(2),
          createdAt: row.created_at,
          items: [],
        };
        orders.set(row.id, order);
      }
      if (row.type) {
        order.items.push({
          type: row.type,
          quantity: row.quantity,
          unitRefund: Number(row.unit_refund),
        });
      }
    }
    return sendJson(response, 200, { data: Array.from(orders.values()) });
  } catch (error) {
    console.error('Failed to list pickup orders:', error);
    return sendJson(response, 503, { error: 'Order storage is unavailable' });
  }
}

function isAllowedLocalHost(hostHeader) {
  if (typeof hostHeader !== 'string') return false;
  const match = /^(localhost|127\.0\.0\.1)(?::([0-9]{1,5}))?$/i.exec(hostHeader);
  if (!match) return false;
  return !match[2] || (Number(match[2]) >= 1 && Number(match[2]) <= 65535);
}

function isAllowedApiOrigin(request) {
  const origin = request.headers.origin;
  if (origin === undefined) return request.headers['sec-fetch-site'] !== 'cross-site';
  if (typeof origin !== 'string' || origin === 'null') return false;
  try {
    const parsedOrigin = new URL(origin);
    const originPort = parsedOrigin.port || '80';
    const requestPort = request.headers.host.split(':')[1] || '80';
    return parsedOrigin.protocol === 'http:' &&
      isAllowedLocalHost(parsedOrigin.host) &&
      parsedOrigin.host.toLowerCase() === request.headers.host.toLowerCase() &&
      originPort === requestPort;
  } catch {
    return false;
  }
}

async function handleRequest(request, response) {
  if (!isAllowedLocalHost(request.headers.host)) {
    return sendJson(response, 400, { error: 'Invalid Host header' });
  }
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/health') return sendJson(response, 200, { status: 'ok' });
  if (url.pathname.startsWith('/api/') && !isAllowedApiOrigin(request)) {
    return sendJson(response, 403, { error: 'Cross-origin API requests are not allowed' });
  }
  if (url.pathname === '/api/orders' && request.method === 'GET') return listOrders(response);
  if (url.pathname === '/api/orders' && request.method === 'POST') return createOrder(request, response);
  if (url.pathname.startsWith('/api/orders/')) {
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' });
    return getOrder(response, url.pathname.split('/').pop());
  }
  if (url.pathname === '/api/orders') return sendJson(response, 405, { error: 'Method not allowed' });
  if (url.pathname === '/' || url.pathname === '/pulse' || url.pathname === '/index.html') {
    return serveAsset(response, 'index.html');
  }
  if (url.pathname === '/orders' || url.pathname === '/orders.html') return serveAsset(response, 'orders.html');
  if (url.pathname === '/70b82787-b394-4168-9124-f1244fcbb843.png') {
    return serveAsset(response, '70b82787-b394-4168-9124-f1244fcbb843.png');
  }
  response.writeHead(404);
  response.end('Not found');
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error('Request failed:', error);
    if (!response.headersSent) sendJson(response, 500, { error: 'Internal server error' });
    else response.destroy();
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Pulse Logistics listening on http://127.0.0.1:${port}`);
});

function shutdown() {
  server.close(() => {
    database.end().catch((error) => console.error('Failed to close SQLite database:', error));
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
