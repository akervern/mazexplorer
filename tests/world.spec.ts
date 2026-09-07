import { test, expect } from '@playwright/test';
import {
  collectErrors,
  openDevMap,
  overlayRows,
  overlayShowing,
  sampleMap,
  showOverlay,
  startRun,
  teleportTo,
} from './helpers.js';

/**
 * What `npm test` cannot see.
 *
 * The generator's invariants are pure logic: they prove the world is
 * connected, gated and winnable without ever drawing a frame. These tests
 * cover the other half — that the thing actually renders, that the branching
 * shows up in the running game, and that the geometry on screen matches the
 * grid the generator built.
 *
 * `g199/large` is pinned deliberately: it is the seed whose layout exposed the
 * gutter-through-a-maze bug, with a forking rank and two dead-end branches.
 */
const SEED = 'g199';

test('a run starts and renders without console errors', async ({ page }) => {
  const errors = collectErrors(page);
  await startRun(page, SEED);

  await expect(page.locator('[data-zone]')).toHaveText(/Secteur \d+/);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the dev overlay reports the graph position', async ({ page }) => {
  await startRun(page, SEED);
  await showOverlay(page);

  const rows = await overlayRows(page);
  expect(rows['graphe']).toMatch(/rang \d+/);
  // The start zone is rank 0 and always has a way on.
  expect(rows['graphe']).toContain('rang 0');
  expect(rows['sorties']).not.toBe('— (feuille)');
  expect(Number(rows['fps'])).toBeGreaterThan(20);
});

test('a branching zone shows two exits, each with its own mechanism', async ({ page }) => {
  await startRun(page, SEED);
  await showOverlay(page);
  await openDevMap(page);
  // Secteur 6 (Désert) forks: east and south, two different mechanisms.
  await teleportTo(page, /Secteur 6/);

  // Wait for the overlay to catch up with the new zone before reading it.
  const rows = await overlayShowing(page, 'secteur', /Secteur 6/);
  const exits = rows['sorties'];
  // Two sides named, and a mechanism against each.
  expect(exits).toMatch(/(north|east|south|west).*·.*(north|east|south|west)/);
  expect(rows['mécanismes ici'].split('·').length).toBeGreaterThanOrEqual(2);
});

test('an optional branch is a leaf, and says so', async ({ page }) => {
  await startRun(page, SEED);
  await showOverlay(page);
  await openDevMap(page);
  // Secteur 7 is a dead-end branch in this seed.
  await teleportTo(page, /Secteur 7/);

  const rows = await overlayShowing(page, 'secteur', /Secteur 7/);
  expect(rows['graphe']).toContain('branche optionnelle');
  expect(rows['sorties']).toBe('— (feuille)');
  expect(rows['mécanismes ici']).toBe('—');
});

/**
 * The dev map must index the whole world, not a fraction of it.
 *
 * Counting walls and floors is not enough — dropping every maze tile only
 * raises the wall count, and thresholds still pass. So assert on what the map
 * can actually name: every zone of the run must be reachable *as floor*
 * somewhere on it, and the walkable share must look like a maze rather than a
 * handful of corridor tiles.
 */
test('the dev map indexes every zone of the world', async ({ page }) => {
  await startRun(page, SEED);
  await openDevMap(page);

  const points: { x: number; y: number }[] = [];
  for (let y = 90; y <= 740; y += 5) {
    for (let x = 30; x <= 1250; x += 5) points.push({ x, y });
  }
  const infos = await sampleMap(page, points);

  const named = new Set(
    infos
      .filter((i) => !/mur/.test(i))
      .map((i) => i.match(/Secteur \d+/)?.[0])
      .filter((s): s is string => !!s),
  );
  const walls = infos.filter((i) => /mur/.test(i)).length;
  const floors = infos.filter((i) => /Secteur \d+/.test(i) && !/mur/.test(i)).length;

  // g199/large has nine zones; every one must be walkable on the map.
  expect([...named].sort()).toHaveLength(9);
  // A maze is mostly wall, but its corridors are a substantial share — losing
  // the maze tiles (indexing only the gutters) collapses this ratio.
  expect(walls).toBeGreaterThan(100);
  expect(floors / (floors + walls)).toBeGreaterThan(0.15);
});
