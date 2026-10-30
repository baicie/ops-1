import { test, expect, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * B2 - a long identifier on the job detail page, at 390.
 *
 * The 390 review found the record and the structured fields *broken character by character*: a
 * 36-character UUID or a 71-character `sha256:` digest in a mono run inside a 300px column has a
 * min-content width of one character, and the `@media (max-width: 768px) .main-content .mono`
 * rule ("the container never scrolls on a phone") then spends it - one character per line, 36
 * lines tall, and the operator reads a column of letters.
 *
 * "DOM has no horizontal overflow" was the assertion that let that ship. This spec measures the
 * thing a reader feels instead: how many characters share a line, and how many line boxes a
 * single identifier is spent on. A long run is ONE line - truncated with the full value in the
 * tooltip and in the copy target, or inside a bounded scroll region - and the page still does not
 * scroll sideways.
 *
 * Data: real. Test 1 reads whatever the live Kernel serves (no fixture, no stub). Test 2 replays
 * a byte-verbatim capture from staging (2026-10-30, job e273620e-0580-449f-b7ee-e23e3f065b9e)
 * because the live Kernel of a fresh checkout has no checkpoints, and the digest is exactly the
 * field this fix is about. Neither test invents a value the Kernel never produced.
 *
 *   B2_MODE=before pnpm --filter @opsweave/ui-tests test b2-job-detail-longid   # record the defect
 *   B2_MODE=after  pnpm --filter @opsweave/ui-tests test b2-job-detail-longid   # assert the fix
 */

test.use({ channel: process.env.V3_CHANNEL || 'chrome' });

const MODE: 'before' | 'after' = process.env.B2_MODE === 'after' ? 'after' : 'before';
const OUT = process.env.B2_OUT || path.resolve('../../artifacts/ui/visual-v3/b2', MODE);
const BASE = process.env.OPSWEAVE_URL || 'http://127.0.0.1:5173';
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const VIEWPORTS = [{ w: 1440, h: 900, name: '1440' }, { w: 390, h: 844, name: '390' }];

/** A capture from staging, verbatim: the only place in the repo that carries a real digest. */
const STAGING_JOB = {"jobId":"e273620e-0580-449f-b7ee-e23e3f065b9e","pipelineId":"host-metrics-pipeline","pipelineRevision":9,"status":"SUCCEEDED","currentFence":1,"currentLeaseId":"dc77f93c-6f4f-40a4-ada6-3b4e24e44814","attempts":1,"maxAttempts":3,"lastErrorCode":null,"startedAt":"2026-10-29T16:07:49.388453Z","finishedAt":"2026-10-29T16:07:49.452261Z","createdAt":"2026-10-29T16:07:47.626048Z","updatedAt":"2026-10-29T16:07:49.452261Z"};
const STAGING_DIAGNOSTICS = {"jobId":"e273620e-0580-449f-b7ee-e23e3f065b9e","events":[{"eventId":71,"eventType":"JOB_SUBMITTED","fromStatus":null,"toStatus":"QUEUED","fencingSequence":null,"details":{"idempotencyKey":"fb03fd5a-5ee8-41c0-b67f-74b46c296d64"},"occurredAt":"2026-10-29T16:07:47.626048Z"},{"eventId":72,"eventType":"JOB_CLAIMED","fromStatus":"QUEUED","toStatus":"CLAIMED","fencingSequence":1,"details":{"workerVersion":"0.0.3"},"occurredAt":"2026-10-29T16:07:49.383573Z"},{"eventId":73,"eventType":"JOB_STARTED","fromStatus":"CLAIMED","toStatus":"RUNNING","fencingSequence":1,"details":{},"occurredAt":"2026-10-29T16:07:49.388453Z"},{"eventId":74,"eventType":"JOB_SNAPSHOT_PINNED","fromStatus":null,"toStatus":null,"fencingSequence":1,"details":{"sourceDigest":"sha256:51acfce60ce9c687a978d68656eee648763568cdce42f49ef866a0241a39b6d4","sourceLength":145},"occurredAt":"2026-10-29T16:07:49.397221Z"},{"eventId":75,"eventType":"JOB_CHECKPOINTED","fromStatus":null,"toStatus":null,"fencingSequence":1,"details":{"checkpointId":"51a33797-45b5-4ad4-9c17-ad8573c5751c","sequence":1},"occurredAt":"2026-10-29T16:07:49.409753Z"},{"eventId":76,"eventType":"JOB_COMPLETED","fromStatus":"RUNNING","toStatus":"SUCCEEDED","fencingSequence":1,"details":{"errorCode":null,"status":"SUCCEEDED"},"occurredAt":"2026-10-29T16:07:49.452261Z"}],"attempts":[{"attemptNumber":1,"workerId":"n:9b426dab-27c4-45ce-9773-b51a3db4f246:i:01bf9675-1f3e-4cd0-b9b3-b9ae1b4e0d68:b:58be2459-d92e-43fb-98d5-18162de3f755","nodeId":"9b426dab-27c4-45ce-9773-b51a3db4f246","instanceId":"01bf9675-1f3e-4cd0-b9b3-b9ae1b4e0d68","leaseId":"dc77f93c-6f4f-40a4-ada6-3b4e24e44814","fencingSequence":1,"status":"SUCCEEDED","startedAt":"2026-10-29T16:07:49.383573Z","finishedAt":"2026-10-29T16:07:49.452261Z","errorCode":null}],"leases":[{"leaseId":"dc77f93c-6f4f-40a4-ada6-3b4e24e44814","attemptNumber":1,"fencingSequence":1,"status":"RELEASED","acquiredAt":"2026-10-29T16:07:49.383573Z","heartbeatAt":"2026-10-29T16:07:49.413517Z","expiresAt":"2026-10-29T16:08:49.383573Z","releasedAt":"2026-10-29T16:07:49.452261Z"}],"checkpoints":[{"checkpointId":"51a33797-45b5-4ad4-9c17-ad8573c5751c","attemptNumber":1,"sequence":1,"fencingSequence":1,"inputCursor":"batch:0","stateDigest":"sha256:64043eff005f46dd9b5dd254e664c4518f3f0409c894d9b5e3a306f59d9e7eb0","createdAt":"2026-10-29T16:07:49.409753Z"}],"result":{"jobId":"e273620e-0580-449f-b7ee-e23e3f065b9e","status":"SUCCEEDED","output":{"accepted":3,"batches":1},"errorCode":null,"errorMessage":null,"resultDigest":"sha256:476a6efd50469ead43abdfb6313d09601ecf4a23f2c8127158eb5a52b238da96","completedAt":"2026-10-29T16:07:49.452261Z"},"truncated":false};

interface Run {
  text: string;
  length: number;
  lines: number;
  charsPerLine: number;
  charWidth: number;
  boxWidth: number;
  whiteSpace: string;
  scroller: string | null;
  clip: number;
  /** `title` is display type (the page's h1); `field` is a value in a record or a table. */
  role: 'title' | 'field';
}

/**
 * Every unbroken token of 20 characters or more in the content area - the UUIDs, the digests,
 * the lease ids. `lines` is the count of line boxes the run occupies, so one character per line
 * is `lines === length`; the fix is `lines === 1`.
 */
async function measureLongRuns(page: Page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const runs: unknown[] = [];
    for (const el of Array.from(document.querySelectorAll('#main-content *'))) {
      if (el.children.length > 0) continue;
      const text = (el.textContent || '').trim();
      if (text.length < 20 || /\s/.test(text)) continue;
      const style = getComputedStyle(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
      // A line box is a vertical position. Chrome splits a horizontally clipped run into several
      // rects that share one top - counting rects alone called ellipsis the same thing as a wrap.
      const lines = new Set(rects.map((rect) => Math.round(rect.top))).size;
      let scroller: string | null = null;
      for (let node = el.parentElement; node; node = node.parentElement) {
        const s = getComputedStyle(node);
        if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 1) {
          scroller = node.className || node.tagName;
          break;
        }
      }
      if (ctx) ctx.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
      const charWidth = ctx ? Math.round(ctx.measureText('0').width * 100) / 100 : 0;
      const box = el.getBoundingClientRect();
      runs.push({
        text: text.slice(0, 40),
        length: text.length,
        lines: Math.max(1, lines),
        charsPerLine: lines ? Math.round((text.length / lines) * 10) / 10 : 0,
        charWidth,
        boxWidth: Math.round(box.width * 10) / 10,
        whiteSpace: style.whiteSpace,
        scroller,
        clip: el.scrollWidth - el.clientWidth,
        role: el.closest('h1,h2,h3,h4,h5,h6') ? 'title' : 'field',
      });
    }
    return { clientWidth: de.clientWidth, scrollWidth: de.scrollWidth, bodyScrollWidth: document.body.scrollWidth, runs: runs as Run[] };
  });
}

async function signIn(contextPage: Page) {
  await contextPage.goto(BASE + '/login');
  await contextPage.fill('input[type=email]', ADMIN_EMAIL);
  await contextPage.fill('input[type=password]', ADMIN_PASSWORD);
  await contextPage.click('[data-testid=login-submit]');
  await contextPage.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
}

async function open(browser: Browser, width: number, height: number) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    baseURL: BASE,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.addInitScript(() => {
    localStorage.setItem('opsweave-theme', 'light');
    localStorage.setItem('opsweave-locale', 'en');
  });
  const page = await context.newPage();
  await signIn(page);
  return { context, page };
}

/** The live Kernel's own longest pipelineId: a real job, not a fixture. */
async function realJobId(page: Page): Promise<string> {
  if (process.env.B2_JOB_ID) return process.env.B2_JOB_ID;
  const list = await page.evaluate(async () => {
    const res = await fetch('/api/v1/jobs?limit=20');
    return res.json();
  });
  const items: Array<{ jobId: string; pipelineId: string }> = (list as { items: Array<{ jobId: string; pipelineId: string }> }).items || [];
  if (items.length === 0) throw new Error('b2: the live Kernel served no jobs - nothing real to measure');
  return [...items].sort((a, b) => b.pipelineId.length - a.pipelineId.length || a.jobId.localeCompare(b.jobId))[0].jobId;
}

test.beforeAll(() => { fs.mkdirSync(OUT, { recursive: true }); });
test.setTimeout(180_000);

test('job detail: real long ids at 390 and 1440', async ({ browser }) => {
  const report: Record<string, unknown> = { mode: MODE, base: BASE };
  for (const viewport of VIEWPORTS) {
    const { context, page } = await open(browser, viewport.w, viewport.h);
    const jobId = await realJobId(page);
    report.jobId = jobId;
    await page.goto(BASE + '/admin/jobs/' + jobId);
    await page.waitForSelector('#main-content h1', { timeout: 20000 });
    await page.waitForTimeout(800);
    // The record is one disclosure away on the default page: open it, or the fields the review
    // measured are not on screen and a green run would mean "measured nothing".
    for (const summary of await page.$$('#main-content details.advanced > summary')) await summary.click();
    await page.waitForTimeout(200);
    const measured = await measureLongRuns(page);
    report['v' + viewport.name] = measured;
    // The field the review named. Measured by heading, not by column index, so the probe reads the
    // same cell before and after the fix (a long id is a run of 36 characters before it, and a
    // four-character disambiguator after it - the run scanner would stop seeing the second).
    const nodeCell = await page.evaluate(() => {
      for (const table of Array.from(document.querySelectorAll('#main-content table'))) {
        const heads = Array.from(table.querySelectorAll('thead th')).map((th) => (th.textContent || '').trim());
        const index = heads.indexOf('Node');
        if (index < 0) continue;
        const cell = table.querySelectorAll('tbody tr')[0] ? (table.querySelectorAll('tbody tr')[0].children[index] as HTMLElement | undefined) : undefined;
        if (!cell) continue;
        const leaf = cell.querySelector('.ow-longid-value') || cell;
        const text = (leaf.textContent || '').trim();
        const range = document.createRange();
        range.selectNodeContents(leaf);
        const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
        return {
          shown: text,
          chars: text.length,
          lines: Math.max(1, new Set(rects.map((r) => Math.round(r.top))).size),
          width: Math.round(leaf.getBoundingClientRect().width * 10) / 10,
          title: leaf.getAttribute('title'),
        };
      }
      return null;
    });
    report['nodeCell' + viewport.name] = nodeCell;
    await page.screenshot({ path: path.join(OUT, 'job-detail-' + viewport.name + '.png'), fullPage: true });
    // What a phone actually shows on arrival: the scroll position the operator opens on, not a
    // 1900px page with the fixed skip link painted across the middle of it.
    await page.screenshot({ path: path.join(OUT, 'job-detail-' + viewport.name + '-viewport.png') });
    if (viewport.w === 390) {
      const short = page.locator('[data-testid=job-short-id]');
      report.shortId = (await short.count()) ? (await short.first().innerText()).trim() : null;
      report.shortIdTitle = (await short.count()) ? await short.first().getAttribute('title') : null;
      await context.close();
      continue;
    }
    await context.close();
  }
  fs.writeFileSync(path.join(OUT, 'job-detail.json'), JSON.stringify(report, null, 1));

  const wide = report['v390'] as { clientWidth: number; scrollWidth: number; runs: Run[] };
  expect(wide.scrollWidth, 'the page must not scroll sideways at 390').toBeLessThanOrEqual(wide.clientWidth + 1);
  if (MODE === 'after') {
    // A heading is display type: it wraps like a long word and that is what a title does. The same
    // string in a FIELD must not wrap - that is the defect, and it is measured separately.
    const fields = wide.runs.filter((run) => run.role === 'field');
    expect(fields, 'the fixture page must still carry the long fields').not.toEqual([]);
    const broken = fields.filter((run) => run.lines >= run.length * 0.75);
    expect(broken.map((run) => run.text), 'a long id must not be broken character by character').toEqual([]);
    const multi = fields.filter((run) => run.lines > 1);
    expect(multi.map((run) => ({ text: run.text, lines: run.lines })), 'a long field is one line, truncated or scrolled').toEqual([]);
    const cell = report['nodeCell390'] as { shown: string; lines: number; title: string | null } | null;
    expect(cell, 'the attempts table still has a Node column').toBeTruthy();
    expect(cell!.lines, 'the node id in the attempts table is one line').toBe(1);
    expect(cell!.title, 'the full node id is in the tooltip').toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(cell!.shown.length, 'the cell shows a readable short id, not the whole 36 characters').toBeLessThanOrEqual(8);
  } else {
    console.log('B2 before:', JSON.stringify(wide.runs.map((r) => ({ t: r.text.slice(0, 18), n: r.length, lines: r.lines, cpl: r.charsPerLine, w: r.boxWidth }))));
  }
});

test('job detail: the full id is still copyable and viewable', async ({ browser }) => {
  const { context, page } = await open(browser, 390, 844);
  const jobId = await realJobId(page);
  await page.goto(BASE + '/admin/jobs/' + jobId);
  await page.waitForSelector('#main-content h1', { timeout: 20000 });
  await page.waitForTimeout(600);
  for (const summary of await page.$$('#main-content details.advanced > summary')) await summary.click();
  const copy = page.locator('[data-testid=job-id-full-copy]');
  const view = page.locator('[data-testid=job-id-full]');
  const evidence = {
    mode: MODE,
    jobId,
    copyCount: await copy.count(),
    viewCount: await view.count(),
    viewText: (await view.count()) ? (await view.first().innerText()).trim() : null,
    viewBox: (await view.count()) ? await view.first().evaluate((el) => {
      const s = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height), whiteSpace: s.whiteSpace, overflowX: s.overflowX, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    }) : null,
    rowDom: null as string | null,
    clipboard: null as string | null,
  };
  if (await view.count()) {
    evidence.rowDom = await page.locator('#main-content .kv:has([data-testid=job-id-full])').first().evaluate((el) => el.outerHTML);
  }
  if (await copy.count()) {
    await copy.first().click();
    evidence.clipboard = await page.evaluate(() => navigator.clipboard.readText());
  }
  fs.writeFileSync(path.join(OUT, 'job-id-access.json'), JSON.stringify(evidence, null, 1));
  console.log('B2 id access:', JSON.stringify(evidence));
  if (MODE === 'after') {
    expect(evidence.copyCount, 'the copy affordance is on the record').toBe(1);
    expect(evidence.viewCount, 'the full id is on screen, not only in a title').toBe(1);
    expect(evidence.viewText).toBe(jobId);
    expect(evidence.clipboard, 'copy puts the WHOLE id on the clipboard').toBe(jobId);
  }
  await context.close();
});

test('job detail: a real sha256 checkpoint digest stays on one line at 390', async ({ browser }) => {
  const { context, page } = await open(browser, 390, 844);
  const jobId = STAGING_JOB.jobId;
  await page.route('**/api/v1/jobs/' + jobId + '**', async (route) => {
    const url = new URL(route.request().url());
    const suffix = url.pathname.split(jobId)[1] || '';
    const body = suffix.startsWith('/diagnostics') ? STAGING_DIAGNOSTICS
      : suffix.startsWith('/result') ? STAGING_DIAGNOSTICS.result
      : STAGING_JOB;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(BASE + '/admin/jobs/' + jobId);
  await page.waitForSelector('#main-content h1', { timeout: 20000 });
  await page.waitForTimeout(700);
  const measured = await measureLongRuns(page);
  await page.screenshot({ path: path.join(OUT, 'job-detail-digest-390.png'), fullPage: true });
  fs.writeFileSync(path.join(OUT, 'digest-390.json'), JSON.stringify(measured, null, 1));
  const digest = measured.runs.find((run) => run.text.startsWith('sha256:64043eff'));
  const timing = await page.evaluate(() => ({
    timeline: document.querySelectorAll('#main-content .timeline li').length,
    attempts: Array.from(document.querySelectorAll('#main-content table tbody tr')).length,
    checkpoints: Array.from(document.querySelectorAll('#main-content .detail-list li')).length,
  }));
  console.log('B2 digest:', JSON.stringify({ digest, timing, overflow: measured.scrollWidth - measured.clientWidth }));
  expect(measured.scrollWidth, 'the page must not scroll sideways at 390').toBeLessThanOrEqual(measured.clientWidth + 1);
  // §2.5's three panels are still the three panels: timeline, attempts, checkpoints.
  expect(timing.timeline, 'the timeline keeps its six events').toBe(6);
  expect(timing.attempts, 'the attempts table still carries its row').toBeGreaterThanOrEqual(1);
  expect(digest, 'the digest is rendered').toBeTruthy();
  const relations = await page.evaluate(() => {
    const panels = Array.from(document.querySelectorAll('#main-content section.panel'));
    const heading = (panel: Element) => (panel.querySelector('h2')?.textContent || '').trim();
    const checkpoints = panels.find((panel) => heading(panel) === 'Checkpoints');
    return {
      panels: panels.map(heading).filter(Boolean),
      checkpointItems: checkpoints ? checkpoints.querySelectorAll('.detail-list li').length : 0,
      checkpointLabel: checkpoints ? (checkpoints.querySelector('.detail-list li > span')?.textContent || '').trim() : null,
      attemptHeaders: Array.from(document.querySelectorAll('#main-content table thead th')).map((th) => (th.textContent || '').trim()),
      attemptRows: document.querySelectorAll('#main-content table tbody tr').length,
      timelineItems: document.querySelectorAll('#main-content .timeline li').length,
      timelineTypes: Array.from(document.querySelectorAll('#main-content .timeline li strong')).map((strong) => (strong.textContent || '').trim()),
    };
  });
  fs.writeFileSync(path.join(OUT, 'relations-390.json'), JSON.stringify(relations, null, 1));
  console.log('B2 relations:', JSON.stringify(relations));

  const fields = await page.evaluate(() => Array.from(document.querySelectorAll('#main-content .ow-longid-value'))
    .map((el) => ({ shown: (el.textContent || '').trim(), title: el.getAttribute('title') })));
  fs.writeFileSync(path.join(OUT, 'digest-fields.json'), JSON.stringify(fields, null, 1));
  console.log('B2 fields:', JSON.stringify(fields));
  // The whole value never left the screen: it is in the tooltip of the shortened form.
  if (MODE === 'after') {
    expect(fields.some((field) => field.title === STAGING_DIAGNOSTICS.checkpoints[0].stateDigest), 'the full digest is in the tooltip').toBe(true);
    expect(fields.some((field) => field.title === STAGING_DIAGNOSTICS.attempts[0].nodeId), 'the full node id is in the tooltip').toBe(true);
    const copyDigest = page.locator('.ow-longid:has([title="' + STAGING_DIAGNOSTICS.checkpoints[0].stateDigest + '"]) .icon-btn');
    expect(await copyDigest.count(), 'the digest has its own copy control').toBe(1);
    await copyDigest.first().click();
    expect(await page.evaluate(() => navigator.clipboard.readText()), 'the copy puts the WHOLE digest on the clipboard').toBe(STAGING_DIAGNOSTICS.checkpoints[0].stateDigest);
    expect(digest!.lines, 'the digest is one line').toBe(1);
    // Requirement 5: shortening a value is not allowed to break what the three panels say or the
    // link between them - the checkpoint still names its attempt and sequence, the attempts table
    // keeps its five columns, and both events are still in the timeline.
    expect(relations.checkpointLabel, 'the checkpoint still names its attempt and sequence').toBe('Attempt 1 · sequence 1');
    expect(relations.attemptHeaders).toEqual(['Attempt', 'Status', 'Fence', 'Node', 'Started']);
    expect(relations.attemptRows, 'one attempt, one row').toBe(1);
    expect(relations.timelineItems, 'six events, six timeline entries').toBe(6);
    expect(relations.timelineTypes).toContain('JOB_CHECKPOINTED');
    expect(relations.timelineTypes).toContain('JOB_COMPLETED');
  }
  await context.close();
});
