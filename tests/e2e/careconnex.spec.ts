import { test, expect } from '@playwright/test';

/**
 * CareConnex E2E Test Suite
 * Tests critical user flows: signup, booking, payment, care journal
 */

const BASE_URL = process.env.TEST_URL || 'http://localhost:5173';

// Test data
const TEST_CLIENT = {
  email: `test.client.${Date.now()}@example.com`,
  password: 'TestPassword123!',
  name: 'Test Client',
  phone: '(555) 123-4567'
};

const TEST_CAREGIVER = {
  email: `test.caregiver.${Date.now()}@example.com`,
  password: 'TestPassword123!',
  name: 'Test Caregiver'
};

test.describe('Client Flow', () => {
  test('client can sign up', async ({ page }) => {
    await page.goto(`${BASE_URL}/client-signup`);
    
    // Fill signup form
    await page.fill('input[name="firstName"]', 'Test');
    await page.fill('input[name="lastName"]', 'Client');
    await page.fill('input[name="email"]', TEST_CLIENT.email);
    await page.fill('input[name="phone"]', TEST_CLIENT.phone);
    await page.fill('input[name="password"]', TEST_CLIENT.password);
    
    // Continue to step 2
    await page.click('button:has-text("Continue")');
    
    // Select care needs
    await page.click('button:has-text("Companionship")');
    await page.click('button:has-text("Continue")');
    
    // Select schedule
    await page.click('button:has-text("Mornings")');
    await page.click('button:has-text("Complete")');
    
    // Should redirect to client dashboard
    await expect(page).toHaveURL(/.*client/);
    await expect(page.locator('text=Find Care')).toBeVisible();
  });

  test('client can browse caregivers', async ({ page }) => {
    // Login first
    await page.goto(`${BASE_URL}/client-login`);
    await page.fill('input[type="email"]', TEST_CLIENT.email);
    await page.fill('input[type="password"]', TEST_CLIENT.password);
    await page.click('button:has-text("Sign In")');
    
    await page.waitForURL(/.*client/);
    
    // Should see AI-matched caregivers
    await expect(page.locator('text=% Match')).toBeVisible();
    await expect(page.locator('text=Peace of Mind Score')).toBeVisible();
  });

  test('client can book a caregiver', async ({ page }) => {
    await page.goto(`${BASE_URL}/client-login`);
    await page.fill('input[type="email"]', TEST_CLIENT.email);
    await page.fill('input[type="password"]', TEST_CLIENT.password);
    await page.click('button:has-text("Sign In")');
    
    await page.waitForURL(/.*client/);
    
    // Click on first caregiver
    await page.click('button:has-text("View Profile")');
    
    // Should see booking modal
    await expect(page.locator('text=Book Appointment')).toBeVisible();
    
    // Select date
    await page.click('button:has-text("Tomorrow")');
    
    // Select time
    await page.click('button:has-text("9:00 AM")');
    
    // Confirm booking
    await page.click('button:has-text("Confirm Booking")');
    
    // Should show success
    await expect(page.locator('text=Booking confirmed')).toBeVisible();
  });
});

test.describe('Caregiver Flow', () => {
  test('caregiver can sign up and complete onboarding', async ({ page }) => {
    await page.goto(`${BASE_URL}/caregiver-signup`);
    
    // Step 1: Basic info
    await page.fill('input[name="email"]', TEST_CAREGIVER.email);
    await page.fill('input[name="password"]', TEST_CAREGIVER.password);
    await page.fill('input[name="name"]', TEST_CAREGIVER.name);
    await page.click('button:has-text("Continue")');
    
    // Step 2: Profile setup
    await page.click('button:has-text("Dementia Care")');
    await page.click('button:has-text("Mobility Assistance")');
    await page.click('button:has-text("Continue")');
    
    // Step 3: Background check
    await page.fill('input[name="legalFirstName"]', 'Test');
    await page.fill('input[name="legalLastName"]', 'Caregiver');
    await page.fill('input[name="dob"]', '1990-01-01');
    await page.fill('input[name="ssn"]', '123-45-6789');
    await page.click('input[type="checkbox"]');
    await page.click('button:has-text("Submit for Review")');
    
    // Should show verification pending
    await expect(page.locator('text=Verification in Progress')).toBeVisible();
  });

  test('caregiver can view job board', async ({ page }) => {
    await page.goto(`${BASE_URL}/caregiver-login`);
    await page.fill('input[type="email"]', TEST_CAREGIVER.email);
    await page.fill('input[type="password"]', TEST_CAREGIVER.password);
    await page.click('button:has-text("Sign In")');
    
    await page.waitForURL(/.*caregiver/);
    
    // Navigate to job board
    await page.click('button:has-text("Find Work")');
    
    // Should see AI-matched jobs
    await expect(page.locator('text=AI-Matched Jobs')).toBeVisible();
  });

  test('caregiver can clock in and submit care journal', async ({ page }) => {
    await page.goto(`${BASE_URL}/caregiver-login`);
    await page.fill('input[type="email"]', TEST_CAREGIVER.email);
    await page.fill('input[type="password"]', TEST_CAREGIVER.password);
    await page.click('button:has-text("Sign In")');
    
    await page.waitForURL(/.*caregiver/);
    
    // Clock in
    await page.click('button:has-text("Clock In")');
    
    // Should show active shift
    await expect(page.locator('text=Current Shift')).toBeVisible();
    
    // Clock out
    await page.click('button:has-text("Clock Out")');
    
    // Should show care journal form
    await expect(page.locator('text=Visit Check-In')).toBeVisible();
    
    // Fill care journal
    await page.click('button:has-text("Great")');
    await page.click('button:has-text("Continue")');
    await page.click('button:has-text("Ate well")');
    await page.click('button:has-text("Continue")');
    await page.click('button:has-text("Complete Check-In")');
    
    // Should show success
    await expect(page.locator('text=Visit check-in completed')).toBeVisible();
  });
});

test.describe('Security', () => {
  test('unauthenticated users cannot access protected routes', async ({ page }) => {
    await page.goto(`${BASE_URL}/client`);
    
    // Should redirect to login
    await expect(page).toHaveURL(/.*client-login/);
  });

  test('rate limiting prevents brute force', async ({ page }) => {
    await page.goto(`${BASE_URL}/client-login`);
    
    // Try 5 rapid login attempts
    for (let i = 0; i < 5; i++) {
      await page.fill('input[type="email"]', 'fake@email.com');
      await page.fill('input[type="password"]', 'wrongpassword');
      await page.click('button:has-text("Sign In")');
    }
    
    // Should see rate limit message
    await expect(page.locator('text=Please wait')).toBeVisible();
  });
});

test.describe('AI Features', () => {
  test('AI match scores are displayed', async ({ page }) => {
    await page.goto(`${BASE_URL}/client-login`);
    await page.fill('input[type="email"]', TEST_CLIENT.email);
    await page.fill('input[type="password"]', TEST_CLIENT.password);
    await page.click('button:has-text("Sign In")');
    
    await page.waitForURL(/.*client/);
    
    // Should see match percentages
    await expect(page.locator(/[0-9]+% Match/)).toBeVisible();
    
    // Should see AI insights
    await expect(page.locator('text=AI Insights')).toBeVisible();
  });
});
