/**
 * Simple E2E Smoke Tests for CareConnex
 * Run with: npx playwright test e2e/critical-flows.spec.ts
 */

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.TEST_URL || 'https://careconnex-d4c8b.web.app';

test.describe('CareConnex Smoke Tests', () => {
  
  test('Landing page loads', async ({ page }) => {
    await page.goto(BASE_URL);
    
    // Just check page title loads
    await expect(page).toHaveTitle(/CareConnex|Senior Care/i, { timeout: 15000 });
    
    console.log('✅ Landing page loads');
  });

  test('Caregiver signup page exists', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/become-caregiver`);
    
    // Check page loads (200 OK or similar)
    expect(response?.status()).toBeLessThan(400);
    
    // Check for any content
    const body = page.locator('body');
    await expect(body).toBeVisible();
    
    console.log('✅ Caregiver signup page accessible');
  });

  test('Client signup page exists', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/client-signup`);
    
    expect(response?.status()).toBeLessThan(400);
    
    const body = page.locator('body');
    await expect(body).toBeVisible();
    
    console.log('✅ Client signup page accessible');
  });

  test('How It Works page exists', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/how-it-works`);
    
    expect(response?.status()).toBeLessThan(400);
    
    const body = page.locator('body');
    await expect(body).toBeVisible();
    
    console.log('✅ How It Works page accessible');
  });

  test('Login page exists', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/login`);
    
    expect(response?.status()).toBeLessThan(400);
    
    const body = page.locator('body');
    await expect(body).toBeVisible();
    
    console.log('✅ Login page accessible');
  });

  test('Main site is reachable', async ({ request }) => {
    const response = await request.get(BASE_URL);
    
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/html');
    
    console.log('✅ Site responds with 200 OK');
  });
});
