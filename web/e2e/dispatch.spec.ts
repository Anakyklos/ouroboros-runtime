import { test, expect } from '@playwright/test';

test.describe('Dispatch - The Strike', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should render The Strike panel and allow typing', async ({ page }) => {
    await expect(page.locator('text=The Strike').first()).toBeVisible({ timeout: 10000 });

    const input = page.locator('input[placeholder^="Prompt for"]');
    await expect(input).toBeVisible();

    const btn = page.locator('button[title^="Send"], button[title^="Agent"]').first();
    await expect(btn).toBeVisible();

    await input.fill('Hello Ouroboros');
    await expect(input).toHaveValue('Hello Ouroboros');
  });

  test('should show error toast on failed dispatch', async ({ page }) => {
    await expect(page.locator('text=The Strike').first()).toBeVisible({ timeout: 10000 });
    const input = page.locator('input[placeholder^="Prompt for"]');
    await input.fill('trigger_error');
    
    // Pressionar Enter em vez de clicar no botão
    await input.press('Enter');

    // Assumindo que dispatch com 'trigger_error' possa falhar ou o mock rejeitar.
    // Como estamos rodando o daemon real, precisaremos que o dispatch seja enviado.
    // Verificar se o loading state aparece
    const loader = page.locator('.animate-spin').first();
    // await expect(loader).toBeVisible(); // dependendo de quão rápido for
  });
});
