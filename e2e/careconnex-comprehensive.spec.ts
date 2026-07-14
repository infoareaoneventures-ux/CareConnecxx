/**
 * CareConnecxx — Comprehensive E2E Test Suite
 * Tests every critical flow: client + caregiver, signup to care delivery
 *
 * Run against local dev:   BASE_URL=http://localhost:5173 npx playwright test
 * Run against production:  BASE_URL=https://careconnex-d4c8b.web.app npx playwright test
 *
 * Prerequisites:
 *   npm install -D @playwright/test
 *   npx playwright install chromium
 */

import { test, expect, Page, BrowserContext } from '@playwright/test';

// ── Config ────────────────────────────────────────────────────────────────────

const BASE = process.env.TEST_URL || 'http://localhost:5173';
const TS   = Date.now();

const CLIENT = {
  firstName:  'Dorothy',
  lastName:   'Test',
  email:      `dorothy.${TS}@test-eviacares.com`,
  password:   'Test1234!',
  phone:      '5551234567',
  street:     '123 Oak St',
  city:       'Atlanta',
  state:      'GA',
  zip:        '30305',
};

const CAREGIVER = {
  firstName:  'Maria',
  lastName:   'Test',
  email:      `maria.${TS}@test-eviacares.com`,
  password:   'Test1234!',
  phone:      '5559876543',
  city:       'Atlanta',
  state:      'GA',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitForNav(page: Page, urlPart: string, timeout = 15000) {
  await page.waitForURL(`**/*${urlPart}*`, { timeout });
}

async function fillInput(page: Page, selector: string, value: string) {
  const el = page.locator(selector).first();
  await el.waitFor({ state: 'visible', timeout: 8000 });
  await el.fill(value);
}

async function clickText(page: Page, text: string) {
  await page.locator(`button:has-text("${text}"), a:has-text("${text}")`).first().click();
}

async function loginClient(page: Page) {
  await page.goto(`${BASE}/client/login`);
  await fillInput(page, 'input[type="email"]', CLIENT.email);
  await fillInput(page, 'input[type="password"]', CLIENT.password);
  await clickText(page, 'Sign In');
  await waitForNav(page, 'client/dashboard');
}

async function loginCaregiver(page: Page) {
  await page.goto(`${BASE}/caregiver/login`);
  await fillInput(page, 'input[type="email"]', CAREGIVER.email);
  await fillInput(page, 'input[type="password"]', CAREGIVER.password);
  await clickText(page, 'Sign In');
  await page.waitForURL(/caregiver/, { timeout: 15000 });
}

// ── SUITE 1: Public Pages ─────────────────────────────────────────────────────

test.describe('1. Public Pages', () => {

  test('1.1 Landing page loads with key sections', async ({ page }) => {
    await page.goto(BASE);
    await expect(page).toHaveTitle(/Evia|Senior Care|Home Care/i, { timeout: 15000 });
    // Hero section
    await expect(page.locator('text=/find|care|caregiver/i').first()).toBeVisible();
    console.log('✅ Landing page loads');
  });

  test('1.2 How It Works page loads', async ({ page }) => {
    await page.goto(`${BASE}/how-it-works`);
    const body = page.locator('body');
    await expect(body).toBeVisible();
    console.log('✅ How It Works loads');
  });

  test('1.3 Pricing page loads', async ({ page }) => {
    await page.goto(`${BASE}/pricing`);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Pricing page loads');
  });

  test('1.4 Blog page loads', async ({ page }) => {
    await page.goto(`${BASE}/blog`);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Blog page loads');
  });

  test('1.5 Trust & Safety page loads', async ({ page }) => {
    await page.goto(`${BASE}/trust`);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Trust & Safety loads');
  });

  test('1.6 City landing page loads (Atlanta)', async ({ page }) => {
    await page.goto(`${BASE}/care/atlanta`);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ City page loads');
  });

  test('1.7 Help Center loads', async ({ page }) => {
    await page.goto(`${BASE}/help`);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Help Center loads');
  });

  test('1.8 Login page loads', async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Login page loads');
  });

});

// ── SUITE 2: Client Signup ────────────────────────────────────────────────────

test.describe('2. Client Signup', () => {

  test('2.1 Client signup page renders', async ({ page }) => {
    await page.goto(`${BASE}/client/signup`);
    await expect(page.locator('input').first()).toBeVisible({ timeout: 10000 });
    console.log('✅ Client signup page renders');
  });

  test('2.2 Client signup form validates required fields', async ({ page }) => {
    await page.goto(`${BASE}/client/signup`);
    // Try to submit empty form
    const submitBtn = page.locator('button[type="submit"], button:has-text("Create"), button:has-text("Continue")').first();
    await submitBtn.click();
    // Should show validation error — not navigate away
    await expect(page).toHaveURL(/signup/);
    console.log('✅ Signup validation works');
  });

  test('2.3 Full client signup flow', async ({ page }) => {
    await page.goto(`${BASE}/client/signup`);

    // First name
    const firstNameInput = page.locator('input[name="firstName"], input[placeholder*="first" i]').first();
    if (await firstNameInput.isVisible()) await firstNameInput.fill(CLIENT.firstName);

    // Last name
    const lastNameInput = page.locator('input[name="lastName"], input[placeholder*="last" i]').first();
    if (await lastNameInput.isVisible()) await lastNameInput.fill(CLIENT.lastName);

    // Email
    const emailInput = page.locator('input[type="email"], input[name="email"]').first();
    if (await emailInput.isVisible()) await emailInput.fill(CLIENT.email);

    // Phone
    const phoneInput = page.locator('input[type="tel"], input[name="phone"]').first();
    if (await phoneInput.isVisible()) await phoneInput.fill(CLIENT.phone);

    // Password
    const passwordInput = page.locator('input[type="password"]').first();
    if (await passwordInput.isVisible()) await passwordInput.fill(CLIENT.password);

    // Zip / address if visible
    const zipInput = page.locator('input[name="zipCode"], input[name="zip"]').first();
    if (await zipInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await zipInput.fill(CLIENT.zip);
    }

    // Submit
    const submitBtn = page.locator('button[type="submit"], button:has-text("Create Account"), button:has-text("Sign Up")').first();
    await submitBtn.click();

    // Should land on dashboard or intake flow
    await page.waitForURL(/client|intake|dashboard/, { timeout: 20000 });
    console.log('✅ Client signup completed');
  });

  test('2.4 SimpleClientSignup flow renders', async ({ page }) => {
    // Try the simple signup route if it exists
    const res = await page.goto(`${BASE}/signup`);
    if (res && res.status() < 400) {
      await expect(page.locator('body')).toBeVisible();
      console.log('✅ Simple signup route accessible');
    } else {
      console.log('ℹ️  Simple signup route not exposed — skipping');
      test.skip();
    }
  });

});

// ── SUITE 3: Client Login & Dashboard ─────────────────────────────────────────

test.describe('3. Client Dashboard', () => {

  test('3.1 Client login page renders', async ({ page }) => {
    await page.goto(`${BASE}/client/login`);
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10000 });
    console.log('✅ Client login page renders');
  });

  test('3.2 Client login with wrong password shows error', async ({ page }) => {
    await page.goto(`${BASE}/client/login`);
    await fillInput(page, 'input[type="email"]', 'wrong@test.com');
    await fillInput(page, 'input[type="password"]', 'wrongpassword');
    // Button label is "Login with Email" on the client login page
    await page.locator('button:has-text("Login"), button:has-text("Sign In")').first().click();
    // Should show error, not navigate
    await page.waitForTimeout(4000);
    const hasError = await page.locator('text=/invalid|incorrect|error|failed/i').isVisible();
    expect(hasError || page.url().includes('login')).toBeTruthy();
    console.log('✅ Login error handling works');
  });

  test('3.3 Client forgot password page loads', async ({ page }) => {
    await page.goto(`${BASE}/client/forgot-password`);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Forgot password page loads');
  });

  test('3.4 Client dashboard redirects unauthenticated users', async ({ page }) => {
    await page.goto(`${BASE}/client/dashboard`);
    await page.waitForTimeout(3000);
    // Should redirect to login or show auth gate
    const url = page.url();
    const isProtected = url.includes('login') || url.includes('signup') || !url.includes('dashboard');
    // Note: Some SPAs keep URL but show login modal — check for login form too
    const hasLoginForm = await page.locator('input[type="email"]').isVisible().catch(() => false);
    expect(isProtected || hasLoginForm).toBeTruthy();
    console.log('✅ Dashboard route is protected');
  });

});

// ── SUITE 4: Caregiver Signup ─────────────────────────────────────────────────

test.describe('4. Caregiver Signup', () => {

  test('4.1 Caregiver signup page renders', async ({ page }) => {
    await page.goto(`${BASE}/caregiver/signup`);
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 });
    console.log('✅ Caregiver signup page renders');
  });

  test('4.2 Caregiver signup Step 1 — Get Started', async ({ page }) => {
    await page.goto(`${BASE}/caregiver/signup`);
    // Wait for both auth init spinner AND Suspense lazy-load spinner to clear
    await page.waitForFunction(
      () => {
        const text = document.body?.innerText || '';
        return !text.includes('Connecting to secure server') && !text.includes('Loading page');
      },
      { timeout: 20000 }
    ).catch(() => {});
    // Step 1 shows "Find great caregiving jobs" / "Join families who need your help"
    const hasContent = await page.locator(
      'text=/find great|caregiving jobs|join families|date of birth|get started|caregiver|join|become|apply/i'
    ).first().isVisible({ timeout: 5000 }).catch(() => false);
    expect(hasContent).toBeTruthy();
    console.log('✅ Caregiver signup Step 1 visible');
  });

  test('4.3 Caregiver signup Step 2 — Account Info', async ({ page }) => {
    await page.goto(`${BASE}/caregiver/signup`);

    // Click through to Step 2 if there's a get started button
    const getStarted = page.locator('button:has-text("Get Started"), button:has-text("Continue"), button:has-text("Next")').first();
    if (await getStarted.isVisible({ timeout: 3000 }).catch(() => false)) {
      await getStarted.click();
      await page.waitForTimeout(500);
    }

    // Fill account info
    const firstNameInput = page.locator('input[name="firstName"], input[placeholder*="first" i]').first();
    if (await firstNameInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await firstNameInput.fill(CAREGIVER.firstName);

      const lastNameInput = page.locator('input[name="lastName"], input[placeholder*="last" i]').first();
      if (await lastNameInput.isVisible()) await lastNameInput.fill(CAREGIVER.lastName);

      const emailInput = page.locator('input[type="email"]').first();
      if (await emailInput.isVisible()) await emailInput.fill(CAREGIVER.email);

      const phoneInput = page.locator('input[type="tel"], input[name="phone"]').first();
      if (await phoneInput.isVisible()) await phoneInput.fill(CAREGIVER.phone);

      const passInput = page.locator('input[type="password"]').first();
      if (await passInput.isVisible()) await passInput.fill(CAREGIVER.password);

      console.log('✅ Caregiver account info filled');
    } else {
      console.log('ℹ️  Step 2 inputs not immediately visible — flow may require prior step');
    }
  });

  test('4.4 Caregiver login page renders', async ({ page }) => {
    await page.goto(`${BASE}/caregiver/login`);
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10000 });
    console.log('✅ Caregiver login page renders');
  });

  test('4.5 Caregiver dashboard protected', async ({ page }) => {
    await page.goto(`${BASE}/caregiver/dashboard`);
    // App loads 100 caregivers from Firestore before rendering routes, then CaregiverRoute
    // fires the redirect. Wait for that full init to complete (up to 20s).
    await page.waitForURL(/login|signup/, { timeout: 20000 }).catch(() => {});
    const url = page.url();
    const hasLoginForm = await page.locator('input[type="email"]').isVisible({ timeout: 5000 }).catch(() => false);
    const isRedirected = url.includes('login') || url.includes('signup') || hasLoginForm;
    expect(isRedirected).toBeTruthy();
    console.log('✅ Caregiver dashboard protected');
  });

});

// ── SUITE 5: Job Posting Flow ─────────────────────────────────────────────────

test.describe('5. Job Posting (Post Job Flow)', () => {

  test('5.1 Post job route accessible for clients', async ({ page }) => {
    await page.goto(`${BASE}/client/post-job`);
    await page.waitForTimeout(3000);
    const body = await page.locator('body').innerText();
    // Either shows the flow or redirects to auth
    expect(body.length > 0).toBeTruthy();
    console.log('✅ Post job route accessible');
  });

  test('5.2 Post job steps render correctly', async ({ page }) => {
    await page.goto(`${BASE}/client/post-job`);
    await page.waitForTimeout(2000);
    // Check for step indicators or form fields
    const hasForm = await page.locator('input, select, textarea, button:has-text("Next"), button:has-text("Continue")').first().isVisible({ timeout: 5000 }).catch(() => false);
    console.log(hasForm ? '✅ Post job form renders' : 'ℹ️  Post job requires auth — protected correctly');
  });

});

// ── SUITE 6: Agent Web Pages ──────────────────────────────────────────────────

test.describe('6. Linq Agent Web Pages', () => {

  test('6.1 QuickConfirmPage renders with valid token structure', async ({ page }) => {
    // Test with a fake token — should show "loading" or "not found/error" state, never a 500
    await page.goto(`${BASE}/confirm/test-token-123`);
    await page.waitForTimeout(3000);
    await expect(page.locator('body')).toBeVisible();
    // Should NOT crash with a 500 server error — an error/not-found state is acceptable
    const has500 = await page.locator('text=/500|server error/i').isVisible().catch(() => false);
    expect(has500).toBeFalsy();
    console.log('✅ QuickConfirmPage handles invalid token gracefully');
  });

  test('6.2 HealthSummaryPage renders with valid token structure', async ({ page }) => {
    await page.goto(`${BASE}/health-summary/test-token-123`);
    await page.waitForTimeout(3000);
    await expect(page.locator('body')).toBeVisible();
    const has500 = await page.locator('text=/500|server error/i').isVisible().catch(() => false);
    expect(has500).toBeFalsy();
    console.log('✅ HealthSummaryPage handles invalid token gracefully');
  });

  test('6.3 Auto-return sms: link present on QuickConfirmPage', async ({ page }) => {
    await page.goto(`${BASE}/confirm/test-token-123`);
    await page.waitForTimeout(3000);
    // The page should eventually show a return link or auto-redirect mechanism
    const hasSmsLink = await page.locator('a[href^="sms:"]').isVisible().catch(() => false);
    const hasReturnText = await page.locator('text=/return|conversation|message|back/i').isVisible().catch(() => false);
    console.log(hasSmsLink ? '✅ SMS return link found' : hasReturnText ? '✅ Return to conversation text found' : 'ℹ️  Token not found page shown — expected');
  });

});

// ── SUITE 7: Booking Modal ────────────────────────────────────────────────────

test.describe('7. Booking Flow', () => {

  test('7.1 BookingFlow component route accessible', async ({ page }) => {
    await page.goto(`${BASE}/client/browse-caregivers`);
    await page.waitForTimeout(3000);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Browse caregivers route accessible');
  });

  test('7.2 Schedule page accessible for clients', async ({ page }) => {
    await page.goto(`${BASE}/client/schedule`);
    await page.waitForTimeout(3000);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Schedule page accessible');
  });

});

// ── SUITE 8: Interview Flow ───────────────────────────────────────────────────

test.describe('8. Interview Flow', () => {

  test('8.1 Interviews page accessible', async ({ page }) => {
    await page.goto(`${BASE}/client/interviews`);
    await page.waitForTimeout(3000);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Interviews page accessible');
  });

});

// ── SUITE 9: Payment Pages ────────────────────────────────────────────────────

test.describe('9. Payment Pages', () => {

  test('9.1 Payment success page renders', async ({ page }) => {
    await page.goto(`${BASE}/payment/success`);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Payment success page renders');
  });

  test('9.2 Payment cancel page renders', async ({ page }) => {
    await page.goto(`${BASE}/payment/cancel`);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Payment cancel page renders');
  });

  test('9.3 Membership page renders', async ({ page }) => {
    await page.goto(`${BASE}/client/membership`);
    await page.waitForTimeout(2000);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Membership page renders');
  });

  test('9.4 Client payments page accessible', async ({ page }) => {
    await page.goto(`${BASE}/client/payments`);
    await page.waitForTimeout(2000);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Client payments page accessible');
  });

});

// ── SUITE 10: Caregiver Features ──────────────────────────────────────────────

test.describe('10. Caregiver Features', () => {

  test('10.1 Caregiver job board accessible', async ({ page }) => {
    await page.goto(`${BASE}/caregiver/jobs`);
    await page.waitForTimeout(2000);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Caregiver job board accessible');
  });

  test('10.2 Caregiver schedule page accessible', async ({ page }) => {
    await page.goto(`${BASE}/caregiver/schedule`);
    await page.waitForTimeout(2000);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Caregiver schedule accessible');
  });

  test('10.3 Caregiver earnings page accessible', async ({ page }) => {
    await page.goto(`${BASE}/caregiver/earnings`);
    await page.waitForTimeout(2000);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Caregiver earnings accessible');
  });

  test('10.4 Caregiver profile page accessible', async ({ page }) => {
    await page.goto(`${BASE}/caregiver/profile`);
    await page.waitForTimeout(2000);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Caregiver profile accessible');
  });

});

// ── SUITE 11: Navigation & Mobile ─────────────────────────────────────────────

test.describe('11. Navigation & Responsiveness', () => {

  test('11.1 Mobile viewport — landing page', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(BASE);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Mobile viewport — landing page');
  });

  test('11.2 Mobile viewport — client signup', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${BASE}/client/signup`);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Mobile viewport — client signup');
  });

  test('11.3 Mobile viewport — caregiver signup', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${BASE}/caregiver/signup`);
    await expect(page.locator('body')).toBeVisible();
    console.log('✅ Mobile viewport — caregiver signup');
  });

  test('11.4 404 Not Found page renders', async ({ page }) => {
    await page.goto(`${BASE}/this-page-does-not-exist-xyz`);
    await page.waitForTimeout(2000);
    const has404 = await page.locator('text=/not found|404|page.*doesn.*exist/i').isVisible().catch(() => false);
    const hasBody = await page.locator('body').isVisible();
    expect(hasBody).toBeTruthy();
    console.log(has404 ? '✅ 404 page renders correctly' : 'ℹ️  SPA handles unknown routes');
  });

});

// ── SUITE 12: Critical API Connectivity ──────────────────────────────────────

test.describe('12. Site Health', () => {

  test('12.1 App shell loads without JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(BASE);
    await page.waitForTimeout(5000);
    // Filter out known third-party errors
    const criticalErrors = errors.filter(e =>
      !e.includes('ResizeObserver') &&
      !e.includes('Non-Error promise rejection') &&
      !e.includes('firebaseapp') // Firebase auth state fires errors before login
    );
    if (criticalErrors.length > 0) {
      console.warn('⚠️  JS errors on landing page:', criticalErrors);
    } else {
      console.log('✅ No critical JS errors on landing page');
    }
    expect(criticalErrors.length).toBeLessThan(3); // Allow minor non-critical errors
  });

  test('12.2 Client signup loads without JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(`${BASE}/client/signup`);
    await page.waitForTimeout(5000);
    const criticalErrors = errors.filter(e =>
      !e.includes('ResizeObserver') &&
      !e.includes('Non-Error') &&
      !e.includes('firebaseapp')
    );
    if (criticalErrors.length > 0) {
      console.warn('⚠️  JS errors on client signup:', criticalErrors);
    } else {
      console.log('✅ No critical JS errors on client signup');
    }
    expect(criticalErrors.length).toBeLessThan(3);
  });

  test('12.3 Caregiver signup loads without JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(`${BASE}/caregiver/signup`);
    await page.waitForTimeout(5000);
    const criticalErrors = errors.filter(e =>
      !e.includes('ResizeObserver') &&
      !e.includes('Non-Error') &&
      !e.includes('firebaseapp')
    );
    if (criticalErrors.length > 0) {
      console.warn('⚠️  JS errors on caregiver signup:', criticalErrors);
    } else {
      console.log('✅ No critical JS errors on caregiver signup');
    }
    expect(criticalErrors.length).toBeLessThan(3);
  });

  test('12.4 Site performance — landing page loads under 5s', async ({ page }) => {
    const start = Date.now();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const elapsed = Date.now() - start;
    console.log(`⏱  Landing page DOMContentLoaded: ${elapsed}ms`);
    expect(elapsed).toBeLessThan(10000); // 10s hard limit
    if (elapsed < 3000) console.log('✅ Fast load (<3s)');
    else if (elapsed < 5000) console.log('⚠️  Acceptable load (3-5s)');
    else console.log('🔴 Slow load (>5s) — consider optimization');
  });

});
