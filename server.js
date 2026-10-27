const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const state = { running: false, stopped: false, total: 0, done: 0, log: [] };
let stopRequested = false;
let activeCtx = null;
const log = (m) => { state.log.push(`${new Date().toLocaleTimeString()}  ${m}`); console.log(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const safeName = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim();

// dd/mm/yy h:mm PM
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const h = d.getHours();
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ${h % 12 || 12}:${p(d.getMinutes())} ${h >= 12 ? 'PM' : 'AM'}`;
}

async function savePdf(page, file, title, query) {
  const date = stamp();
  const url = page.url();
  const base = 'font-size:8px;font-family:Arial,sans-serif;width:100%;padding:0 12mm;box-sizing:border-box;';
  const headerTemplate =
    `<div style="${base}display:flex;align-items:center;">` +
    `<span style="flex:1;text-align:left;">${esc(date)}</span>` +
    `<span style="flex:3;text-align:center;font-size:9px;">${esc(title)}</span>` +
    `<span style="flex:1;"></span></div>`;
  const footerTemplate =
    `<div style="${base}display:flex;align-items:center;">` +
    `<span style="flex:6;text-align:left;word-break:break-all;font-size:7px;">${esc(url)}</span>` +
    `<span style="flex:1;text-align:right;"><span class="pageNumber"></span></span></div>`;

  // Google's search box text doesn't render in print mode, so show the query as plain text
  await page.evaluate((q) => {
    const el = document.querySelector('textarea[name="q"], input[name="q"]');
    if (!el) return;
    el.value = q;
    const cs = getComputedStyle(el);
    const box = document.createElement('div');
    box.textContent = q;
    Object.assign(box.style, {
      flex: '1', minWidth: '0', fontFamily: cs.fontFamily, fontSize: cs.fontSize,
      lineHeight: cs.lineHeight, color: '#1f1f1f', overflow: 'hidden',
      whiteSpace: 'nowrap', textOverflow: 'ellipsis'
    });
    el.style.display = 'none';
    el.parentNode.insertBefore(box, el);
  }, query);

  // CDP printToPDF works in both headless and headed mode
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.printToPDF', {
    displayHeaderFooter: true,
    headerTemplate,
    footerTemplate,
    printBackground: true,
    paperWidth: 8.27,   // A4
    paperHeight: 11.69,
    marginTop: 0.6,
    marginBottom: 0.6,
    marginLeft: 0.3,
    marginRight: 0.3,
  });
  await cdp.detach();
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
}

async function run({ companies, keywords, folder, showBrowser }) {
  state.running = true; state.stopped = false; state.done = 0; state.log = [];
  stopRequested = false;
  state.total = companies.length * keywords.length;
  fs.mkdirSync(folder, { recursive: true });

  const profile = path.join(__dirname, '.browser-profile');
  const opts = { headless: !showBrowser, viewport: { width: 1280, height: 900 }, locale: 'en-US' };
  let ctx;
  try { ctx = await chromium.launchPersistentContext(profile, { ...opts, channel: 'chrome' }); }
  catch { ctx = await chromium.launchPersistentContext(profile, opts); }
  activeCtx = ctx;
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.emulateMedia({ media: 'screen' });

  try {
    outer:
    for (const company of companies) {
      for (const keyword of keywords) {
        if (stopRequested) break outer;
        const title = `${company} ${keyword} - Google Search`;
        const file = path.join(folder, safeName(title) + '.pdf');
        const url = `https://www.google.com/search?q=${encodeURIComponent(`${company} ${keyword}`)}&hl=en`;
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded' });

          // Cookie / consent dialog, if any
          for (const label of ['Reject all', 'Accept all']) {
            const btn = page.getByRole('button', { name: label }).first();
            if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); break; }
          }

          // CAPTCHA ("unusual traffic")
          if (page.url().includes('/sorry/')) {
            if (!showBrowser) throw new Error('Google showed a CAPTCHA. Re-run with "Show browser" ticked and solve it.');
            log('CAPTCHA detected - solve it in the browser window (waiting up to 3 min)...');
            await page.waitForURL((u) => !u.href.includes('/sorry/'), { timeout: 180000 });
            await page.goto(url, { waitUntil: 'domcontentloaded' });
          }

          await page.waitForSelector('#search, #rso, #main', { timeout: 15000 }).catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          await savePdf(page, file, title, `${company} ${keyword}`);
          log(`Saved: ${path.basename(file)}`);
        } catch (e) {
          if (stopRequested) break outer; // browser was closed on purpose
          log(`FAILED: ${title} - ${e.message}`);
        }
        state.done++;
        await sleep(3000 + Math.random() * 3000); // be gentle with Google
      }
    }
  } finally {
    await ctx.close().catch(() => {});
    activeCtx = null;
    state.stopped = stopRequested;
    state.running = false;
    log(stopRequested ? `Stopped. ${state.done}/${state.total} processed.` : `Finished. ${state.done}/${state.total} processed.`);
  }
}

app.post('/api/start', (req, res) => {
  if (state.running) return res.status(409).json({ error: 'A run is already in progress.' });
  const clean = (a) => [...new Set((a || []).map((s) => String(s).trim()).filter(Boolean))];
  const companies = clean(req.body.companies);
  const keywords = clean(req.body.keywords);
  const folder = String(req.body.folder || '').trim();
  if (!companies.length || !keywords.length || !folder)
    return res.status(400).json({ error: 'Companies, keywords and folder path are all required.' });
  run({ companies, keywords, folder, showBrowser: !!req.body.showBrowser })
    .catch((e) => { log(`ERROR: ${e.message}`); state.running = false; });
  res.json({ ok: true, total: companies.length * keywords.length });
});

app.post('/api/stop', (_req, res) => {
  if (!state.running) return res.json({ ok: true });
  stopRequested = true;
  log('Stop requested - closing the browser...');
  if (activeCtx) activeCtx.close().catch(() => {}); // interrupts a search or CAPTCHA wait in progress
  res.json({ ok: true });
});

app.get('/api/status', (_req, res) => res.json(state));

app.listen(3000, () => console.log('Open http://localhost:3000'));
