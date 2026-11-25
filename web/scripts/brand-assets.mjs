// Renders the site graphics (favicon, app icons, logo, link-preview image) from
// HTML using the same fonts the app ships, so they always match the brand.
//
//   node web/scripts/brand-assets.mjs          (needs Playwright + Chromium)
//
// Output goes to web/public/brand/ and web/public/. Re-run after changing the
// mark, colours or tagline below.
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, '../public');
const fonts = join(here, '../../node_modules/@fontsource-variable');
const b64 = (p) => readFileSync(p).toString('base64');

const INK = '#100f0d';
const PAPER = '#f4eee1';
const HOT = '#ff2e88';
const SUN = '#ffd23f';
const TAGLINE = 'Your comic. Your rules.';

const css = `
@font-face{font-family:Brico;font-weight:200 800;src:url(data:font/woff2;base64,${b64(join(fonts, 'bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2'))}) format('woff2')}
@font-face{font-family:InterV;font-weight:100 900;src:url(data:font/woff2;base64,${b64(join(fonts, 'inter/files/inter-latin-wght-normal.woff2'))}) format('woff2')}
*{box-sizing:border-box;margin:0}
html,body{background:transparent}
.d{font-family:Brico,sans-serif;font-weight:800;letter-spacing:-.045em;line-height:1}
`;

/** Square icon form of the mark at `s` px: "ns" over "fw". */
const icon = (s, bg = HOT, fg = INK, shade = 'rgba(0,0,0,.24)') => `
<div style="width:${s}px;height:${s}px;border-radius:${s * 0.235}px;background:${bg};box-shadow:inset 0 -${s * 0.095}px 0 ${shade};
  padding:0 0 ${s * 0.08}px ${s * 0.16}px;display:flex;flex-direction:column;justify-content:center;flex:none">
  <span class="d" style="font-size:${s * 0.36}px;line-height:.86;letter-spacing:-.04em;color:${fg}">ns<br>fw</span>
</div>`;

/** The key reading "nsfw", `h` px tall. */
const keycap = (h, bg = HOT, fg = INK, shade = 'rgba(0,0,0,.24)') => `
<div style="height:${h}px;border-radius:${h * 0.235}px;background:${bg};box-shadow:inset 0 -${h * 0.095}px 0 ${shade};
  padding:0 ${h * 0.2}px ${h * 0.2}px ${h * 0.17}px;display:flex;align-items:flex-end;flex:none">
  <span class="d" style="font-size:${h * 0.42}px;letter-spacing:-.04em;color:${fg}">nsfw</span>
</div>`;

const lockup = (h, textColor, bg = HOT, fg = INK, shade) => `
<div style="display:inline-flex;align-items:center;gap:${h * 0.17}px;padding:${h * 0.08}px">
  ${keycap(h, bg, fg, shade)}<span class="d" style="font-size:${h * 0.81}px;color:${textColor}">comix</span>
</div>`;

const dots = (color, size, style) =>
  `<div style="position:absolute;border-radius:50%;width:${size}px;height:${size}px;background-image:radial-gradient(circle,${color} 2.4px,transparent 2.8px);background-size:15px 15px;${style}"></div>`;

const og = `
<div style="width:1200px;height:630px;background:${INK};color:${PAPER};padding:64px 72px;display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden;font-family:InterV,sans-serif">
  ${dots(HOT, 620, 'right:-150px;bottom:-190px;opacity:.6')}
  <div style="position:absolute;right:96px;top:150px;width:300px;height:58px;background:${SUN};transform:rotate(-13deg)"></div>
  <div style="display:flex;align-items:center;gap:16px;position:relative">${keycap(76)}<span class="d" style="font-size:58px">comix</span></div>
  <div style="position:relative">
    <div class="d" style="font-size:148px;line-height:.88;letter-spacing:-.05em">Your comic.<br><span style="color:${HOT}">Your rules.</span></div>
    <p style="margin-top:26px;font-size:28px;font-weight:500;color:#c9c1b1">Creator-owned comics. Adult work welcome.</p>
  </div>
</div>`;


// Link-preview card for one series: the API drops the cover into the empty slot on the left.
const ogSeries = `
<div style="width:1200px;height:630px;background:${INK};color:${PAPER};position:relative;overflow:hidden;font-family:InterV,sans-serif">
  ${dots(HOT, 560, 'right:-170px;bottom:-200px;opacity:.55')}
  <div style="position:absolute;left:88px;top:61px;width:360px;height:540px;background:${SUN}"></div>
  <div style="position:absolute;left:72px;top:45px;width:360px;height:540px;background:#1d1b18"></div>
  <div style="position:absolute;left:520px;top:64px;display:flex;align-items:center;gap:14px">${keycap(64)}<span class="d" style="font-size:49px">comix</span></div>
  <div style="position:absolute;left:520px;bottom:72px">
    <div class="d" style="font-size:104px;line-height:.9;letter-spacing:-.05em">Read it<br><span style="color:${HOT}">frame by frame.</span></div>
    <p style="margin-top:22px;font-size:26px;font-weight:500;color:#c9c1b1">Creator-owned comics. Adult work welcome.</p>
  </div>
</div>`;

// Goes over the blurred cover of an adult series, so the preview is safe to post anywhere.
const ogMature = `
<div style="width:360px;height:540px;position:relative;overflow:hidden;background:rgba(16,15,13,.28)">
  <div style="position:absolute;left:-40px;top:218px;width:440px;height:92px;background:${INK};transform:rotate(-9deg);display:flex;align-items:center;justify-content:center">
    <span class="d" style="font-size:54px;color:${SUN};letter-spacing:-.02em">18+ inside</span>
  </div>
</div>`;

const shots = [
  // [file, html, width, height, transparent]
  ['favicon-32.png', icon(32), 32, 32, true],
  ['icon-192.png', `<div style="width:192px;height:192px;background:${INK};display:flex;align-items:center;justify-content:center">${icon(136)}</div>`, 192, 192, false],
  ['icon-512.png', `<div style="width:512px;height:512px;background:${INK};display:flex;align-items:center;justify-content:center">${icon(360)}</div>`, 512, 512, false],
  ['apple-touch-icon.png', `<div style="width:180px;height:180px;background:${INK};display:flex;align-items:center;justify-content:center">${icon(128)}</div>`, 180, 180, false],
  ['brand/mark.png', icon(512), 512, 512, true],
  ['brand/key.png', keycap(256), null, null, true],
  ['brand/logo-on-dark.png', lockup(160, PAPER), null, null, true],
  ['brand/logo-on-light.png', lockup(160, INK, INK, HOT, 'rgba(255,255,255,.14)'), null, null, true],
  ['brand/logo-one-colour-light.png', lockup(160, INK, INK, PAPER, 'rgba(255,255,255,.14)'), null, null, true],
  ['brand/og-image.png', og, 1200, 630, false],
  ['brand/og-series.png', ogSeries, 1200, 630, false],
  ['brand/og-mature-overlay.png', ogMature, 360, 540, true],
];

mkdirSync(join(pub, 'brand'), { recursive: true });
const browser = await chromium.launch();
for (const [file, html, w, h, transparent] of shots) {
  const page = await browser.newPage({ viewport: { width: w ?? 1400, height: h ?? 400 }, deviceScaleFactor: w && w <= 64 ? 1 : w && w >= 1200 ? 1 : file.startsWith('brand/og-') ? 1 : 2 });
  await page.setContent(`<style>${css}</style><div id="x" style="display:inline-block">${html}</div>`);
  await page.evaluate(() => document.fonts.ready);
  await page.locator('#x').screenshot({ path: join(pub, file), omitBackground: transparent });
  await page.close();
  console.log('wrote', file);
}
await browser.close();
console.log(`Tagline: ${TAGLINE}`);
