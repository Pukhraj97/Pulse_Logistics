import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const idempotencyHeaders = () => ({ 'Idempotency-Key': randomUUID() });

async function findAvailablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

test.describe('Pulse Logistics pickup orders', () => {
  test('submits the bottle basket and page-two contact details', async ({ page }) => {
    let submittedOrder: Record<string, unknown> | undefined;
    await page.route('**/api/orders', async (route) => {
      submittedOrder = route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 'order-test-123',
            status: 'confirmed',
            pickupTimeSlot: '10:00-11:00',
            totalRefund: '0.50',
            items: [{ type: 'pet', quantity: 2, unitRefund: 0.25 }],
          },
        }),
      });
    });

    await page.goto('/');
    await expect(page.getByRole('link', { name: /order history|auftragsverlauf/i })).toHaveCount(0);
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await page.locator('.qty-btn').nth(1).click();
    await page.getByRole('button', { name: 'Add to Order' }).click();
    await page.getByRole('button', { name: 'Proceed to Address' }).click();
    await page.getByLabel('First Name *').fill('Alex');
    await page.getByLabel('Last Name *').fill('Example');
    await page.getByLabel('Street & House Number *').fill('Main Street 1');
    await page.getByLabel('ZIP Code (PLZ) *').fill('10115');
    await page.getByLabel('Mobile Phone Number *').fill('+49 151 12345678');
    await page.getByLabel('Pickup Time Slot *').selectOption('10:00-11:00');
    await page.getByRole('button', { name: 'Confirm Pickup' }).click();

    await expect(page.getByRole('heading', { name: 'Order Confirmed!' })).toBeVisible();
    await expect(page.locator('#t-step3-msg')).toContainText('order-test-123');
    expect(await page.locator('#fname').getAttribute('maxlength')).toBe('100');
    expect(await page.locator('#street').getAttribute('maxlength')).toBe('200');
    expect(await page.locator('#zip').getAttribute('autocomplete')).toBe('postal-code');
    expect(await page.locator('#phone').getAttribute('autocomplete')).toBe('tel');
    expect(submittedOrder).toEqual({
      customer: {
        firstName: 'Alex',
        lastName: 'Example',
        street: 'Main Street 1',
        zipCode: '10115',
        phone: '+49 151 12345678',
      },
      pickupTimeSlot: '10:00-11:00',
      items: [{ type: 'pet', quantity: 2 }],
    });
  });

  test('keeps main page typography consistent and card width responsive', async ({ page }) => {
    for (const width of [360, 375, 420, 768, 900, 1080, 1440, 2160]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      const layout = await page.evaluate(() => {
        const brand = document.querySelector('.brand-title')!;
        const heading = document.querySelector('#step1 h2')!;
        const card = document.querySelector('#step1')!;
        const header = document.querySelector('header')!;
        const languageSwitch = document.querySelector('.lang-switch')!;
        const languageButtons = Array.from(document.querySelectorAll('.lang-btn'));
        return {
          viewportWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          cardWidth: card.getBoundingClientRect().width,
          brandFont: getComputedStyle(brand).fontSize,
          headingFont: getComputedStyle(heading).fontSize,
          header: header.getBoundingClientRect().toJSON(),
          brand: brand.getBoundingClientRect().toJSON(),
          languageSwitch: languageSwitch.getBoundingClientRect().toJSON(),
          languageButtons: languageButtons.map((button) => button.getBoundingClientRect().toJSON()),
          headerStyle: {
            padding: getComputedStyle(header).padding,
            alignItems: getComputedStyle(header).alignItems,
            justifyContent: getComputedStyle(header).justifyContent,
          },
          brandStyle: {
            fontFamily: getComputedStyle(brand).fontFamily,
            fontSize: getComputedStyle(brand).fontSize,
            fontWeight: getComputedStyle(brand).fontWeight,
            letterSpacing: getComputedStyle(brand).letterSpacing,
          },
          languageStyle: (() => {
            const style = getComputedStyle(languageSwitch);
            return {
              backgroundColor: style.backgroundColor,
              backdropFilter: style.backdropFilter,
              border: style.border,
              borderRadius: style.borderRadius,
              gap: style.gap,
              padding: style.padding,
            };
          })(),
          buttonStyles: languageButtons.map((button) => {
            const style = getComputedStyle(button);
            return {
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              padding: style.padding,
              lineHeight: style.lineHeight,
            };
          }),
        };
      });

      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.cardWidth).toBe(Math.min(480, width - 32));
      expect(layout.brand.right).toBeLessThanOrEqual(layout.languageSwitch.left);
      await page.goto('/orders');
      const ordersLayout = await page.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        panelWidth: document.querySelector('.panel')!.getBoundingClientRect().width,
        headerBottom: document.querySelector('header')!.getBoundingClientRect().bottom,
        panelTop: document.querySelector('.panel')!.getBoundingClientRect().top,
        brandFont: getComputedStyle(document.querySelector('.brand-title')!).fontSize,
        headingFont: getComputedStyle(document.querySelector('h1')!).fontSize,
        header: document.querySelector('header')!.getBoundingClientRect().toJSON(),
        brand: document.querySelector('.brand-title')!.getBoundingClientRect().toJSON(),
        languageSwitch: document.querySelector('.lang-switch')!.getBoundingClientRect().toJSON(),
        languageButtons: Array.from(document.querySelectorAll('.lang-btn'))
          .map((button) => button.getBoundingClientRect().toJSON()),
        languageStyle: (() => {
          const style = getComputedStyle(document.querySelector('.lang-switch')!);
          return {
            backgroundColor: style.backgroundColor,
            backdropFilter: style.backdropFilter,
            border: style.border,
            borderRadius: style.borderRadius,
            gap: style.gap,
            padding: style.padding,
          };
        })(),
        headerStyle: (() => {
          const style = getComputedStyle(document.querySelector('header')!);
          return {
            padding: style.padding,
            alignItems: style.alignItems,
            justifyContent: style.justifyContent,
          };
        })(),
        brandStyle: (() => {
          const style = getComputedStyle(document.querySelector('.brand-title')!);
          return {
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            letterSpacing: style.letterSpacing,
          };
        })(),
        buttonStyles: Array.from(document.querySelectorAll('.lang-btn')).map((button) => {
          const style = getComputedStyle(button);
          return {
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            padding: style.padding,
            lineHeight: style.lineHeight,
          };
        }),
      }));
      expect(ordersLayout.scrollWidth).toBeLessThanOrEqual(ordersLayout.viewportWidth);
      expect(ordersLayout.panelWidth).toBe(layout.cardWidth);
      expect(ordersLayout.panelTop - ordersLayout.headerBottom).toBe(16);
      expect(ordersLayout.brandFont).toBe(layout.brandFont);
      expect(ordersLayout.headingFont).toBe(layout.headingFont);
      expect(ordersLayout.brand.right).toBeLessThanOrEqual(ordersLayout.languageSwitch.left);
      expect({
        header: ordersLayout.header,
        brand: ordersLayout.brand,
        languageSwitch: ordersLayout.languageSwitch,
        languageButtons: ordersLayout.languageButtons,
        languageStyle: ordersLayout.languageStyle,
        headerStyle: ordersLayout.headerStyle,
        brandStyle: ordersLayout.brandStyle,
        buttonStyles: ordersLayout.buttonStyles,
      }).toEqual({
        header: layout.header,
        brand: layout.brand,
        languageSwitch: layout.languageSwitch,
        languageButtons: layout.languageButtons,
        languageStyle: layout.languageStyle,
        headerStyle: layout.headerStyle,
        brandStyle: layout.brandStyle,
        buttonStyles: layout.buttonStyles,
      });
    }
  });

  test('shows an API error without discarding the entered form data', async ({ page }) => {
    await page.route('**/api/orders', (route) => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Order storage is unavailable' }),
    }));

    await page.goto('/');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await page.getByRole('button', { name: 'Add to Order' }).click();
    await page.getByRole('button', { name: 'Proceed to Address' }).click();
    await page.getByLabel('First Name *').fill('Alex');
    await page.getByLabel('Last Name *').fill('Example');
    await page.getByLabel('Street & House Number *').fill('Main Street 1');
    await page.getByLabel('ZIP Code (PLZ) *').fill('10115');
    await page.getByLabel('Mobile Phone Number *').fill('+49 151 12345678');
    await page.getByLabel('Pickup Time Slot *').selectOption('10:00-11:00');
    await page.getByRole('button', { name: 'Confirm Pickup' }).click();

    await expect(page.getByRole('alert')).toHaveText('Order storage is unavailable');
    await expect(page.getByLabel('First Name *')).toHaveValue('Alex');
    await page.getByRole('button', { name: /Back/ }).click();
    await expect(page.getByText('1x PET Plastic Bottle')).toBeVisible();
  });

  test('rejects invalid order input', async ({ request }) => {
    const response = await request.post('/api/orders', {
      headers: idempotencyHeaders(),
      data: {
        customer: { firstName: 'Alex', lastName: 'Example', street: 'Main Street 1', zipCode: 'bad', phone: '+49 151 12345678' },
        pickupTimeSlot: '10:00-11:00',
        items: [{ type: 'pet', quantity: 1 }],
      },
    });
    expect(response.status()).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'ZIP code must contain five digits' });
  });

  test('serves health and handles unsupported API methods and unknown orders', async ({ request }) => {
    const health = await request.get('/health');
    expect(health.status()).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: 'ok' });
    expect(health.headers()['content-type']).toContain('application/json');

    for (const response of [
      await request.put('/api/orders'),
      await request.delete('/api/orders'),
      await request.post('/api/orders/not-an-id', { data: {} }),
    ]) {
      expect(response.status()).toBe(405);
      await expect(response.json()).resolves.toEqual({ error: 'Method not allowed' });
    }

    expect((await request.get('/api/orders/not-an-id')).status()).toBe(404);
    expect((await request.get('/api/orders/00000000-0000-4000-8000-000000000000')).status()).toBe(404);
    expect((await request.get('/api/not-a-route')).status()).toBe(404);
  });

  test('blocks untrusted Host and cross-origin API requests', async ({ request }) => {
    const invalidHost = await request.get('/health', {
      headers: { Host: 'attacker.example' },
    });
    expect(invalidHost.status()).toBe(400);
    await expect(invalidHost.json()).resolves.toEqual({ error: 'Invalid Host header' });

    for (const headers of [
      { Origin: 'https://attacker.example' },
      { Origin: 'null' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      const response = await request.get('/api/orders', { headers });
      expect(response.status()).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'Cross-origin API requests are not allowed',
      });
    }

    const mismatchedHost = await request.get('/api/orders', {
      headers: { Origin: 'http://localhost:4175' },
    });
    expect(mismatchedHost.status()).toBe(403);

    const crossOriginPost = await request.post('/api/orders', {
      headers: { ...idempotencyHeaders(), Origin: 'http://attacker.example' },
      data: {},
    });
    expect(crossOriginPost.status()).toBe(403);
  });

  test('rejects malformed, oversized, and structurally invalid order bodies', async ({ request }) => {
    const malformed = await request.post('/api/orders', {
      headers: { ...idempotencyHeaders(), 'content-type': 'application/json' },
      data: Buffer.from('{"customer":'),
    });
    expect(malformed.status()).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: 'Request body must be valid JSON' });

    const oversized = await request.post('/api/orders', {
      headers: { ...idempotencyHeaders(), 'content-type': 'application/json' },
      data: Buffer.from(JSON.stringify({ padding: 'x'.repeat(16 * 1024) })),
    });
    expect(oversized.status()).toBe(413);
    await expect(oversized.json()).resolves.toEqual({ error: 'Request body is too large' });

    for (const body of [null, [], 'order', 7, {}]) {
      const response = await request.post('/api/orders', {
        headers: idempotencyHeaders(),
        data: body,
      });
      expect(response.status()).toBe(400);
    }
  });

  test('accepts inclusive order validation boundaries', async ({ request }) => {
    const response = await request.post('/api/orders', {
      headers: idempotencyHeaders(),
      data: {
        customer: {
          firstName: 'A'.repeat(100),
          lastName: 'B'.repeat(100),
          street: `1${'a'.repeat(199)}`,
          zipCode: '00000',
          phone: '123456',
        },
        pickupTimeSlot: '10:00-11:00',
        items: [{ type: 'pet', quantity: 1000 }],
      },
    });
    expect(response.status()).toBe(201);
    await expect(response.json()).resolves.toEqual({
      data: {
        id: expect.any(String),
        status: 'confirmed',
        pickupTimeSlot: '10:00-11:00',
        totalRefund: '250.00',
        items: [{ type: 'pet', quantity: 1000, unitRefund: 0.25 }],
      },
    });
  });

  test('saves and retrieves a pickup order', async ({ request }) => {
    const response = await request.post('/api/orders', {
      headers: idempotencyHeaders(),
      data: {
        customer: {
          firstName: 'Local',
          lastName: 'Storage',
          street: 'Main Street 1',
          zipCode: '10115',
          phone: '+49 151 12345678',
        },
        pickupTimeSlot: '12:00-13:00',
        items: [{ type: 'beer', quantity: 3 }],
      },
    });

    expect(response.status()).toBe(201);
    const created = (await response.json()).data;
    expect(created).toEqual(expect.objectContaining({
      id: expect.any(String),
      status: 'confirmed',
      pickupTimeSlot: '12:00-13:00',
      totalRefund: '0.24',
    }));

    const retrievedResponse = await request.get(`/api/orders/${created.id}`);
    expect(retrievedResponse.status()).toBe(200);
    const retrieved = (await retrievedResponse.json()).data;
    expect(retrieved).toEqual(expect.objectContaining({
      id: created.id,
      pickupTimeSlot: '12:00-13:00',
      totalRefund: '0.24',
      items: [{ type: 'beer', quantity: 3, unitRefund: 0.08 }],
    }));
    expect(retrieved).not.toHaveProperty('customer');
  });

  test('lists saved orders without returning customer contact details', async ({ request }) => {
    const createdResponse = await request.post('/api/orders', {
      headers: idempotencyHeaders(),
      data: {
        customer: {
          firstName: 'History',
          lastName: 'Test',
          street: 'Private Street 4',
          zipCode: '10115',
          phone: '+49 151 12345678',
        },
        pickupTimeSlot: '14:00-15:00',
        items: [{ type: 'water', quantity: 2 }],
      },
    });
    expect(createdResponse.status()).toBe(201);
    const created = (await createdResponse.json()).data;

    const response = await request.get('/api/orders');
    expect(response.status()).toBe(200);
    const orders = (await response.json()).data;
    const savedOrder = orders.find((order: { id: string }) => order.id === created.id);
    expect(savedOrder).toEqual(expect.objectContaining({
      customerName: 'History Test',
      pickupTimeSlot: '14:00-15:00',
      totalRefund: '0.30',
      items: [{ type: 'water', quantity: 2, unitRefund: 0.15 }],
    }));
    expect(savedOrder).not.toHaveProperty('phone');
    expect(savedOrder).not.toHaveProperty('street');
  });

  test('shows saved orders in the local order history page', async ({ page, request }) => {
    const response = await request.post('/api/orders', {
      headers: idempotencyHeaders(),
      data: {
        customer: {
          firstName: 'Visible',
          lastName: 'Pickup',
          street: 'Main Street 1',
          zipCode: '10115',
          phone: '+49 151 12345678',
        },
        pickupTimeSlot: '16:00-17:00',
        items: [{ type: 'can', quantity: 4 }],
      },
    });
    expect(response.status()).toBe(201);
    const { id } = (await response.json()).data;

    await page.goto('/orders');
    await expect(page.getByRole('heading', { name: 'Auftragsverlauf' })).toBeVisible();
    const savedOrder = page.getByRole('article').filter({ hasText: id });
    await expect(savedOrder.getByRole('heading', { name: 'Visible Pickup' })).toBeVisible();
    await expect(savedOrder.getByText(`Referenz: ${id}`)).toBeVisible();
    await expect(savedOrder.getByText('4 × Aluminiumdose (€0.25 each)')).toBeVisible();
    await expect(savedOrder.getByText('16:00–17:00')).toBeVisible();
  });

  test('keeps the order history usable without overflow on narrow phone screens', async ({ page, request }) => {
    const response = await request.post('/api/orders', {
      headers: idempotencyHeaders(),
      data: {
        customer: {
          firstName: 'Mobile',
          lastName: 'History',
          street: 'Main Street 1',
          zipCode: '10115',
          phone: '+49 151 12345678',
        },
        pickupTimeSlot: '18:00-19:00',
        items: [
          { type: 'can', quantity: 3 },
          { type: 'pet', quantity: 10 },
          { type: 'water', quantity: 5 },
        ],
      },
    });
    expect(response.status()).toBe(201);
    const { id } = (await response.json()).data;
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/orders');
    await expect(page.getByRole('article').filter({ hasText: id })).toBeVisible();

    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(page.getByRole('heading', { name: 'Auftragsverlauf' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'New pickup' })).toHaveCount(0);
      const layout = await page.evaluate(() => {
        const brand = document.querySelector('.brand-title')!.getBoundingClientRect();
        const navigation = document.querySelector('.nav')!.getBoundingClientRect();
        const main = document.querySelector('main')!.getBoundingClientRect();
        const panel = document.querySelector('.panel')!.getBoundingClientRect();
        const order = document.querySelector('.order-card')!.getBoundingClientRect();
        return {
          viewportWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          brandCenter: (brand.top + brand.bottom) / 2,
          navigationCenter: (navigation.top + navigation.bottom) / 2,
          brandRight: brand.right,
          navigationLeft: navigation.left,
          mainLeft: main.left,
          mainRight: main.right,
          panelLeft: panel.left,
          panelRight: panel.right,
          orderLeft: order.left,
          orderRight: order.right,
        };
      });

      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(Math.abs(layout.brandCenter - layout.navigationCenter)).toBeLessThanOrEqual(1);
      expect(layout.brandRight).toBeLessThan(layout.navigationLeft);
      expect(layout.mainLeft).toBeGreaterThanOrEqual(0);
      expect(layout.mainRight).toBeLessThanOrEqual(width);
      expect(layout.panelLeft).toBeGreaterThanOrEqual(layout.mainLeft);
      expect(layout.panelRight).toBeLessThanOrEqual(layout.mainRight);
      expect(layout.orderLeft).toBeGreaterThanOrEqual(layout.panelLeft);
      expect(layout.orderRight).toBeLessThanOrEqual(layout.panelRight);
    }
  });

  test('serves the background image as a PNG', async ({ request }) => {
    const response = await request.get('/70b82787-b394-4168-9124-f1244fcbb843.png');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('image/png');
    expect((await response.body()).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  test('does not create duplicate orders for concurrent retries with the same idempotency key', async ({ request }) => {
    const headers = { 'Idempotency-Key': randomUUID() };
    const data = {
      customer: {
        firstName: 'Retry',
        lastName: 'Safe',
        street: 'Main Street 1',
        zipCode: '10115',
        phone: '+49 151 12345678',
      },
      pickupTimeSlot: '10:00-11:00',
      items: [{ type: 'pet', quantity: 2 }],
    };
    const responses = await Promise.all([
      request.post('/api/orders', { headers, data }),
      request.post('/api/orders', { headers, data }),
    ]);
    expect(responses.map((response) => response.status()).sort()).toEqual([200, 201]);
    const first = (await responses[0].json()).data;
    const second = (await responses[1].json()).data;
    expect(first.id).toBe(second.id);

    const history = (await (await request.get('/api/orders')).json()).data;
    expect(history.filter((order: { id: string }) => order.id === first.id)).toHaveLength(1);
  });

  test('rejects reusing an idempotency key for different order data', async ({ request }) => {
    const headers = { 'Idempotency-Key': randomUUID() };
    const data = {
      customer: {
        firstName: 'Same',
        lastName: 'Key',
        street: 'Main Street 1',
        zipCode: '10115',
        phone: '+49 151 12345678',
      },
      pickupTimeSlot: '10:00-11:00',
      items: [{ type: 'pet', quantity: 1 }],
    };
    const first = await request.post('/api/orders', { headers, data });
    expect(first.status()).toBe(201);
    const conflicting = await request.post('/api/orders', {
      headers,
      data: { ...data, pickupTimeSlot: '11:00-12:00' },
    });
    expect(conflicting.status()).toBe(409);
    await expect(conflicting.json()).resolves.toEqual({
      error: 'Idempotency-Key was already used with different order data',
    });
  });

  test('rejects invalid text, phone, pickup slot, bottle type, and quantity', async ({ request }) => {
    const validOrder = {
      customer: {
        firstName: 'Alex',
        lastName: 'Example',
        street: 'Main Street 1',
        zipCode: '10115',
        phone: '+49 151 12345678',
      },
      pickupTimeSlot: '10:00-11:00',
      items: [{ type: 'pet', quantity: 1 }],
    };
    const cases = [
      { order: { ...validOrder, customer: { ...validOrder.customer, firstName: 'Alex3' } }, error: 'First name must contain letters, spaces, apostrophes, or hyphens' },
      { order: { ...validOrder, customer: { ...validOrder.customer, lastName: '   ' } }, error: 'Last name is required and must be at most 100 characters' },
      { order: { ...validOrder, customer: { ...validOrder.customer, street: `Main Street\n1` } }, error: 'Street contains unsupported characters' },
      { order: { ...validOrder, customer: { ...validOrder.customer, phone: '12ab56' } }, error: 'Phone number is invalid' },
      { order: { ...validOrder, customer: { ...validOrder.customer, phone: '......' } }, error: 'Phone number is invalid' },
      { order: { ...validOrder, pickupTimeSlot: '22:00-23:00' }, error: 'Pickup time slot is invalid' },
      { order: { ...validOrder, items: [{ type: 'unknown', quantity: 1 }] }, error: 'Bottle category is invalid or duplicated' },
      { order: { ...validOrder, items: [{ type: 'pet', quantity: 0 }] }, error: 'Bottle quantity must be an integer between 1 and 1000' },
    ];

    for (const { order, error } of cases) {
      const response = await request.post('/api/orders', { headers: idempotencyHeaders(), data: order });
      expect(response.status(), error).toBe(400);
      await expect(response.json()).resolves.toEqual({ error });
    }
  });

  test('requires an idempotency key for order creation', async ({ request }) => {
    const response = await request.post('/api/orders', {
      data: {},
    });
    expect(response.status()).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'A valid Idempotency-Key UUID header is required',
    });

    const malformedKey = await request.post('/api/orders', {
      headers: { 'Idempotency-Key': 'not-a-uuid' },
      data: {},
    });
    expect(malformedKey.status()).toBe(400);
  });

  test('rejects invalid names in the browser without sending the order', async ({ page }) => {
    let orderRequestSent = false;
    await page.route('**/api/orders', async (route) => {
      orderRequestSent = true;
      await route.continue();
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await page.getByRole('button', { name: 'Add to Order' }).click();
    await page.getByRole('button', { name: 'Proceed to Address' }).click();
    await page.getByLabel('First Name *').fill('Alex3');
    await page.getByLabel('Last Name *').fill('Example');
    await page.getByLabel('Street & House Number *').fill('Main Street 1');
    await page.getByLabel('ZIP Code (PLZ) *').fill('10115');
    await page.getByLabel('Mobile Phone Number *').fill('+49 151 12345678');
    await page.getByLabel('Pickup Time Slot *').selectOption('10:00-11:00');
    await page.getByRole('button', { name: 'Confirm Pickup' }).click();

    await expect(page.locator('#fname')).toHaveAttribute('aria-invalid', 'true');
    await page.getByLabel('First Name *').fill('Alex');
    await page.getByLabel('Mobile Phone Number *').fill('12abc6');
    expect(await page.locator('#phone').evaluate((element) => (element as HTMLInputElement).validity.patternMismatch)).toBe(true);
    expect(await page.locator('#phone').evaluate((element) => (element as HTMLInputElement).validity.customError)).toBe(true);
    await page.getByRole('button', { name: 'Confirm Pickup' }).click();
    await expect(page.locator('#phone')).toHaveAttribute('aria-invalid', 'true');
    expect(orderRequestSent).toBe(false);
  });

  test('accepts international names in the browser and API', async ({ page }) => {
    let submittedOrder: Record<string, unknown> | undefined;
    await page.route('**/api/orders', async (route) => {
      submittedOrder = route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 'international-name-order',
            status: 'confirmed',
            pickupTimeSlot: '10:00-11:00',
            totalRefund: '0.25',
            items: [{ type: 'pet', quantity: 1, unitRefund: 0.25 }],
          },
        }),
      });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await page.getByRole('button', { name: 'Add to Order' }).click();
    await page.getByRole('button', { name: 'Proceed to Address' }).click();
    await page.getByLabel('First Name *').fill('Zoë');
    await page.getByLabel('Last Name *').fill('D’Arcy');
    await page.getByLabel('Street & House Number *').fill('Hauptstraße 12');
    await page.getByLabel('ZIP Code (PLZ) *').fill('10115');
    await page.getByLabel('Mobile Phone Number *').fill('+49 151 12345678');
    await page.getByLabel('Pickup Time Slot *').selectOption('10:00-11:00');
    await page.getByRole('button', { name: 'Confirm Pickup' }).click();

    await expect(page.getByRole('heading', { name: 'Order Confirmed!' })).toBeVisible();
    expect(submittedOrder).toEqual(expect.objectContaining({
      customer: expect.objectContaining({ firstName: 'Zoë', lastName: 'D’Arcy' }),
    }));
  });

  test('restores a valid cart and discards malformed session storage safely', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      sessionStorage.setItem('pfandCart', JSON.stringify([
        { id: 1, key: '<img src=x onerror=alert(1)>', rate: 1, qty: 1 },
        { id: 2, key: 'pet', rate: 100, qty: 2 },
        { id: 3, key: 'beer', rate: 0.08, qty: 0 },
      ]));
    });
    await page.reload();
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByText('2x PET Plastic Bottle (€0.25)')).toBeVisible();
    await expect(page.locator('#itemList img')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Proceed to Address' })).toBeVisible();
  });

  test('persists an order across application restarts', async () => {
    const port = await findAvailablePort();
    const databasePath = path.join(process.cwd(), 'test-results', `restart-${randomUUID()}.sqlite`);
    const serverPath = path.join(process.cwd(), 'app', 'server.js');
    const startServer = () => spawn(process.execPath, [serverPath], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), PULSE_DB_PATH: databasePath },
      stdio: 'ignore',
    });
    const waitForServer = async (child: ReturnType<typeof startServer>) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`Test server exited with code ${child.exitCode}`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          if (response.ok) return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      throw new Error('Test server did not become ready');
    };
    const stopServer = async (child: ReturnType<typeof startServer>) => {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    };

    let child = startServer();
    try {
      await waitForServer(child);
      const createResponse = await fetch(`http://127.0.0.1:${port}/api/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({
          customer: {
            firstName: 'Persistent',
            lastName: 'Order',
            street: 'Main Street 1',
            zipCode: '10115',
            phone: '+49 151 12345678',
          },
          pickupTimeSlot: '10:00-11:00',
          items: [{ type: 'beer', quantity: 2 }],
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()).data;
      await stopServer(child);

      child = startServer();
      await waitForServer(child);
      const getResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${created.id}`);
      expect(getResponse.status).toBe(200);
      const retrieved = (await getResponse.json()).data;
      expect(retrieved.id).toBe(created.id);
      expect(retrieved.items).toEqual([{ type: 'beer', quantity: 2, unitRefund: 0.08 }]);
    } finally {
      await stopServer(child);
      await rm(databasePath, { force: true });
    }
  });
});
