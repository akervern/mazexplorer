import { expect, test } from '@playwright/test';
import { collectErrors, overlayShowing, showOverlay, startRun } from './helpers.js';

/**
 * The dev mechanism gallery (F4) and its test bench.
 *
 * What is worth asserting here is the part `npm test` cannot reach: the panel
 * renders, and clicking "Tester" really swaps the running world for a bench
 * one guarded by the mechanism that was asked for. The generator invariants
 * already prove those bench worlds are completable.
 */

test('the gallery lists every mechanism, grouped by category', async ({ page }) => {
  const errors = collectErrors(page);
  await startRun(page, 'gallery-1', 'small');

  await page.keyboard.press('F4');
  await expect(page.locator('.devgallery')).toBeVisible();

  // Every mechanism in the registry has a card, and every card can be tested.
  const cards = page.locator('.devgallery-card');
  await expect(cards).toHaveCount(7);
  await expect(page.locator('.devgallery-test')).toHaveCount(7);

  // Grouped rather than a flat list — the catalogue is meant to grow.
  const groups = page.locator('.devgallery-group');
  expect(await groups.count()).toBeGreaterThanOrEqual(4);

  // Each group names itself and holds at least one card.
  for (let i = 0; i < (await groups.count()); i++) {
    const g = groups.nth(i);
    await expect(g.locator('h3')).not.toBeEmpty();
    expect(await g.locator('.devgallery-card').count()).toBeGreaterThan(0);
  }

  await page.keyboard.press('F4');
  await expect(page.locator('.devgallery')).toBeHidden();
  expect(errors).toEqual([]);
});

/**
 * The bench itself. `light_threshold` is the case that motivates the feature:
 * weight 1, restricted to a "deep exploration" passage, so it turns up rarely
 * in an ordinary run.
 */
test('testing a mechanism loads a bench world guarded by it', async ({ page }) => {
  const errors = collectErrors(page);
  await startRun(page, 'gallery-2', 'small');
  await showOverlay(page);

  await page.keyboard.press('F4');
  await expect(page.locator('.devgallery')).toBeVisible();
  await page.locator('[data-test="light_threshold"]').click();

  // The panel closes and a whole new game is built.
  await expect(page.locator('.devgallery')).toBeHidden();
  await expect(page.locator('[data-zone]')).not.toBeEmpty();

  // The overlay is rebuilt with the new world, so make sure it is showing
  // again before reading it — a stale panel would report the old run.
  await showOverlay(page);

  // The gate out of the bench's first zone is the forced mechanism.
  const rows = await overlayShowing(page, 'sorties', /light_threshold/);
  expect(rows['sorties']).toMatch(/light_threshold/);
  // Two-zone bench: the seed says so, and the world is tiny.
  expect(rows['seed']).toMatch(/^bench-light_threshold-/);

  expect(errors).toEqual([]);
});
