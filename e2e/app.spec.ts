// End-to-end: a new user signs up, adds an expense, imports a card statement and asks a question.
import { test, expect } from '@playwright/test';
import path from 'node:path';

const fixture = (name: string) => path.join(import.meta.dirname, '..', 'test', 'fixtures', name);

test('sign up, add an expense, import a statement, ask a question', async ({ page }, info) => {
  const email = `e2e-${info.project.name}-${Date.now()}@example.test`;

  await test.step('create an account', async () => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByPlaceholder('Your name').fill('Test User');
    await page.getByPlaceholder('you@example.com').fill(email);
    await page.getByPlaceholder('At least 6 characters').fill('secret123');
    await page.locator('#authSubmit').click();
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#bucketGrid .bucket-btn')).toHaveCount(12);
  });

  await test.step('add an expense with the calculator', async () => {
    await page.locator('#amount').fill('12.50+7.50');
    await page.locator('#bucketGrid .bucket-btn', { hasText: 'Groceries' }).click();
    await page.locator('#note').fill('Costco');
    await page.locator('#saveBtn').click();
    await expect(page.locator('#recentList')).toContainText('Costco');
    await expect(page.locator('#recentList')).toContainText('20.00');
  });

  await test.step('import an AMEX statement', async () => {
    await page.locator('[data-tab=settings]').click();
    await page.locator('#stmtFile').setInputFiles(fixture('amex.csv'));
    const dialog = page.locator('#stmtDialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('ALDI INC CARY');
    await expect(dialog).toContainText('Card payment'); // the AUTOPAY line is skipped
    await page.locator('#stmtImport').click();
    await expect(dialog).toBeHidden();
    await page.locator('[data-tab=history]').click();
    await expect(page.locator('#histList')).toContainText('TESLA');
    await expect(page.locator('#histList')).not.toContainText('AUTOPAY');
  });

  await test.step('ask in plain English', async () => {
    await page.locator('[data-tab=reports]').click();
    await page.locator('#askInput').fill('groceries 2026');
    await page.locator('#askInput').press('Enter');
    await expect(page.locator('#askResult')).toContainText('Groceries');
  });
});

test('wrong password shows an error and stays signed out', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('you@example.com').fill('nobody@example.test');
  await page.getByPlaceholder('At least 6 characters').fill('wrongpass');
  await page.locator('#authSubmit').click();
  await expect(page.locator('#authError')).toContainText('Wrong email or password');
  await expect(page.locator('#app')).toBeHidden();
});

test('try the demo: made-up data, a clear banner, and a way to sign up', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try the demo' }).click();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#demoBanner')).toContainText('made up');
  await page.locator('[data-tab=history]').click();
  await expect(page.locator('#histList')).toContainText(/Costco|Walmart|Aldi|Kroger|Trader Joes/);
  await page.locator('#demoSignup').click();
  await expect(page.locator('#auth')).toBeVisible();
  await expect(page.locator('#authSubmit')).toHaveText('Create account');
});
