import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export type Size = 'small' | 'medium' | 'large';

/** Start a run on a fixed seed and wait for the first frames to settle. */
export async function startRun(page: Page, seed: string, size: Size = 'large'): Promise<void> {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.fill('[data-seed]', seed);
  await page.check(`input[name=size][value=${size}]`);
  await page.click('[data-play]');
  // The HUD zone name is filled once the world is built and the loop runs.
  await expect(page.locator('[data-zone]')).not.toBeEmpty();
  await page.waitForTimeout(2500);
}

/**
 * Noise the browser makes on its own, unrelated to the app.
 *
 * The favicon is requested automatically and the page declares none, so Vite
 * answers 404 on every load. Filtering it keeps the assertion at "zero errors"
 * instead of softening it to "few errors", which would let a real one through.
 */
const IGNORED_ERRORS = [/favicon/i, /Failed to load resource.*404/i];

/** Collect any console error or uncaught exception for the life of the page. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  const keep = (text: string) => !IGNORED_ERRORS.some((re) => re.test(text));

  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && keep(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/**
 * Make sure the F3 overlay is showing.
 *
 * It starts visible under `dev:debug`, so a blind F3 turns it *off* — and a
 * hidden overlay stops refreshing, leaving stale rows that look like a
 * teleport silently failed.
 */
export async function showOverlay(page: Page): Promise<void> {
  if (await page.locator('.devoverlay').isHidden()) {
    await page.keyboard.press('F3');
  }
  await expect(page.locator('.devoverlay')).toBeVisible();
}

/** Open the dev map (F1) and wait for it to draw. */
export async function openDevMap(page: Page): Promise<void> {
  await page.keyboard.press('F1');
  await expect(page.locator('.devmap')).toBeVisible();
  await page.waitForTimeout(500);
}

/**
 * What the dev map reports under the cursor: `"(x, z) Secteur N · Biome"`, or
 * `"(x, z) — mur"` over a wall. This is the map's own readout, so it is also a
 * check that the map indexes the world correctly.
 */
export async function tileUnder(page: Page, x: number, y: number): Promise<string> {
  await page.mouse.move(x, y);
  await page.waitForTimeout(30);
  return (await page.locator('[data-info]').textContent()) ?? '';
}

/**
 * Sample many map tiles in one go.
 *
 * Moving the real mouse and reading the DOM per point costs a round-trip each,
 * which turns a sweep into minutes. Dispatching the events inside the page
 * keeps the same code path — the map's own mousemove handler and its readout —
 * at a fraction of the cost.
 */
export async function sampleMap(
  page: Page,
  points: { x: number; y: number }[],
): Promise<string[]> {
  return page.evaluate((pts) => {
    const canvas = document.querySelector('.devmap canvas') as HTMLCanvasElement | null;
    const info = document.querySelector('[data-info]');
    if (!canvas || !info) return [];
    const out: string[] = [];
    for (const p of pts) {
      canvas.dispatchEvent(
        new MouseEvent('mousemove', { clientX: p.x, clientY: p.y, bubbles: true }),
      );
      out.push(info.textContent ?? '');
    }
    return out;
  }, points);
}

/**
 * Sweep the dev map for a walkable tile matching `want`, then click it to
 * teleport there.
 *
 * Teleporting is the only reliable way to frame a shot in an automated
 * session: pointer lock cannot be granted by script, so the noclip flight keys
 * never respond.
 */
export async function teleportTo(page: Page, want: RegExp): Promise<string> {
  // Sweep the canvas in page space, so the sampled points are the same
  // coordinates a real click will use.
  const hit = await page.evaluate((source) => {
    const re = new RegExp(source);
    const canvas = document.querySelector('.devmap canvas') as HTMLCanvasElement | null;
    const info = document.querySelector('[data-info]');
    if (!canvas || !info) return null;

    const r = canvas.getBoundingClientRect();
    for (let y = r.y + 2; y < r.y + r.height; y += 5) {
      for (let x = r.x + 2; x < r.x + r.width; x += 5) {
        // Whole pixels: the real click Playwright sends is rounded, and a
        // fractional probe can resolve to a neighbouring tile — one that the
        // map may consider a wall, in which case the click is ignored.
        const px = Math.round(x);
        const py = Math.round(y);
        canvas.dispatchEvent(
          new MouseEvent('mousemove', { clientX: px, clientY: py, bubbles: true }),
        );
        const text = info.textContent ?? '';
        if (text && !/mur/.test(text) && re.test(text)) return { x: px, y: py, text };
      }
    }
    return null;
  }, want.source);

  if (!hit) throw new Error(`no walkable tile matching ${want} on the dev map`);

  await page.mouse.click(hit.x, hit.y);
  // The map closes itself on a teleport; wait for the game to be back.
  await expect(page.locator('.devmap')).toBeHidden();
  await page.waitForTimeout(900);
  return hit.text;
}

/**
 * Read the F3 overlay as a label -> value map, once it reflects `expected`.
 *
 * The overlay redraws on its own interval and only while visible, so a read
 * taken right after a teleport can still show the previous zone. Poll until it
 * catches up rather than sleeping a guessed amount.
 */
export async function overlayShowing(
  page: Page,
  label: string,
  expected: RegExp,
): Promise<Record<string, string>> {
  let rows: Record<string, string> = {};
  await expect(async () => {
    rows = await overlayRows(page);
    expect(rows[label] ?? '').toMatch(expected);
  }).toPass({ timeout: 10_000 });
  return rows;
}

/**
 * Read the F3 overlay as a label -> value map.
 * Each row is `<div><span>label</span><b>value</b></div>`.
 */
export async function overlayRows(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const row of document.querySelectorAll('[data-body] > div')) {
      const k = row.querySelector('span')?.textContent?.trim();
      const v = row.querySelector('b')?.textContent?.trim();
      if (k) out[k] = v ?? '';
    }
    return out;
  });
}
