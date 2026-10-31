// Gate B v3 — remediation probe. One script, every number the acceptance needs.
//
//   GATEB_OUT=/tmp/gateb/before node tests/ui/gateb-v3-probe.mjs
//
// Measures the three defects the review named (studio action row at 1440, dark contrast on the
// destructive + dialog close controls, 390 label/value ownership) plus the card heights that
// must not grow. Screenshots land beside the JSON so a human can open them.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.OPSWEAVE_URL || 'http://127.0.0.1:5174';
const OUT = process.env.GATEB_OUT || '/tmp/gateb/run';
const EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const PIPELINE = process.env.GATEB_PIPELINE || 'host-metrics-pipeline';
const SECTIONS = (process.env.GATEB_ONLY || 'studio,dark,mobile').split(',').filter(Boolean);

fs.mkdirSync(OUT, { recursive: true });
const out = {};

async function newPage(browser, { w, h, theme, locale }) {
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
  await page.waitForTimeout(500);
  return { ctx, page };
}

/** Geometry of one page, read in the browser. */
async function geometry(page) {
  return page.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) }; };
    const de = document.documentElement;
    const header = document.querySelector('[data-testid=page-header]');
    const actions = document.querySelector('.page-actions') || document.querySelector('.studio-toolbar');
    const controls = actions ? Array.from(actions.children).map((el) => {
      const box = el.getBoundingClientRect();
      const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
        ...r(el),
        inViewport: box.right <= window.innerWidth + 0.5 && box.left >= -0.5,
        hitSelf: !!hit && (el === hit || el.contains(hit)),
      };
    }) : [];
    const desc = document.querySelector('.page-description');
    const toolbar = document.querySelector('.studio-toolbar');
    const canvas = document.querySelector('.studio-canvas');
    const drafts = document.querySelector('.studio-drafts');
    return {
      origin: location.origin,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      docOverflow: de.scrollWidth - de.clientWidth,
      header: header ? r(header) : null,
      headerOverflowBelow: header ? Math.round(header.getBoundingClientRect().bottom - (drafts ? drafts.getBoundingClientRect().top : 1e9)) : null,
      actionsBox: actions ? { ...r(actions), clientW: actions.clientWidth, scrollW: actions.scrollWidth, overflowX: getComputedStyle(actions).overflowX, flexWrap: getComputedStyle(actions).flexWrap } : null,
      controls,
      controlsClipped: controls.filter((c) => !c.inViewport || !c.hitSelf).map((c) => c.text + '@' + c.right + (c.hitSelf ? '' : '!hit')),
      description: desc ? { clientW: desc.clientWidth, scrollW: desc.scrollWidth, clipped: desc.scrollWidth - desc.clientWidth } : null,
      toolbar: toolbar ? r(toolbar) : null,
      canvas: canvas ? r(canvas) : null,
      drafts: drafts ? r(drafts) : null,
      scrollers: Array.from(document.querySelectorAll('#root *')).filter((el) => {
        const cs = getComputedStyle(el);
        return (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1;
      }).slice(0, 6).map((el) => ({ cls: String(el.className).slice(0, 40), hidden: el.scrollWidth - el.clientWidth })),
    };
  });
}

/** Contrast of an element against its painted backdrop, with the stack that produced it. */
async function contrastInfo(page, selector) {
  return page.evaluate((sel) => {
    const parse = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ''); if (!m) return null; const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); if (p.length < 3) return null; return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const blend = (t, b) => { const a = t.a + b.a * (1 - t.a); if (a === 0) return { r: 0, g: 0, b: 0, a: 1 }; return { r: (t.r * t.a + b.r * b.a * (1 - t.a)) / a, g: (t.g * t.a + b.g * b.a * (1 - t.a)) / a, b: (t.b * t.a + b.b * b.a * (1 - t.a)) / a, a }; };
    const lum = (c) => { const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
    const el = document.querySelector(sel);
    if (!el) return { selector: sel, missing: true };
    const box = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const stack = [];
    let node = el;
    while (node) {
      const s = getComputedStyle(node);
      const c = parse(s.backgroundColor);
      if (c && c.a > 0.001) {
        stack.push({ cls: String(node.className || node.tagName).slice(0, 44), color: hex(c), alpha: Math.round(c.a * 100) / 100 });
        if (c.a >= 0.999) break;
      }
      node = node.parentElement;
    }
    let base = stack.length ? parse(stack[stack.length - 1].color.length === 7 ? 'rgb(' + parseInt(stack[stack.length - 1].color.slice(1, 3), 16) + ',' + parseInt(stack[stack.length - 1].color.slice(3, 5), 16) + ',' + parseInt(stack[stack.length - 1].color.slice(5, 7), 16) + ')' : 'rgb(0,0,0)') : { r: 255, g: 255, b: 255, a: 1 };
    const raw = [];
    let n2 = el;
    while (n2) { const s = getComputedStyle(n2); const c = parse(s.backgroundColor); if (c && c.a > 0.001) { raw.push(c); if (c.a >= 0.999) break; } n2 = n2.parentElement; }
    if (!raw.length) raw.push({ r: 255, g: 255, b: 255, a: 1 });
    let acc = raw[raw.length - 1].a >= 0.999 ? raw[raw.length - 1] : blend(raw[raw.length - 1], { r: 255, g: 255, b: 255, a: 1 });
    for (let i = raw.length - 2; i >= 0; i -= 1) acc = blend(raw[i], acc);
    const fg = parse(cs.color);
    const l1 = lum(fg); const l2 = lum(acc);
    return {
      selector: sel,
      color: hex(fg),
      paintedBackdrop: hex(acc),
      backdropStack: stack.slice(0, 4),
      ratio: Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100,
      fontSize: cs.fontSize,
      box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
    };
  }, selector);
}

/** Card shape at 390: height per row and what one fact line actually reads as. */
async function cards(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.ow-table tbody tr')).filter((tr) => tr.getBoundingClientRect().height > 0);
    const heights = rows.map((tr) => Math.round(tr.getBoundingClientRect().height * 10) / 10).sort((a, b) => a - b);
    const p50 = heights.length ? heights[Math.floor((heights.length - 1) / 2)] : null;
    const pick = (tr) => {
      const cells = Array.from(tr.querySelectorAll('td'));
      return cells.map((td) => {
        const labelSpan = td.querySelector(':scope > span:first-child');
        const lcs = labelSpan ? getComputedStyle(labelSpan) : null;
        const before = getComputedStyle(td, '::before');
        const box = td.getBoundingClientRect();
        const value = td.querySelector('.ow-cell-body') || td;
        return {
          dataLabel: td.getAttribute('data-label'),
          cls: String(td.className).slice(0, 46),
          labelText: labelSpan ? (labelSpan.textContent || '').trim() : null,
          labelDisplay: lcs ? lcs.display : null,
          labelVisible: !!(labelSpan && lcs && lcs.display !== 'none' && lcs.visibility !== 'hidden' && labelSpan.getBoundingClientRect().width > 0),
          beforeContent: before.content,
          text: (td.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          right: Math.round(box.right),
          clippedX: Math.round(td.scrollWidth - td.clientWidth),
          valueText: (value.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        };
      });
    };
    const factRects = Array.from(document.querySelectorAll('.event-detail-fact')).map((el) => {
      const b = el.getBoundingClientRect();
      const inner = el.querySelector('code') || el;
      const ib = inner.getBoundingClientRect();
      return {
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        right: Math.round(b.right),
        w: Math.round(b.width),
        codeRight: Math.round(ib.right),
        visibleRight: Math.round(Math.min(b.right, window.innerWidth)),
        overflowX: getComputedStyle(el).overflowX,
        whiteSpace: getComputedStyle(el).whiteSpace,
      };
    });
    const when = Array.from(document.querySelectorAll('.event-when')).slice(0, 3).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
    const occurredCells = Array.from(document.querySelectorAll('td[data-label]')).filter((td) => /Occurred|发生/.test(td.getAttribute('data-label') || '')).slice(0, 3).map((td) => ({
      text: (td.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      display: getComputedStyle(td).display,
      gap: getComputedStyle(td).gap,
      labelDisplay: (() => { const s = td.querySelector(':scope > span:first-child'); return s ? getComputedStyle(s).display : null; })(),
    }));
    const meta = Array.from(document.querySelectorAll('.ow-ident-meta')).slice(0, 3).map((el) => ({
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      whiteSpace: getComputedStyle(el).whiteSpace,
      height: Math.round(el.getBoundingClientRect().height * 10) / 10,
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      clipped: el.scrollWidth - el.clientWidth,
    }));
    return {
      rows: rows.length,
      heights,
      p50,
      samples: rows.slice(0, 2).map(pick),
      factRects: factRects.slice(0, 5),
      factClipped: factRects.filter((f) => f.right > window.innerWidth + 0.5).length,
      when,
      occurredCells,
      meta,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

const browser = await chromium.launch();
try {
  if (SECTIONS.includes('studio')) {
    out.studio = {};
    for (const vp of [{ w: 1440, h: 900 }, { w: 1024, h: 768 }, { w: 390, h: 844 }]) {
      const { ctx, page } = await newPage(browser, { ...vp, theme: 'light', locale: 'en' });
      await page.goto('/admin/pipelines/' + PIPELINE + '/editor');
      await page.waitForSelector('[data-async-state="ready"], [data-async-state="empty"], .studio-canvas', { timeout: 20000 });
      await page.waitForTimeout(900);
      out.studio['r' + vp.w] = await geometry(page);
      await page.screenshot({ path: path.join(OUT, 'studio-' + vp.w + '.png'), fullPage: true });
      await ctx.close();
    }
  }

  /** Any <button> still painting the UA button face (#6b6b6b in dark) instead of a token. */
  const buttonFaceCensus = (page) => page.evaluate(() => Array.from(document.querySelectorAll('button'))
    .filter((el) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && getComputedStyle(el).backgroundColor === 'rgb(107, 107, 107)';
    })
    .map((el) => ({ cls: String(el.className).slice(0, 60), text: (el.textContent || '').trim().slice(0, 20) })));

  if (SECTIONS.includes('dark')) {
    out.dark = {};
    const { ctx, page } = await newPage(browser, { w: 1440, h: 900, theme: 'dark', locale: 'en' });
    await page.goto('/admin/access');
    await page.waitForSelector('[data-async-state="ready"], [data-async-state="empty"]', { timeout: 20000 });
    await page.waitForTimeout(900);
    const rowBtn = page.locator('.ow-table tbody button, .ow-table tbody [class*=destructive]').filter({ hasText: /Disable/i }).first();
    const rowDisable = page.locator('[data-testid], .ow-table tbody').locator('button', { hasText: /^Disable$/ }).first();
    const useBtn = (await rowDisable.count()) ? rowDisable : rowBtn;
    out.dark.rowDisableHandle = await useBtn.count();
    if (await useBtn.count()) {
      await useBtn.evaluate((el) => el.setAttribute('data-probe-destructive', '1'));
      out.dark.rowDisable = await contrastInfo(page, '[data-probe-destructive]');
      await page.screenshot({ path: path.join(OUT, 'dark-access.png'), fullPage: true });
      await useBtn.click();
      await page.waitForSelector('[data-testid=confirm-dialog]', { timeout: 10000 });
      await page.waitForTimeout(400);
      out.dark.dialogClose = await contrastInfo(page, '[data-testid=confirm-dialog] button[type=button]');
      out.dark.dialogCloseExplicit = await contrastInfo(page, '[data-testid=confirm-dialog] > button');
      out.dark.dialogSubmit = await contrastInfo(page, '[data-confirm-submit]');
      out.dark.dialogSurface = await contrastInfo(page, '[data-testid=confirm-dialog]');
      out.dark.dialogButtonFace = await buttonFaceCensus(page);
      await page.screenshot({ path: path.join(OUT, 'dark-dialog.png') });
    }
    await page.screenshot({ path: path.join(OUT, 'dark-access-closed.png'), fullPage: true }).catch(() => {});
    out.dark.buttonFace = await buttonFaceCensus(page);
    await ctx.close();
  }

  if (SECTIONS.includes('mobile')) {
    out.mobile = {};
    for (const route of ['/admin/jobs', '/admin/plugins', '/admin/nodes', '/admin/activity']) {
      for (const locale of ['en', 'zh']) {
        const { ctx, page } = await newPage(browser, { w: 390, h: 844, theme: 'light', locale });
        await page.goto(route);
        await page.waitForSelector('[data-async-state="ready"], [data-async-state="empty"]', { timeout: 20000 });
        await page.waitForTimeout(700);
        out.mobile[route + '|' + locale] = await cards(page);
        await page.screenshot({ path: path.join(OUT, 'm' + route.replace(/\//g, '_') + '-' + locale + '.png'), fullPage: true });
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(OUT, '_probe.json'), JSON.stringify(out, null, 2));
// stdout stays small: the console is not a place to paste a report.
const brief = {
  studio: out.studio ? Object.fromEntries(Object.entries(out.studio).map(([k, v]) => [k, {
    header: v.header && v.header.h,
    actions: v.actionsBox && { x: v.actionsBox.x, w: v.actionsBox.w, clientW: v.actionsBox.clientW, scrollW: v.actionsBox.scrollW, overflowX: v.actionsBox.overflowX },
    nControls: v.controls.length,
    clipped: v.controlsClipped,
    rightmost: Math.max(...v.controls.map((c) => c.right)),
    desc: v.description,
    docOverflow: v.docOverflow,
    toolbar: v.toolbar,
    scrollers: v.scrollers,
  }])) : null,
  dark: out.dark,
  mobile: out.mobile ? Object.fromEntries(Object.entries(out.mobile).map(([k, v]) => [k, { p50: v.p50, heights: [Math.min(...v.heights), Math.max(...v.heights)], n: v.rows, factClipped: v.factClipped, when: v.when[0], occurred: v.occurredCells[0], meta: v.meta[0], docOverflow: v.docOverflow, sample0: v.samples[0] }])) : null,
};
console.log(JSON.stringify(brief, null, 1));
