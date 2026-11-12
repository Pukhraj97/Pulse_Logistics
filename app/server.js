const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const initSqlJs = require('sql.js');

const port = Number(process.env.PORT || 4174);
const publicDirectory = path.join(__dirname, 'public');
const bottleRates = { pet: 0.25, beer: 0.08, water: 0.15, can: 0.25 };
const maxBottlesPerCategory = 50;
const orderIdPattern = /^(?:[0-9]{4}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const pickupSlots = new Set([
  '10:00-11:00', '11:00-12:00', '12:00-13:00', '13:00-14:00', '14:00-15:00',
  '15:00-16:00', '16:00-17:00', '17:00-18:00', '18:00-19:00',
]);
const offerWindowSeconds = 60;
const offerWindowMs = offerWindowSeconds * 1000;
const driverCredentials = { username: 'James', password: 'genius' };

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
    if (!orderColumns.some((column) => column[1] === 'assigned_driver_id')) {
      database.run('ALTER TABLE pickup_orders ADD COLUMN assigned_driver_id TEXT');
    }
    if (!orderColumns.some((column) => column[1] === 'completed_at')) {
      database.run('ALTER TABLE pickup_orders ADD COLUMN completed_at TEXT');
    }
    if (!orderColumns.some((column) => column[1] === 'iban')) {
      database.run('ALTER TABLE pickup_orders ADD COLUMN iban TEXT');
    }
    const offerColumns = database.exec('PRAGMA table_info(driver_order_offers)')[0].values;
    if (!offerColumns.some((column) => column[1] === 'missed_at')) {
      database.run('ALTER TABLE driver_order_offers ADD COLUMN missed_at TEXT');
    }
    const driverColumns = database.exec('PRAGMA table_info(drivers)')[0].values;
    if (!driverColumns.some((column) => column[1] === 'username')) {
      database.run('ALTER TABLE drivers ADD COLUMN username TEXT');
    }
    database.run(
      'CREATE INDEX IF NOT EXISTS pickup_orders_active_driver ON pickup_orders(assigned_driver_id, completed_at)',
    );
    database.run(
      'CREATE UNIQUE INDEX IF NOT EXISTS pickup_orders_idempotency_key ON pickup_orders(idempotency_key) WHERE idempotency_key IS NOT NULL',
    );
    database.run(
      'CREATE UNIQUE INDEX IF NOT EXISTS drivers_username_unique ON drivers(username) WHERE username IS NOT NULL',
    );
    database.run('UPDATE drivers SET online = 0');
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
  const iban = requiredText(customer && customer.iban, 'IBAN', 34);
  if (!/^[A-Za-z]{2}[0-9]{2}[A-Za-z0-9]{11,30}$/.test(iban)) {
    throw new ApiError(400, 'IBAN is invalid');
  }
  const order = {
    customer: {
      firstName: name(customer && customer.firstName, 'First name'),
      lastName: name(customer && customer.lastName, 'Last name'),
      street,
      zipCode: requiredText(customer && customer.zipCode, 'ZIP code', 5),
      phone,
      iban: iban.toUpperCase(),
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
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > maxBottlesPerCategory) {
      throw new ApiError(400, `Bottle quantity must be an integer between 1 and ${maxBottlesPerCategory}`);
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
  let notifiedDrivers = 0;
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
            (id, first_name, last_name, street, zip_code, phone, iban, pickup_time_slot, total_refund, idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            id,
            order.customer.firstName,
            order.customer.lastName,
            order.customer.street,
            order.customer.zipCode,
            order.customer.phone,
            order.customer.iban,
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
        const onlineDrivers = await client.query(
          `SELECT d.id
           FROM drivers d
           WHERE d.online = 1
             AND NOT EXISTS (
               SELECT 1 FROM pickup_orders o
               WHERE o.assigned_driver_id = d.id AND o.completed_at IS NULL
             )`,
        );
        const offeredAt = new Date();
        const createdAt = offeredAt.toISOString();
        const expiresAt = new Date(offeredAt.getTime() + offerWindowMs).toISOString();
        for (const driver of onlineDrivers.rows) {
          await client.query(
            `INSERT INTO driver_order_offers (driver_id, order_id, status, created_at, expires_at)
             VALUES ($1, $2, 'pending', $3, $4)`,
            [driver.id, id, createdAt, expiresAt],
          );
        }
        notifiedDrivers = onlineDrivers.rowCount;
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
    data: {
      id,
      status: 'confirmed',
      pickupTimeSlot: order.pickupTimeSlot,
      totalRefund,
      items: order.items,
      dispatch: { notifiedDrivers },
    },
  });
}

function getBearerToken(request) {
  const authorization = request.headers.authorization;
  const match = typeof authorization === 'string' && /^Bearer ([0-9a-f-]{36})$/i.exec(authorization);
  return match ? match[1] : null;
}

async function authenticateDriver(request) {
  const token = getBearerToken(request);
  if (!token) throw new ApiError(401, 'Driver authentication is required');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const result = await database.query(
    'SELECT id, name, vehicle_type, online FROM drivers WHERE token_hash = $1 AND username IS NOT NULL',
    [tokenHash],
  );
  if (!result.rowCount) throw new ApiError(401, 'Driver token is invalid');
  return result.rows[0];
}

async function loginDriver(request, response) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof ApiError) return sendJson(response, error.status, { error: error.message });
    throw error;
  }
  if (!body || body.username !== driverCredentials.username || body.password !== driverCredentials.password) {
    return sendJson(response, 401, { error: 'Invalid username or password' });
  }
  const token = crypto.randomUUID();
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  let client;
  try {
    client = await database.connect();
    let driverId;
    try {
      await client.query('BEGIN IMMEDIATE');
      const existing = await client.query('SELECT id FROM drivers WHERE username = $1', [driverCredentials.username]);
      if (existing.rowCount) {
        driverId = existing.rows[0].id;
      } else {
        const legacy = await client.query(
          'SELECT id FROM drivers WHERE username IS NULL AND name = $1 COLLATE NOCASE ORDER BY created_at LIMIT 1',
          [driverCredentials.username],
        );
        if (legacy.rowCount) {
          driverId = legacy.rows[0].id;
          await client.query('UPDATE drivers SET username = $1 WHERE id = $2', [driverCredentials.username, driverId]);
        } else {
          driverId = crypto.randomUUID();
          await client.query(
            `INSERT INTO drivers (id, name, username, vehicle_type, token_hash)
             VALUES ($1, $2, $3, 'cargo-bike', $4)`,
            [driverId, driverCredentials.username, driverCredentials.username, tokenHash],
          );
        }
      }
      await client.query('UPDATE drivers SET token_hash = $1, online = 0 WHERE id = $2', [tokenHash, driverId]);
      await expirePendingDriverOffers(client, driverId, new Date().toISOString());
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const result = await database.query(
      'SELECT id, name, vehicle_type, online FROM drivers WHERE id = $1',
      [driverId],
    );
    const driver = result.rows[0];
    return sendJson(response, 200, {
      data: {
        driver: {
          id: driver.id,
          name: driver.name,
          vehicleType: driver.vehicle_type,
          online: Boolean(driver.online),
        },
        token,
      },
    });
  } catch (error) {
    console.error('Failed to log in driver:', error);
    return sendJson(response, 503, { error: 'Driver login is unavailable' });
  }
}

async function expirePendingDriverOffers(client, driverId, now) {
  await client.query(
    `UPDATE driver_order_offers
     SET status = 'expired', missed_at = CASE WHEN expires_at <= $2 THEN $2 ELSE missed_at END
     WHERE driver_id = $1 AND status = 'pending'`,
    [driverId, now],
  );
}

async function logoutDriver(request, response) {
  try {
    const driver = await authenticateDriver(request);
    const client = await database.connect();
    try {
      await client.query('BEGIN IMMEDIATE');
      const replacementHash = crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex');
      await client.query(
        'UPDATE drivers SET online = 0, token_hash = $1 WHERE id = $2',
        [replacementHash, driver.id],
      );
      await expirePendingDriverOffers(client, driver.id, new Date().toISOString());
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return sendJson(response, 200, { data: { loggedOut: true } });
  } catch (error) {
    if (error instanceof ApiError) return sendJson(response, error.status, { error: error.message });
    console.error('Failed to log out driver:', error);
    return sendJson(response, 503, { error: 'Driver logout is unavailable' });
  }
}

async function getDriverOffers(driverId) {
  const now = new Date().toISOString();
  await database.query(
    "UPDATE driver_order_offers SET status = 'expired', missed_at = $2 WHERE driver_id = $1 AND status = 'pending' AND expires_at <= $2",
    [driverId, now],
  );
  const result = await database.query(
    `SELECT o.id, o.first_name || ' ' || o.last_name AS customer_name,
            o.street, o.zip_code, o.pickup_time_slot, o.created_at AS order_created_at,
            f.created_at AS offered_at, f.expires_at, f.missed_at, f.status,
            group_concat(i.bottle_type || ':' || i.quantity, ',') AS items
     FROM driver_order_offers f
     JOIN pickup_orders o ON o.id = f.order_id
     LEFT JOIN pickup_order_items i ON i.order_id = o.id
     WHERE f.driver_id = $1 AND f.status = 'pending' AND o.assigned_driver_id IS NULL
     GROUP BY o.id
     ORDER BY f.created_at DESC`,
    [driverId],
  );
  return result.rows.map((row) => formatDriverOffer(row));
}

async function getMissedDriverOrders(driverId) {
  const result = await database.query(
    `SELECT o.id, o.first_name || ' ' || o.last_name AS customer_name,
            o.street, o.zip_code, o.pickup_time_slot, o.created_at AS order_created_at,
            f.created_at AS offered_at, f.expires_at, f.missed_at,
            group_concat(i.bottle_type || ':' || i.quantity, ',') AS items
     FROM driver_order_offers f
     JOIN pickup_orders o ON o.id = f.order_id
     LEFT JOIN pickup_order_items i ON i.order_id = o.id
     WHERE f.driver_id = $1 AND f.missed_at IS NOT NULL
     GROUP BY o.id
     ORDER BY f.missed_at DESC`,
    [driverId],
  );
  return result.rows.map((row) => formatDriverOffer(row, 'missed'));
}

function formatDriverOffer(row, status = row.status) {
  const address = `${row.street}, ${row.zip_code}, Germany`;
  return {
    id: row.id,
    customerName: row.customer_name,
    address,
    pickupTimeSlot: row.pickup_time_slot,
    createdAt: row.order_created_at,
    offeredAt: row.offered_at,
    expiresAt: row.expires_at,
    ...(row.missed_at ? { missedAt: row.missed_at } : {}),
    status,
    items: row.items ? row.items.split(',').map((item) => {
      const [type, quantity] = item.split(':');
      return { type, quantity: Number(quantity) };
    }) : [],
    mapsUrl: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`,
  };
}

async function getActiveDriverOrder(driverId) {
  const result = await database.query(
    `SELECT o.id, o.first_name || ' ' || o.last_name AS customer_name,
            o.street, o.zip_code, o.pickup_time_slot, o.created_at AS order_created_at,
            group_concat(i.bottle_type || ':' || i.quantity, ',') AS items
     FROM pickup_orders o
     LEFT JOIN pickup_order_items i ON i.order_id = o.id
     WHERE o.assigned_driver_id = $1 AND o.completed_at IS NULL
     GROUP BY o.id
     ORDER BY o.created_at
     LIMIT 1`,
    [driverId],
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  const address = `${row.street}, ${row.zip_code}, Germany`;
  return {
    id: row.id,
    customerName: row.customer_name,
    address,
    pickupTimeSlot: row.pickup_time_slot,
    createdAt: row.order_created_at,
    status: 'accepted',
    items: row.items ? row.items.split(',').map((item) => {
      const [type, quantity] = item.split(':');
      return { type, quantity: Number(quantity) };
    }) : [],
    mapsUrl: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`,
  };
}

async function getCompletedDriverOrders(driverId) {
  const result = await database.query(
    `SELECT o.id, o.first_name || ' ' || o.last_name AS customer_name,
            o.street, o.zip_code, o.pickup_time_slot, o.created_at AS order_created_at,
            o.completed_at,
            group_concat(i.bottle_type || ':' || i.quantity, ',') AS items
     FROM pickup_orders o
     LEFT JOIN pickup_order_items i ON i.order_id = o.id
     WHERE o.assigned_driver_id = $1 AND o.completed_at IS NOT NULL
     GROUP BY o.id
     ORDER BY o.completed_at DESC`,
    [driverId],
  );
  return result.rows.map((row) => {
    const address = `${row.street}, ${row.zip_code}, Germany`;
    return {
      id: row.id,
      customerName: row.customer_name,
      address,
      pickupTimeSlot: row.pickup_time_slot,
      createdAt: row.order_created_at,
      completedAt: row.completed_at,
      status: 'completed',
      items: row.items ? row.items.split(',').map((item) => {
        const [type, quantity] = item.split(':');
        return { type, quantity: Number(quantity) };
      }) : [],
      mapsUrl: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`,
    };
  });
}

async function getDriverProfile(request, response) {
  try {
    const driver = await authenticateDriver(request);
    const availableOrders = await getDriverOffers(driver.id);
    const missedOrders = await getMissedDriverOrders(driver.id);
    const pendingOrders = driver.online ? availableOrders : [];
    return sendJson(response, 200, {
      data: {
        driver: {
          id: driver.id,
          name: driver.name,
          vehicleType: driver.vehicle_type,
          online: Boolean(driver.online),
        },
        pendingOrders,
        acceptedOrders: await getCompletedDriverOrders(driver.id),
        missedOrders,
        activeOrder: await getActiveDriverOrder(driver.id),
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return sendJson(response, error.status, { error: error.message });
    console.error('Failed to retrieve driver profile:', error);
    return sendJson(response, 503, { error: 'Driver service is unavailable' });
  }
}

async function setDriverPresence(request, response) {
  let body;
  try {
    body = await readJsonBody(request);
    if (!body || typeof body.online !== 'boolean') {
      return sendJson(response, 400, { error: 'online must be true or false' });
    }
    const driver = await authenticateDriver(request);
    const client = await database.connect();
    try {
      await client.query('BEGIN IMMEDIATE');
      await client.query('UPDATE drivers SET online = $1 WHERE id = $2', [body.online ? 1 : 0, driver.id]);
      if (!body.online) await expirePendingDriverOffers(client, driver.id, new Date().toISOString());
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    return sendJson(response, 200, { data: { online: body.online } });
  } catch (error) {
    if (error instanceof ApiError) return sendJson(response, error.status, { error: error.message });
    console.error('Failed to update driver presence:', error);
    return sendJson(response, 503, { error: 'Driver presence is unavailable' });
  }
}

async function acceptDriverOffer(request, response, orderId) {
  let driver;
  try {
    driver = await authenticateDriver(request);
  } catch (error) {
    if (error instanceof ApiError) return sendJson(response, error.status, { error: error.message });
    console.error('Failed to authenticate driver:', error);
    return sendJson(response, 503, { error: 'Driver service is unavailable' });
  }
  const client = await database.connect();
  try {
    await client.query('BEGIN IMMEDIATE');
    const now = new Date().toISOString();
    const activeOrder = await client.query(
      'SELECT id FROM pickup_orders WHERE assigned_driver_id = $1 AND completed_at IS NULL LIMIT 1',
      [driver.id],
    );
    if (activeOrder.rowCount) {
      await client.query('ROLLBACK');
      return sendJson(response, 409, { error: 'You already have an active order' });
    }
    const expiredOffer = await client.query(
      "UPDATE driver_order_offers SET status = 'expired', missed_at = $3 WHERE driver_id = $1 AND order_id = $2 AND status = 'pending' AND expires_at <= $3",
      [driver.id, orderId, now],
    );
    const offer = await client.query(
      `SELECT f.status, f.expires_at, d.online, o.assigned_driver_id
       FROM driver_order_offers f
       JOIN drivers d ON d.id = f.driver_id
       JOIN pickup_orders o ON o.id = f.order_id
       WHERE f.driver_id = $1 AND f.order_id = $2`,
      [driver.id, orderId],
    );
    if (!offer.rowCount || offer.rows[0].status !== 'pending' || !offer.rows[0].online ||
        offer.rows[0].expires_at <= now || offer.rows[0].assigned_driver_id) {
      await client.query(expiredOffer.rowCount ? 'COMMIT' : 'ROLLBACK');
      return sendJson(response, 409, { error: 'This order is no longer available to accept' });
    }
    await client.query('UPDATE pickup_orders SET assigned_driver_id = $1 WHERE id = $2', [driver.id, orderId]);
    await client.query(
      "UPDATE driver_order_offers SET status = CASE WHEN driver_id = $1 THEN 'accepted' ELSE 'unavailable' END WHERE order_id = $2 AND status = 'pending'",
      [driver.id, orderId],
    );
    await client.query(
      "UPDATE driver_order_offers SET status = 'unavailable' WHERE driver_id = $1 AND status = 'pending'",
      [driver.id],
    );
    await client.query('COMMIT');
    return sendJson(response, 200, { data: { orderId, status: 'accepted' } });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Failed to accept driver offer:', error);
    return sendJson(response, 503, { error: 'Could not accept this order' });
  } finally {
    client.release();
  }
}

async function completeDriverOrder(request, response, orderId) {
  let driver;
  try {
    driver = await authenticateDriver(request);
  } catch (error) {
    if (error instanceof ApiError) return sendJson(response, error.status, { error: error.message });
    console.error('Failed to authenticate driver:', error);
    return sendJson(response, 503, { error: 'Driver service is unavailable' });
  }
  const client = await database.connect();
  try {
    await client.query('BEGIN IMMEDIATE');
    const activeOrder = await client.query(
      'SELECT id FROM pickup_orders WHERE id = $1 AND assigned_driver_id = $2 AND completed_at IS NULL',
      [orderId, driver.id],
    );
    if (!activeOrder.rowCount) {
      await client.query('ROLLBACK');
      return sendJson(response, 409, { error: 'This is not your active order' });
    }
    await client.query(
      'UPDATE pickup_orders SET completed_at = $1 WHERE id = $2 AND assigned_driver_id = $3 AND completed_at IS NULL',
      [new Date().toISOString(), orderId, driver.id],
    );
    await client.query('COMMIT');
    return sendJson(response, 200, { data: { orderId, status: 'completed' } });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Failed to complete driver order:', error);
    return sendJson(response, 503, { error: 'Could not complete this order' });
  } finally {
    client.release();
  }
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
  if (url.pathname === '/api/drivers/login') {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' });
    return loginDriver(request, response);
  }
  if (url.pathname === '/api/drivers/logout') {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' });
    return logoutDriver(request, response);
  }
  if (url.pathname === '/api/drivers/driverStatus') {
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' });
    return getDriverProfile(request, response);
  }
  if (url.pathname === '/api/drivers/driverStatus/presence') {
    if (request.method !== 'PATCH') return sendJson(response, 405, { error: 'Method not allowed' });
    return setDriverPresence(request, response);
  }
  const completeMatch = /^\/api\/drivers\/driverStatus\/orders\/([0-9]{4}|[0-9a-f-]{36})\/complete$/i.exec(url.pathname);
  if (completeMatch) {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' });
    return completeDriverOrder(request, response, completeMatch[1]);
  }
  const acceptMatch = /^\/api\/drivers\/driverStatus\/pendingOrders\/([0-9]{4}|[0-9a-f-]{36})\/accept$/i.exec(url.pathname);
  if (acceptMatch) {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' });
    return acceptDriverOffer(request, response, acceptMatch[1]);
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
  if (url.pathname === '/driver' || url.pathname === '/driver.html') return serveAsset(response, 'driver.html');
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
