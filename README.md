# Pulse Logistics

Local bottle-pickup website, JSON API, and SQLite-backed order history.

## Run locally

From the project directory:

```powershell
npm install
npm start
```

Open <http://localhost:4174>. The main page supports English and German; add bottle categories and quantities, then enter customer details and choose a pickup time to submit an order.

Orders are stored in `app/data/pickup-orders.sqlite`. The database and `app/data` directory are created on first start, and orders persist across server restarts. The app uses `sql.js` and does not require Docker or a separate database server. Set `PORT` to change the listening port, or `PULSE_DB_PATH` to select a different database file.

Open <http://localhost:4174/orders> to view the local order history. It displays the customer name, order reference, pickup time, items, refund total, and status; it does not display phone numbers or street addresses. Use **Refresh** to reload the list. The history page is available directly at `/orders` and is not linked from the main page.

Open <http://localhost:4174/driver> for the Driver app. Use the **EN / DE** toggle to switch the interface between English and German. A driver creates a profile, switches online, and receives orders created while online. Each offer has a 60-second countdown, an accept action, and a Google Maps pickup link. Drivers are switched offline when the server restarts; they can go online again from the dashboard. The demo registration is not identity-verified.

## API

All API responses use JSON. Example order request:

```http
POST /api/orders
Content-Type: application/json
Idempotency-Key: 8e03978e-40d5-43e8-bc93-6894a57f9324

{
  "customer": {
    "firstName": "Alex",
    "lastName": "Example",
    "street": "Main Street 1",
    "zipCode": "10115",
    "phone": "+49 151 12345678"
  },
  "pickupTimeSlot": "10:00-11:00",
  "items": [{ "type": "pet", "quantity": 2 }]
}
```

- `POST /api/orders` validates and saves an order. It requires a UUID `Idempotency-Key`. A new order returns `201`; a retry with the same key and payload returns the existing order with `200`; using that key with different order data returns `409`.
- Each new order receives a unique four-digit reference from `1000` to `9999`. Since only 9,000 references are available, creating new orders will stop with an explicit error if they are all in use.
- `GET /api/orders` returns order history without street or phone.
- `GET /api/orders/{id}` returns an order receipt without customer contact details.
- `POST /api/drivers/register` accepts `{ "name": "Alex Driver", "vehicleType": "cargo-bike" }` and returns a driver profile plus a bearer token. Supported vehicle types are `cargo-bike`, `bike`, and `car`.
- `GET /api/drivers/driverStatus` returns the authenticated driver's online state, pending orders, completed accepted-order history (`acceptedOrders`), timed-out requests (`missedOrders`), and any active order. An active accepted order stays visible in the Driver app until completed, including after reload.
- `PATCH /api/drivers/driverStatus/presence` accepts `{ "online": true }` or `{ "online": false }`. Going offline expires outstanding requests; requests whose acceptance window has already run out are retained in `missedOrders`.
- `POST /api/drivers/driverStatus/pendingOrders/{orderId}/accept` accepts a pending order. The first online driver to accept wins; competing requests become unavailable. A driver with an active accepted order cannot accept another one.
- `POST /api/drivers/driverStatus/orders/{orderId}/complete` marks the driver's active order complete, adding it to `acceptedOrders` and freeing the driver to accept another request.
- `missedOrders` contains requests not accepted before their 60-second window expired. Entries include the missed time, pickup details, and Google Maps URL.
- When a new order is created, `POST /api/orders` creates persisted offers for online drivers who do not already have an active order and includes `dispatch.notifiedDrivers` in its `201` response. The Driver app polls `GET /api/drivers/driverStatus` every three seconds while open. Pending orders include the pickup address and an encoded Google Maps directions URL; customer phone numbers are not included.
- `GET /health` returns `{"status":"ok"}` when the HTTP server is responding. It does not check database readiness.

Invalid JSON or order fields return `400`; request bodies over 16 KiB return `413`; unsupported API methods return `405`; unknown orders return `404`; unauthenticated driver requests return `401`; an expired or already assigned offer returns `409`; and database errors return `503`.

Names accept Unicode letters and combining marks, separated by spaces, apostrophes, or hyphens, and are limited to 100 characters. Street addresses are required, limited to 200 characters, and cannot contain control or formatting characters. ZIP codes must contain exactly five digits. Phone numbers must contain 6–32 allowed characters and at least six digits. Pickup time must be one of the offered hourly slots from 10:00–19:00. Orders must include 1–4 distinct bottle categories (`pet`, `beer`, `water`, or `can`), with a quantity of 1–50 per category. The API validates these rules independently of browser validation.

The server binds to loopback (`127.0.0.1`), accepts only `localhost` or `127.0.0.1` Host values, and rejects cross-origin API requests. Driver API tokens are random and stored hashed in the local database, but registration is open and does not verify driver identity. This is a local-use demo, not a production dispatch service; do not expose it to other machines without real driver onboarding, authorization, HTTPS, and deployment protections.

## System tests

```powershell
npm test
```

This runs the complete Playwright system suite in `tests/pulse-orders.spec.ts`. The runner starts the application on a free local port and uses `test-results/pulse-orders.sqlite`, separate from the normal order database. It runs in desktop Chromium, mobile Chromium, Firefox, desktop WebKit, and iPhone WebKit.

The suite covers Consumer order creation and input validation, language switching, cart limits (1–50 per category), confirmation and payment text, order history and privacy, API error handling, idempotency and local-origin protections, and Driver registration, online dispatch, countdown expiry, acceptance, active-order limits, completion confirmation, missed orders, and persistence across server restarts.

Install browser binaries if needed:

```powershell
npx playwright install chromium firefox webkit
```

After a test run, open the generated HTML report with:

```powershell
npm run test:report
```
