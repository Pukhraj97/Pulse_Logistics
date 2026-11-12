import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
  test('animates quantity controls without allowing a quantity below one', async ({ page }) => {
    await page.goto('/');

    const decrease = page.getByRole('button', { name: 'Decrease quantity' });
    const increase = page.getByRole('button', { name: 'Increase quantity' });
    const quantity = page.locator('#qty');

    await decrease.click();
    await expect(quantity).toHaveValue('1');
    await expect(decrease).toHaveClass(/qty-animating/);
    await expect(decrease).not.toHaveClass(/qty-animating/);

    await increase.click();
    await expect(quantity).toHaveValue('2');
    await expect(increase).toHaveClass(/qty-animating/);
  });

  test('shows two-digit quantities and caps each bottle category at 50', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/');
    await page.getByRole('button', { name: 'EN', exact: true }).click();

    const quantity = page.locator('#qty');
    const increase = page.getByRole('button', { name: 'Increase quantity' });
    await expect(quantity).toHaveCSS('padding', '0px');
    for (let count = 1; count < 10; count += 1) await increase.click();
    await expect(quantity).toHaveValue('10');
    await increase.evaluate((button) => {
      for (let count = 10; count < 50; count += 1) (button as HTMLButtonElement).click();
    });
    await expect(quantity).toHaveValue('50');
    await increase.click();
    await expect(quantity).toHaveValue('50');

    await page.getByRole('button', { name: 'Add to Order' }).click();
    await expect(page.getByText('50x PET Plastic Bottle (€0.25)')).toBeVisible();
  });

  test('shows rounded custom menus for bottle type and pickup time', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'EN', exact: true }).click();

    await page.getByRole('combobox', { name: 'Select Bottle Category' }).click();
    await expect(page.locator('#bottleType-options')).toHaveCSS('border-radius', '12px');
    await page.getByRole('option', { name: 'Glass Beer Bottle (€0.08)' }).click();
    await expect(page.getByRole('combobox', { name: 'Select Bottle Category' })).toContainText('Glass Beer Bottle');

    await page.getByRole('button', { name: 'Add to Order' }).click();
    await page.getByRole('button', { name: 'Proceed to Address' }).click();
    const timeSlot = page.getByRole('combobox', { name: 'Pickup Time Slot *' });
    await timeSlot.click();
    await expect(page.locator('#timeSlot-options')).toHaveCSS('border-radius', '12px');
    await timeSlot.press('ArrowDown');
    await timeSlot.press('Enter');
    await expect(timeSlot).toContainText('10:00–11:00');
  });

  test('preserves the selected Consumer app language after reload', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByRole('heading', { name: '1. Bottle Selection' })).toBeVisible();
    await page.reload();

    await expect(page.getByRole('button', { name: 'EN', exact: true })).toHaveClass(/active/);
    await expect(page.getByRole('button', { name: 'DE', exact: true })).not.toHaveClass(/active/);
    await expect(page.getByRole('heading', { name: '1. Bottle Selection' })).toBeVisible();
  });

  test('selecting Aluminum Can adds a can instead of PET bottles', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    const bottleType = page.getByRole('combobox', { name: 'Select Bottle Category' });
    await bottleType.click();
    await page.getByRole('option', { name: 'Aluminum Can (€0.25)' }).click();

    await expect(bottleType).toContainText('Aluminum Can');
    await expect(page.locator('#bottleType')).toHaveValue('can');
    await page.getByRole('button', { name: 'Add to Order' }).click();
    await expect(page.getByText('1x Aluminum Can (€0.25)')).toBeVisible();
    await expect(page.getByText('1x PET Plastic Bottle (€0.25)')).toHaveCount(0);
  });

  test('hovering over a cart remove button does not reveal a horizontal scrollbar', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    const bottleType = page.getByRole('combobox', { name: 'Select Bottle Category' });
    await bottleType.click();
    await page.getByRole('option', { name: 'Aluminum Can (€0.25)' }).click();
    for (let quantity = 1; quantity < 6; quantity += 1) {
      await page.getByRole('button', { name: 'Increase quantity' }).click();
    }
    await page.getByRole('button', { name: 'Add to Order' }).click();

    const cart = page.locator('#itemList');
    await expect(cart.locator('.item-row')).toBeVisible();
    const dimensionsBeforeHover = await cart.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    await page.getByRole('button', { name: 'Remove item' }).hover();
    const dimensionsAfterHover = await cart.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));

    expect(dimensionsBeforeHover.scrollWidth).toBeLessThanOrEqual(dimensionsBeforeHover.clientWidth);
    expect(dimensionsAfterHover.scrollWidth).toBeLessThanOrEqual(dimensionsAfterHover.clientWidth);
  });

  test('browser Back returns from delivery details to bottle selection', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await page.getByRole('button', { name: 'Add to Order' }).click();
    await page.getByRole('button', { name: 'Proceed to Address' }).click();

    await expect(page.getByRole('heading', { name: '2. Delivery & Address' })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByRole('heading', { name: '2. Delivery & Address' })).toBeVisible();

    await page.goBack();
    await expect(page.getByRole('heading', { name: '1. Bottle Selection' })).toBeVisible();

    await page.goForward();
    await expect(page.getByRole('heading', { name: '2. Delivery & Address' })).toBeVisible();
  });

  test('submits the bottle basket and page-two contact details', async ({ page }) => {
    let submittedOrder: Record<string, unknown> | undefined;
    await page.route('**/api/orders', async (route) => {
      submittedOrder = route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: '1234',
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
    await expect(page.locator('#timeSlot')).toHaveValue('');
    await expect(page.getByRole('combobox', { name: 'Pickup Time Slot *' })).toContainText('Select a pickup time');
    await page.getByLabel('First Name *').fill('Alex');
    await page.getByLabel('Last Name *').fill('Example');
    await page.getByLabel('Street & House Number *').fill('Main Street 1');
    await page.getByLabel('ZIP Code (PLZ) *').fill('10115');
    await page.getByLabel('Mobile Phone Number *').fill('+49 151 12345678');
    await page.getByLabel('IBAN *').fill('DE89370400440532013000');
    await page.getByRole('combobox', { name: 'Pickup Time Slot *' }).click();
    await page.getByRole('option', { name: '10:00–11:00' }).click();
    await page.getByRole('button', { name: 'Confirm Pickup' }).click();

    await expect(page.getByRole('heading', { name: 'Order Confirmed!' })).toBeVisible();
    await expect(page.locator('#t-step3-title')).toHaveText('Order Confirmed!');
    await expect(page.locator('#t-step3-msg')).toHaveJSProperty(
      'innerText',
      'Thank you. Your doorstep Pfand pickup request has been scheduled.\n\n' +
        'A cargo bike courier will arrive during your selected window.\n\n' +
        'Selected pickup time: 10:00–11:00.\n\n' +
        'Order reference: #1234.\n\n' +
        'The payment will be sent to the IBAN you provided within 24 hours.',
    );
    await expect(page.locator('#t-step3-msg-pickup-value')).toHaveText('10:00–11:00.');
    await expect(page.locator('#t-step3-msg-order-value')).toHaveText('#1234.');
    const paymentLine = page.locator('#t-step3-msg-payment');
    await expect(paymentLine).toHaveText(
      'The payment will be sent to the IBAN you provided within 24 hours.',
    );
    await expect(paymentLine.locator('strong')).toHaveText(['IBAN', '24 hours']);
    await expect(paymentLine.locator('strong').nth(0)).toHaveCSS('font-weight', '700');
    await page.getByRole('button', { name: 'DE', exact: true }).click();
    await expect(page.locator('#t-step3-msg-order')).toHaveText('Auftragsnummer: ');
    await expect(page.locator('#t-step3-msg-order-value')).toHaveText('#1234.');
    await expect(paymentLine).toHaveText(
      'Die Zahlung wird innerhalb von 24 Stunden auf die von Ihnen angegebene IBAN überwiesen.',
    );
    await expect(paymentLine.locator('strong')).toHaveText(['24 Stunden', 'IBAN']);
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.locator('#t-step3-msg strong')).toHaveCount(4);
    await page.goBack();
    await expect(page.getByRole('dialog')).toContainText(
      'Your Order is Confirmed! You can Schedule a new order by clicking on "Schedule Another Pickup"',
    );
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByRole('heading', { name: 'Order Confirmed!' })).toBeVisible();
    await page.getByRole('button', { name: 'Schedule Another Pickup' }).click();
    await expect(page.getByRole('heading', { name: '1. Bottle Selection' })).toBeVisible();
    await page.getByRole('button', { name: 'Add to Order' }).click();
    await page.getByRole('button', { name: 'Proceed to Address' }).click();
    await expect(page.locator('#timeSlot')).toHaveValue('');
    await expect(page.getByRole('combobox', { name: 'Pickup Time Slot *' })).toContainText('Select a pickup time');
    await page.goBack();
    await expect(page.getByRole('heading', { name: '1. Bottle Selection' })).toBeVisible();
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
        iban: 'DE89370400440532013000',
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
    await page.getByLabel('IBAN *').fill('DE89370400440532013000');
    await page.getByRole('combobox', { name: 'Pickup Time Slot *' }).click();
    await page.getByRole('option', { name: '10:00–11:00' }).click();
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
        customer: {
          firstName: 'Alex',
          lastName: 'Example',
          street: 'Main Street 1',
          zipCode: 'bad',
          phone: '+49 151 12345678',
          iban: 'DE89370400440532013000',
        },
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
          iban: 'DE89370400440532013000',
        },
        pickupTimeSlot: '10:00-11:00',
        items: [{ type: 'pet', quantity: 50 }],
      },
    });
    expect(response.status()).toBe(201);
    await expect(response.json()).resolves.toEqual({
      data: {
        id: expect.stringMatching(/^[0-9]{4}$/),
        status: 'confirmed',
        pickupTimeSlot: '10:00-11:00',
        totalRefund: '12.50',
        items: [{ type: 'pet', quantity: 50, unitRefund: 0.25 }],
        dispatch: { notifiedDrivers: 0 },
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
          iban: 'DE89370400440532013000',
        },
        pickupTimeSlot: '12:00-13:00',
        items: [{ type: 'beer', quantity: 3 }],
      },
    });

    expect(response.status()).toBe(201);
    const created = (await response.json()).data;
    expect(created).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^[0-9]{4}$/),
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
    expect(retrieved).not.toHaveProperty('iban');
    expect(retrieved).not.toHaveProperty('customer');
  });

  test('dispatches new orders to online drivers and allows only one driver to accept', async ({ page }) => {
    const port = await findAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const databasePath = path.join(process.cwd(), 'test-results', `drivers-${randomUUID()}.sqlite`);
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
          if ((await fetch(`${baseUrl}/health`)).ok) return;
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
    const callApi = async (route: string, method: string, body?: unknown, token?: string) => {
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(route === '/api/orders' ? { 'Idempotency-Key': randomUUID() } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    };

    let child = startServer();
    try {
      await waitForServer(child);
      expect((await callApi('/api/orders', 'GET')).status).toBe(200);
      await stopServer(child);
      const secondToken = randomUUID();
      const secondTokenHash = createHash('sha256').update(secondToken).digest('hex');
      const seedDriverScript = `
        const fs = require('node:fs');
        const initSqlJs = require('sql.js');
        (async () => {
          const SQL = await initSqlJs({
            locateFile: (fileName) => require.resolve(\`sql.js/dist/\${fileName}\`),
          });
          const database = new SQL.Database(fs.readFileSync(process.argv[1]));
          database.run(
            "INSERT INTO drivers (id, name, username, vehicle_type, token_hash) VALUES (?, ?, ?, 'cargo-bike', ?)",
            [process.argv[2], 'Courier Two', 'CourierTwo', process.argv[3]],
          );
          fs.writeFileSync(process.argv[1], Buffer.from(database.export()));
        })().catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
      `;
      execFileSync(process.execPath, [
        '-e', seedDriverScript, databasePath, randomUUID(), secondTokenHash,
      ], { cwd: process.cwd() });
      child = startServer();
      await waitForServer(child);

      const invalidLogin = await callApi('/api/drivers/login', 'POST', {
        username: 'James',
        password: 'wrong',
      });
      expect(invalidLogin).toEqual({
        status: 401,
        data: { error: 'Invalid username or password' },
      });
      await page.goto(`${baseUrl}/driver`);
      await expect(page.locator('.brand-title')).toHaveText('PULSE LOGISTICS');
      await expect(page.locator('.brand-mark')).toHaveCount(0);
      await expect(page.getByRole('link', { name: /Consumer app/ })).toHaveCount(0);
      await expect(page.locator('#vehicle-type')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'EN', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'DE', exact: true })).toBeVisible();
      await expect(page.locator('#login-title')).toHaveText('Fahrer-Anmeldung');
      await page.getByRole('button', { name: 'EN', exact: true }).click();
      await expect(page.locator('#login-title')).toHaveText('Driver login');
      await page.locator('#username').fill('James');
      await page.locator('#password').fill('wrong');
      await page.locator('#login-button').click();
      await expect(page.locator('#login-error')).toHaveText('Incorrect username or password.');
      await page.locator('#password').fill('genius');
      const driverStatusResponsePromise = page.waitForResponse((response) =>
        new URL(response.url()).pathname === '/api/drivers/driverStatus');
      await page.locator('#login-button').click();
      const driverStatusResponse = await driverStatusResponsePromise;
      expect(driverStatusResponse.status()).toBe(200);
      await expect(page.locator('#dashboard')).toBeVisible();
      await expect(page.locator('#login-panel')).toBeHidden();
      await expect(page.locator('#driver-profile-name')).toContainText('James');
      await expect(page.locator('#logout-button')).toBeVisible();
      await expect(page.locator('#logout-button')).toHaveCSS('background-color', 'rgb(74, 141, 82)');
      const logoutIsAboveToggle = await page.locator('#logout-button').evaluate((button) => {
        const buttonBounds = button.getBoundingClientRect();
        const toggleBounds = document.querySelector('#presence-toggle')!.getBoundingClientRect();
        return buttonBounds.bottom <= toggleBounds.top;
      });
      expect(logoutIsAboveToggle).toBe(true);
      const firstToken = await page.evaluate(() => localStorage.getItem('pulse-driver-token'));
      if (!firstToken) throw new Error('Driver login did not save its token');
      const first = { token: firstToken };
      const second = { token: secondToken };
      const nextDriverStatusRequest = await page.waitForRequest((request) =>
        new URL(request.url()).pathname === '/api/drivers/driverStatus', { timeout: 5000 });
      expect(nextDriverStatusRequest.method()).toBe('GET');
      await page.reload();
      await expect(page.locator('#dashboard')).toBeVisible();
      await expect(page.locator('#driver-profile-name')).toContainText('James');
      for (const width of [360, 420, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${baseUrl}/driver`);
        const driverLogo = await page.locator('.brand-title').evaluate((logo) => {
          const style = getComputedStyle(logo);
          const box = logo.getBoundingClientRect();
          const header = document.querySelector('header')!.getBoundingClientRect();
          return {
            style: {
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              color: style.color,
              letterSpacing: style.letterSpacing,
              textShadow: style.textShadow,
              textAlign: style.textAlign,
            },
            left: box.left,
            topSpacing: box.top - header.top,
            bottomSpacing: header.bottom - box.bottom,
            headerHeight: header.height,
          };
        });
        await page.goto(`${baseUrl}/`);
        const consumerLogo = await page.locator('.brand-title').evaluate((logo) => {
          const style = getComputedStyle(logo);
          const box = logo.getBoundingClientRect();
          const header = document.querySelector('header')!.getBoundingClientRect();
          return {
            style: {
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              color: style.color,
              letterSpacing: style.letterSpacing,
              textShadow: style.textShadow,
              textAlign: style.textAlign,
            },
            left: box.left,
            headerHeight: header.height,
          };
        });
        expect(driverLogo.style).toEqual(consumerLogo.style);
        expect(driverLogo.left).toBe(consumerLogo.left);
        expect(driverLogo.headerHeight).toBe(consumerLogo.headerHeight);
        expect(Math.abs(driverLogo.topSpacing - driverLogo.bottomSpacing)).toBeLessThanOrEqual(1);
      }
      expect((await callApi('/api/drivers/driverStatus', 'GET')).status).toBe(401);
      for (const token of [first.token, second.token]) {
        const online = await callApi('/api/drivers/driverStatus/presence', 'PATCH', { online: true }, token);
        expect(online).toEqual({ status: 200, data: { data: { online: true } } });
      }

      const createdResponse = await callApi('/api/orders', 'POST', {
        customer: {
          firstName: 'Map',
          lastName: 'Pickup',
          street: 'Main Street 1',
          zipCode: '10115',
          phone: '+49 151 12345678',
          iban: 'DE89370400440532013000',
        },
        pickupTimeSlot: '12:00-13:00',
        items: [{ type: 'pet', quantity: 2 }],
      });
      expect(createdResponse.status).toBe(201);
      const created = createdResponse.data.data;
      expect(created.dispatch).toEqual({ notifiedDrivers: 2 });

      const firstProfile = await callApi('/api/drivers/driverStatus', 'GET', undefined, first.token);
      const secondProfile = await callApi('/api/drivers/driverStatus', 'GET', undefined, second.token);
      const firstOffer = firstProfile.data.data.pendingOrders.find((offer: { id: string }) => offer.id === created.id);
      expect(firstOffer).toEqual(expect.objectContaining({
        id: created.id,
        customerName: 'Map Pickup',
        address: 'Main Street 1, 10115, Germany',
        mapsUrl: 'https://www.google.com/maps/dir/?api=1&destination=Main%20Street%201%2C%2010115%2C%20Germany',
      }));
      expect(firstOffer).not.toHaveProperty('iban');
      expect(firstOffer).not.toHaveProperty('phone');
      expect(firstProfile.data.data.acceptedOrders).toEqual([]);
      expect(firstProfile.data.data.missedOrders).toEqual([]);
      expect(Date.parse(firstOffer.expiresAt) - Date.parse(firstOffer.offeredAt)).toBe(60_000);
      expect(secondProfile.data.data.pendingOrders.some((offer: { id: string }) => offer.id === created.id)).toBe(true);

      await page.addInitScript((token) => localStorage.setItem('pulse-driver-token', token), first.token);
      await page.goto(`${baseUrl}/driver`);
      await page.getByRole('button', { name: 'EN', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Your requests' })).toBeVisible();
      const switchSize = await page.locator('#presence-toggle').evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const knob = getComputedStyle(button, '::after');
        return {
          width: bounds.width,
          height: bounds.height,
          padding: getComputedStyle(button).padding,
          knobWidth: knob.width,
          knobHeight: knob.height,
        };
      });
      expect(switchSize).toEqual({
        width: 56,
        height: 32,
        padding: '0px',
        knobWidth: '24px',
        knobHeight: '24px',
      });
      const targetOffer = page.locator('.offer').filter({ hasText: `Pickup #${created.id}` });
      await expect(targetOffer).toBeVisible();
      await expect(targetOffer.getByText('Customer: Map Pickup')).toBeVisible();
      await expect(targetOffer.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '60');
      await expect(targetOffer.getByRole('link', { name: /Open pickup in Google Maps/ })).toHaveAttribute(
        'href',
        firstOffer.mapsUrl,
      );
      await page.getByRole('button', { name: 'DE', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Ihre Anfragen' })).toBeVisible();
      await expect(page.getByText('Sie sind online')).toBeVisible();
      const germanOffer = page.locator('.offer').filter({ hasText: `Abholung #${created.id}` });
      await expect(germanOffer.getByRole('button', { name: 'Abholung annehmen' })).toBeVisible();
      await expect(germanOffer.getByRole('link', { name: /Abholadresse in Google Maps öffnen/ })).toBeVisible();
      await page.getByRole('button', { name: 'EN', exact: true }).click();
      await targetOffer.getByRole('button', { name: 'Accept pickup' }).click();
      await expect(page.getByRole('status')).toContainText(`Pickup #${created.id} accepted`);

      const activeCard = page.locator('.active-order').filter({ hasText: `Active pickup #${created.id}` });
      await expect(activeCard).toBeVisible();
      await expect(activeCard.getByText('Customer: Map Pickup')).toBeVisible();
      await expect(activeCard.getByRole('button', { name: 'Complete pickup' })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Your requests' })).toBeVisible();
      await expect(activeCard).toBeVisible();
      await page.waitForTimeout(1100);
      await expect(activeCard.locator('.countdown')).toHaveText('Accepted');
      expect(pageErrors).toEqual([]);

      const unavailable = await callApi(
        `/api/drivers/driverStatus/pendingOrders/${created.id}/accept`,
        'POST',
        undefined,
        second.token,
      );
      expect(unavailable.status).toBe(409);
      const secondOrderResponse = await callApi('/api/orders', 'POST', {
        customer: {
          firstName: 'Map',
          lastName: 'Pickup',
          street: 'Second Street 2',
          zipCode: '10115',
          phone: '+49 151 12345678',
          iban: 'DE89370400440532013000',
        },
        pickupTimeSlot: '13:00-14:00',
        items: [{ type: 'can', quantity: 1 }],
      });
      expect(secondOrderResponse.status).toBe(201);
      const secondOrder = secondOrderResponse.data.data;
      expect(secondOrder.dispatch).toEqual({ notifiedDrivers: 1 });
      const busyProfile = await callApi('/api/drivers/driverStatus', 'GET', undefined, first.token);
      expect(busyProfile.data.data.activeOrder.id).toBe(created.id);
      expect(busyProfile.data.data.pendingOrders.some((offer: { id: string }) => offer.id === secondOrder.id)).toBe(false);
      const busyAccept = await callApi(
        `/api/drivers/driverStatus/pendingOrders/${secondOrder.id}/accept`,
        'POST',
        undefined,
        first.token,
      );
      expect(busyAccept).toEqual({
        status: 409,
        data: { error: 'You already have an active order' },
      });

      await activeCard.getByRole('button', { name: 'Complete pickup' }).click();
      const completionDialog = page.getByRole('dialog', { name: 'Complete pickup?' });
      await expect(completionDialog).toBeVisible();
      await expect(completionDialog).toContainText('Are you sure this pickup is complete?');
      await completionDialog.getByRole('button', { name: 'No, go back' }).click();
      await expect(completionDialog).toBeHidden();
      await expect(activeCard).toBeVisible();
      expect((await callApi('/api/drivers/driverStatus', 'GET', undefined, first.token))
        .data.data.activeOrder.id).toBe(created.id);

      await activeCard.getByRole('button', { name: 'Complete pickup' }).click();
      await expect(completionDialog).toBeVisible();
      const completionResponsePromise = page.waitForResponse((response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/drivers/driverStatus/orders/${created.id}/complete`);
      await completionDialog.getByRole('button', { name: 'Yes, complete' }).click();
      const completionResponse = await completionResponsePromise;
      expect(completionResponse.status()).toBe(200);
      await expect(page.getByRole('status')).toContainText(`Pickup #${created.id} marked complete`);
      await expect(activeCard).toHaveCount(0);
      const repeatedCompletion = await callApi(
        `/api/drivers/driverStatus/orders/${created.id}/complete`,
        'POST',
        undefined,
        first.token,
      );
      expect(repeatedCompletion.status).toBe(409);
      const completedProfile = await callApi('/api/drivers/driverStatus', 'GET', undefined, first.token);
      expect(completedProfile.data.data.acceptedOrders).toEqual([
        expect.objectContaining({ id: created.id, status: 'completed' }),
      ]);

      const thirdOrderResponse = await callApi('/api/orders', 'POST', {
        customer: {
          firstName: 'Map',
          lastName: 'Pickup',
          street: 'Third Street 3',
          zipCode: '10115',
          phone: '+49 151 12345678',
          iban: 'DE89370400440532013000',
        },
        pickupTimeSlot: '14:00-15:00',
        items: [{ type: 'pet', quantity: 1 }],
      });
      expect(thirdOrderResponse.status).toBe(201);
      const thirdOrder = thirdOrderResponse.data.data;
      expect(thirdOrder.dispatch).toEqual({ notifiedDrivers: 2 });
      const availableAgain = await callApi(
        `/api/drivers/driverStatus/pendingOrders/${thirdOrder.id}/accept`,
        'POST',
        undefined,
        first.token,
      );
      expect(availableAgain).toEqual({
        status: 200,
        data: { data: { orderId: thirdOrder.id, status: 'accepted' } },
      });
      const finalProfile = await callApi('/api/drivers/driverStatus', 'GET', undefined, first.token);
      expect(finalProfile.data.data.activeOrder.id)
        .toBe(thirdOrder.id);
      expect(finalProfile.data.data.acceptedOrders).toHaveLength(1);

      await stopServer(child);
      const expireOfferScript = `
        const fs = require('node:fs');
        const initSqlJs = require('sql.js');
        (async () => {
          const SQL = await initSqlJs({
            locateFile: (fileName) => require.resolve(\`sql.js/dist/\${fileName}\`),
          });
          const databasePath = process.argv[1];
          const database = new SQL.Database(fs.readFileSync(databasePath));
          database.run(
            "UPDATE driver_order_offers SET expires_at = ?, missed_at = NULL WHERE order_id = ? AND status = 'pending'",
            [new Date(0).toISOString(), process.argv[2]],
          );
          fs.writeFileSync(databasePath, Buffer.from(database.export()));
        })().catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
      `;
      execFileSync(process.execPath, ['-e', expireOfferScript, databasePath, secondOrder.id], {
        cwd: process.cwd(),
      });
      child = startServer();
      await waitForServer(child);
      const missedProfile = await callApi('/api/drivers/driverStatus', 'GET', undefined, second.token);
      expect(missedProfile.status).toBe(200);
      expect(missedProfile.data.data.pendingOrders).toEqual([]);
      expect(missedProfile.data.data.missedOrders).toEqual([
        expect.objectContaining({ id: secondOrder.id, status: 'missed', missedAt: expect.any(String) }),
      ]);

      const onlineBeforeLogout = await callApi(
        '/api/drivers/driverStatus/presence',
        'PATCH',
        { online: true },
        first.token,
      );
      expect(onlineBeforeLogout.status).toBe(200);
      await page.goto(`${baseUrl}/driver`);
      await expect(page.locator('#dashboard')).toBeVisible();
      await expect(page.locator('#logout-button')).toBeVisible();
      await expect(page.locator('#dashboard')).toHaveCSS('animation-name', 'auth-view-enter');
      await page.locator('#logout-button').click();
      const logoutConfirmation = page.getByRole('dialog', { name: 'Log out?' });
      await expect(logoutConfirmation).toBeVisible();
      await expect(logoutConfirmation).toHaveCSS('animation-name', 'logout-confirm-in');
      await expect(logoutConfirmation).toContainText('Are you sure you want to log out?');
      await logoutConfirmation.getByRole('button', { name: 'No, stay logged in' }).click();
      await expect(logoutConfirmation).toBeHidden();
      await expect(page.locator('#dashboard')).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem('pulse-driver-token'))).toBe(first.token);
      expect((await callApi('/api/drivers/driverStatus', 'GET', undefined, first.token)).status).toBe(200);

      await page.locator('#logout-button').click();
      await expect(logoutConfirmation).toBeVisible();
      const logoutResponsePromise = page.waitForResponse((response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/drivers/logout');
      await logoutConfirmation.getByRole('button', { name: 'Yes, log out' }).click();
      const logoutResponse = await logoutResponsePromise;
      expect(logoutResponse.status()).toBe(200);
      await expect(page.locator('#login-panel')).toBeVisible();
      await expect(page.locator('#login-panel')).toHaveCSS('animation-name', 'auth-view-enter');
      await expect(page.locator('#dashboard')).toBeHidden();
      expect(await page.evaluate(() => localStorage.getItem('pulse-driver-token'))).toBeNull();
      expect((await callApi('/api/drivers/driverStatus', 'GET', undefined, first.token)).status).toBe(401);

      const reLogin = await callApi('/api/drivers/login', 'POST', {
        username: 'James',
        password: 'genius',
      });
      expect(reLogin.status).toBe(200);
      const reLoginToken = reLogin.data.data.token;
      const reLoginProfile = await callApi('/api/drivers/driverStatus', 'GET', undefined, reLoginToken);
      expect(reLoginProfile.data.data.driver.online).toBe(false);
      expect(reLoginProfile.data.data.activeOrder.id).toBe(thirdOrder.id);
      expect(pageErrors).toEqual([]);
    } finally {
      await stopServer(child);
      await rm(databasePath, { force: true });
    }
  });

  test('generates a distinct four-digit reference for each new order', async ({ request }) => {
    const data = {
      customer: {
        firstName: 'Unique',
        lastName: 'Reference',
        street: 'Main Street 1',
        zipCode: '10115',
        phone: '+49 151 12345678',
        iban: 'DE89370400440532013000',
      },
      pickupTimeSlot: '12:00-13:00',
      items: [{ type: 'beer', quantity: 1 }],
    };

    const firstResponse = await request.post('/api/orders', {
      headers: idempotencyHeaders(),
      data,
    });
    const secondResponse = await request.post('/api/orders', {
      headers: idempotencyHeaders(),
      data,
    });
    expect(firstResponse.status()).toBe(201);
    expect(secondResponse.status()).toBe(201);

    const firstId = (await firstResponse.json()).data.id;
    const secondId = (await secondResponse.json()).data.id;
    expect(firstId).toMatch(/^[0-9]{4}$/);
    expect(secondId).toMatch(/^[0-9]{4}$/);
    expect(secondId).not.toBe(firstId);
    expect((await request.get(`/api/orders/${secondId}`)).status()).toBe(200);
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
          iban: 'DE89370400440532013000',
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
    expect(savedOrder).not.toHaveProperty('iban');
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
          iban: 'DE89370400440532013000',
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
    await expect(savedOrder.getByText(`Referenz: #${id}`)).toBeVisible();
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
          iban: 'DE89370400440532013000',
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
        iban: 'DE89370400440532013000',
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
        iban: 'DE89370400440532013000',
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
        iban: 'DE89370400440532013000',
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
      { order: { ...validOrder, customer: { ...validOrder.customer, iban: '' } }, error: 'IBAN is required and must be at most 34 characters' },
      { order: { ...validOrder, customer: { ...validOrder.customer, iban: 'DE 89370400440532013000' } }, error: 'IBAN is invalid' },
      { order: { ...validOrder, pickupTimeSlot: '22:00-23:00' }, error: 'Pickup time slot is invalid' },
      { order: { ...validOrder, items: [{ type: 'unknown', quantity: 1 }] }, error: 'Bottle category is invalid or duplicated' },
      { order: { ...validOrder, items: [{ type: 'pet', quantity: 0 }] }, error: 'Bottle quantity must be an integer between 1 and 50' },
      { order: { ...validOrder, items: [{ type: 'water', quantity: 51 }] }, error: 'Bottle quantity must be an integer between 1 and 50' },
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
    await page.getByLabel('IBAN *').fill('DE89370400440532013000');
    await page.getByRole('combobox', { name: 'Pickup Time Slot *' }).click();
    await page.getByRole('option', { name: '10:00–11:00' }).click();
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

  test('updates existing client-side validation messages immediately when language changes', async ({ page }) => {
    let orderRequestSent = false;
    await page.route('**/api/orders', async (route) => {
      orderRequestSent = true;
      await route.continue();
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await page.getByRole('button', { name: 'Add to Order' }).click();
    await page.getByRole('button', { name: 'Proceed to Address' }).click();

    await page.getByRole('button', { name: 'Confirm Pickup' }).click();
    const firstName = page.locator('#fname');
    await expect(firstName).toHaveAttribute('aria-invalid', 'true');
    await expect.poll(() => firstName.evaluate((input) => (input as HTMLInputElement).validationMessage))
      .toBe('This field is required.');

    await page.getByRole('button', { name: 'DE', exact: true }).click();
    await expect.poll(() => firstName.evaluate((input) => (input as HTMLInputElement).validationMessage))
      .toBe('Dieses Feld ist erforderlich.');
    await page.getByRole('button', { name: 'Abholung Bestätigen' }).click();
    await expect.poll(() => firstName.evaluate((input) => (input as HTMLInputElement).validationMessage))
      .toBe('Dieses Feld ist erforderlich.');
    expect(orderRequestSent).toBe(false);
  });

  test('validates IBAN minimum, maximum, and character format in the browser', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await page.getByRole('button', { name: 'Add to Order' }).click();
    await page.getByRole('button', { name: 'Proceed to Address' }).click();

    const iban = page.getByLabel('IBAN *');
    await expect(iban).toHaveAttribute('minlength', '15');
    await expect(iban).toHaveAttribute('maxlength', '34');
    await expect(iban).toHaveAttribute('required', '');

    await iban.fill(`DE12${'1'.repeat(10)}`);
    await expect(iban).toHaveAttribute('aria-invalid', 'true');
    expect(await iban.evaluate((input) => (input as HTMLInputElement).validity.customError)).toBe(true);

    await iban.fill(`DE12${'1'.repeat(11)}`);
    await expect(iban).toHaveAttribute('aria-invalid', 'false');
    expect(await iban.evaluate((input) => (input as HTMLInputElement).validity.valid)).toBe(true);

    await iban.fill(`DE12${'1'.repeat(30)}`);
    await expect(iban).toHaveAttribute('aria-invalid', 'false');
    await iban.evaluate((input) => {
      const field = input as HTMLInputElement;
      field.value = `DE12${'1'.repeat(31)}`;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(iban).toHaveAttribute('aria-invalid', 'true');
    expect(await iban.evaluate((input) => (input as HTMLInputElement).validity.customError)).toBe(true);

    await iban.fill(`DE1A${'1'.repeat(11)}`);
    await expect(iban).toHaveAttribute('aria-invalid', 'true');
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
    await page.getByLabel('IBAN *').fill('DE89370400440532013000');
    await page.getByRole('combobox', { name: 'Pickup Time Slot *' }).click();
    await page.getByRole('option', { name: '10:00–11:00' }).click();
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
            iban: 'DE89370400440532013000',
          },
          pickupTimeSlot: '10:00-11:00',
          items: [{ type: 'beer', quantity: 2 }],
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()).data;
      await stopServer(child);
      const readIbanScript = `
        const fs = require('node:fs');
        const initSqlJs = require('sql.js');
        (async () => {
          const SQL = await initSqlJs({
            locateFile: (fileName) => require.resolve(\`sql.js/dist/\${fileName}\`),
          });
          const database = new SQL.Database(fs.readFileSync(process.argv[1]));
          const statement = database.prepare('SELECT iban FROM pickup_orders WHERE id = ?');
          statement.bind([process.argv[2]]);
          if (!statement.step()) throw new Error('Stored order was not found');
          console.log(statement.getAsObject().iban);
          statement.free();
          database.close();
        })().catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
      `;
      const storedIban = execFileSync(
        process.execPath,
        ['-e', readIbanScript, databasePath, created.id],
        { cwd: process.cwd(), encoding: 'utf8' },
      ).trim();
      expect(storedIban).toBe('DE89370400440532013000');

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
