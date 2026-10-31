// Gate B v3 — the acceptance evidence, measured in one run.
//
//   GATEB_OUT=/tmp/gateb/evidence node tests/ui/gateb-v3-evidence.mjs
//
// Everything here is a number the review asked for: the nine studio controls at 1440 (light and
// zh), the four dark contrast pairs plus their light twins, the Occurred label-to-value distance
// at 390, the fact labels on a plugin card, and how far the activity payload field reaches.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.OPSWEAVE_URL || 'http://127.0.0.1:5174';
const OUT = process.env.GATEB_OUT || '/tmp/gateb/evidence';
const EMAIL = 'admin@opsweave.local';
const PASSWORD = 'OpsWeave!2026';
const PIPELINE = 'host-metrics-pipeline';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const out = {};

async function open({ w, h, theme, locale }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, baseURL: BASE });
  await ctx.addInitScript(([t, l]) => {
    localStorage.setItem('opsweave-theme', t);
    localStorage.setItem('opsweave-locale', l);
  }, [theme, locale]);
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('[data-testid=login-submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 });
  await page.waitForTimeout(400);
  return { ctx, page };
}

const contrast = (page, sel) => page.evaluate((s) => {
  const parse = (v) => { const m = /rgba?\(([^)]+)\)/.exec(v || ''); if (!m) return null; const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const blend = (t, b) => { const a = t.a + b.a * (1 - t.a); return { r: (t.r * t.a + b.r * b.a * (1 - t.a)) / a, g: (t.g * t.a + b.g * b.a * (1 - t.a)) / a, b: (t.b * t.a + b.b * b.a * (1 - t.a)) / a, a }; };
  const lum = (c) => { const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const el = document.querySelector(s);
  if (!el) return { selector: s, missing: true };
  const stack = [];
  let node = el;
  while (node) { const c = parse(getComputedStyle(node).backgroundColor); if (c && c.a > 0.001) { stack.push(c); if (c.a >= 0.999) break; } node = node.parentElement; }
  if (!stack.length) stack.push({ r: 255, g: 255, b: 255, a: 1 });
  let acc = stack[stack.length - 1].a >= 0.999 ? stack[stack.length - 1] : blend(stack[stack.length - 1], { r: 255, g: 255, b: 255, a: 1 });
  for (let i = stack.length - 2; i >= 0; i -= 1) acc = blend(stack[i], acc);
  const fg = parse(getComputedStyle(el).color);
  const l1 = lum(fg); const l2 = lum(acc);
  return { selector: s, color: hex(fg), backdrop: hex(acc), ratio: Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100 };
}, sel);

try {
  // 1. The nine controls at 1440, light + zh (the row must fit in both locales).
  for (const locale of ['en', 'zh']) {
    const { ctx, page } = await open({ w: 1440, h: 900, theme: 'light', locale });
    await page.goto('/admin/pipelines/' + PIPELINE + '/editor');
    await page.waitForSelector('.studio-canvas', { timeout: 20000 });
    await page.waitForTimeout(900);
    out['studio1440-' + locale] = await page.evaluate(() => {
      const bar = document.querySelector('.studio-toolbar');
      const controls = Array.from(bar ? bar.children : []).map((el) => {
        const b = el.getBoundingClientRect();
        const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return { text: (el.textContent || '').trim(), left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), inViewport: b.right <= window.innerWidth, hitSelf: !!hit && (el === hit || el.contains(hit)) };
      });
      const header = document.querySelector('[data-testid=page-header]');
      const desc = document.querySelector('.page-description');
      return {
        headerHeight: header ? Math.round(header.getBoundingClientRect().height) : null,
        headerBottom: header ? Math.round(header.getBoundingClientRect().bottom) : null,
        toolbar: bar ? { left: Math.round(bar.getBoundingClientRect().left), w: Math.round(bar.clientWidth), scrollW: bar.scrollWidth, overflowX: getComputedStyle(bar).overflowX, rows: new Set(controls.map((c) => c.top)).size } : null,
        controls,
        allInside: controls.every((c) => c.inViewport && c.hitSelf),
        description: desc ? { clientW: desc.clientWidth, scrollW: desc.scrollWidth, clipped: desc.scrollWidth - desc.clientWidth } : null,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    await page.screenshot({ path: path.join(OUT, 'studio-1440-' + locale + '.png'), fullPage: true });
    await ctx.close();
  }

  // 2. Contrast, both themes, on the two controls the review named.
  for (const theme of ['light', 'dark']) {
    const { ctx, page } = await open({ w: 1440, h: 900, theme, locale: 'en' });
    await page.goto('/admin/access');
    await page.waitForSelector('[data-async-state="ready"], [data-async-state="empty"]', { timeout: 20000 });
    await page.waitForTimeout(800);
    const row = page.locator('.ow-table tbody button').filter({ hasText: /^(Disable|Enable)$/ }).first();
    await row.evaluate((el) => el.setAttribute('data-probe-btn', '1'));
    const rowRatio = await contrast(page, '[data-probe-btn]');
    await row.click();
    await page.waitForSelector('[data-testid=confirm-dialog]', { timeout: 10000 });
    await page.waitForTimeout(300);
    out[theme] = {
      rowDestructive: rowRatio,
      dialogSubmit: await contrast(page, '[data-confirm-submit]'),
      dialogClose: await contrast(page, '[data-testid=confirm-dialog] > button'),
      buttonFace: await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((el) => getComputedStyle(el).backgroundColor === 'rgb(107, 107, 107)').length),
    };
    await page.screenshot({ path: path.join(OUT, 'access-dialog-' + theme + '.png') });
    await ctx.close();
  }

  // 3. 390: labels, the Occurred gap, the activity payload, card heights.
  for (const locale of ['en', 'zh']) {
    const { ctx, page } = await open({ w: 390, h: 844, theme: 'light', locale });
    for (const route of ['/admin/plugins', '/admin/jobs', '/admin/nodes', '/admin/activity']) {
      await page.goto(route);
      await page.waitForSelector('[data-async-state="ready"], [data-async-state="empty"]', { timeout: 20000 });
      await page.waitForTimeout(700);
      out['390' + route + '-' + locale] = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.ow-table tbody tr')).filter((tr) => tr.getBoundingClientRect().height > 0);
        const heights = rows.map((tr) => Math.round(tr.getBoundingClientRect().height * 10) / 10).sort((a, b) => a - b);
        const labels = Array.from(rows[0] ? rows[0].querySelectorAll('td > span:first-child') : [])
          .map((s) => ({ text: (s.textContent || '').trim(), display: getComputedStyle(s).display, w: Math.round(s.getBoundingClientRect().width) }))
          .filter((s) => s.text);
        const occurred = Array.from(document.querySelectorAll('td[data-label]')).filter((td) => /Occurred|发生/.test(td.getAttribute('data-label') || ''))[0];
        let gap = null; let line2 = null;
        if (occurred) {
          const label = occurred.querySelector(':scope > span:first-child');
          const value = occurred.querySelector('.event-when') || occurred.querySelector('.ow-cell-body') || occurred.querySelector(':scope > span:nth-child(2)');
          if (label && value) {
            const lb = label.getBoundingClientRect(); const vb = value.getBoundingClientRect();
            gap = Math.round(vb.left - lb.right);
            line2 = { label: Math.round(lb.right), valueLeft: Math.round(vb.left), sameLine: Math.abs(lb.top - vb.top) < 12, cellW: Math.round(occurred.getBoundingClientRect().width), cellRight: Math.round(occurred.getBoundingClientRect().right) };
          }
        }
        const facts = Array.from(document.querySelectorAll('.event-detail-fact')).map((el) => Math.round(el.getBoundingClientRect().right));
        const meta = Array.from(document.querySelectorAll('.ow-ident-meta')).map((el) => ({ clipped: el.scrollWidth - el.clientWidth, h: Math.round(el.getBoundingClientRect().height * 10) / 10 }));
        return {
          rows: rows.length,
          p50: heights.length ? heights[Math.floor((heights.length - 1) / 2)] : null,
          max: heights.length ? heights[heights.length - 1] : null,
          min: heights.length ? heights[0] : null,
          heights,
          firstRowLabels: labels,
          firstRowLine2: rows[0] ? (Array.from(rows[0].children).map((td) => (td.textContent || '').replace(/\s+/g, ' ').trim()).join(' | ')).slice(0, 160) : null,
          occurredGap: gap,
          occurredGeometry: line2,
          factMaxRight: facts.length ? Math.max(...facts) : null,
          factOverViewport: facts.filter((r) => r > window.innerWidth + 0.5).length,
          metaClipped: meta.filter((m) => m.clipped > 1).length,
          docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      await page.screenshot({ path: path.join(OUT, 'm' + route.replace(/\//g, '_') + '-' + locale + '.png'), fullPage: true });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(OUT, '_evidence.json'), JSON.stringify(out, null, 2));
const summary = {};
for (const [k, v] of Object.entries(out)) {
  if (k.startsWith('studio1440')) summary[k] = { header: v.headerHeight, rows: v.toolbar.rows, w: v.toolbar.w, allInside: v.allInside, rights: v.controls.map((c) => c.right), desc: v.description, docOverflow: v.docOverflow };
  else if (k === 'light' || k === 'dark') summary[k] = { row: v.rowDestructive.ratio, submit: v.dialogSubmit.ratio, close: v.dialogClose.ratio, buttonFace: v.buttonFace };
  else summary[k] = { p50: v.p50, min: v.min, max: v.max, occurredGap: v.occurredGap, occurredGeometry: v.occurredGeometry, labels: v.firstRowLabels, line2: v.firstRowLine2, factMaxRight: v.factMaxRight, factOverViewport: v.factOverViewport, metaClipped: v.metaClipped, docOverflow: v.docOverflow };
}
console.log(JSON.stringify(summary, null, 1));
