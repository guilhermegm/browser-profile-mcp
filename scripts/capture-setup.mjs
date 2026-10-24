// Render the real panel HTML/CSS/JS with deterministic sample setup states.
// This captures documentation previews, not live agent/browser connections.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname, join } from 'node:path';
import { VERSION } from '../extension/protocol.js';

const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const output = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
const server = createServer(async (request, response) => {
  try {
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const path = resolve(extension, '.' + name);
    if (!path.startsWith(extension.endsWith(sep) ? extension : extension + sep)) {
      response.writeHead(403).end(); return;
    }
    const data = await readFile(path);
    response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
    response.end(data);
  } catch { response.writeHead(404).end(); }
});

let browser;
try {
  await mkdir(output, { recursive: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ channel: 'chromium', headless: true,
    args: ['--disable-gpu', '--disable-background-networking'] });
  const page = await browser.newPage({ viewport: { width: 360, height: 650 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const state = { ok: true, paired: false, enabled: false, connected: false,
      agentCount: 0, verifiedAgentCount: 0, clipboardAllowed: false, os: 'mac' };
    globalThis.chrome ??= {};
    globalThis.chrome.runtime = {
      id: 'a'.repeat(32),
      async sendMessage(message) {
        if (message.type !== 'status') throw new Error('Documentation capture only reads UI state.');
        return { ...state };
      },
    };
    globalThis.setDocumentationState = (next) => Object.assign(state, next);
  });
  await page.goto('http://127.0.0.1:' + server.address().port + '/sidepanel.html');
  const capture = async (name) => {
    await page.evaluate(async () => {
      await document.fonts.ready;
      window.scrollTo(0, 0);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    if (errors.length) throw new Error(errors.join('\n'));
    await page.screenshot({ path: join(output, name), animations: 'disabled' });
  };

  await page.locator('#bootstrap-profile').fill('work');
  await page.waitForFunction(() => !document.getElementById('copy-bootstrap').disabled);
  await capture(`01-pair-profile-v${VERSION}.png`);

  await page.evaluate(() => globalThis.setDocumentationState({
    paired: true, enabled: true, connected: true, profileId: 'work', name: 'work', port: 9333,
  }));
  await page.locator('#connected-step').waitFor({ state: 'visible' });
  await capture(`02-start-agent-v${VERSION}.png`);

  await page.evaluate(() => globalThis.setDocumentationState({ agentCount: 1, verifiedAgentCount: 1 }));
  await page.getByRole('heading', { name: "You're connected", exact: true }).waitFor();
  await capture(`03-connected-v${VERSION}.png`);
  console.log('Captured three real-panel UI previews with sample data in docs/screenshots/.');
} finally {
  await browser?.close();
  server.close();
  await once(server, 'close');
}
