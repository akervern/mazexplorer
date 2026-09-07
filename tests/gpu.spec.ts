import { test, expect } from '@playwright/test';

/**
 * The GPU path itself.
 *
 * SwiftShader renders every other test in this suite just as happily, only
 * slower — so without this check a silent fallback would look like a pass, and
 * "we verified it on the GPU" would quietly stop being true.
 */
test('renders WebGL 2 on the real GPU, not SwiftShader', async ({ page }) => {
  await page.goto('/');

  const gl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('webgl2');
    if (!ctx) return null;
    const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
    return {
      version: ctx.getParameter(ctx.VERSION) as string,
      renderer: dbg ? (ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string) : '',
    };
  });

  expect(gl, 'WebGL 2 context').not.toBeNull();
  expect(gl!.version).toContain('WebGL 2.0');
  expect(gl!.renderer, `renderer was: ${gl!.renderer}`).not.toMatch(/SwiftShader|llvmpipe|softpipe/i);
});
