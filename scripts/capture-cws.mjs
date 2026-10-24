// Capture the installed extension's real UI for the store, using only disposable
// credentials, a temporary browser profile, and a local sample page. No AI account,
// existing Chrome profile, saved pairing, clipboard, or OS permission is used.
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, cp, symlink, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../extension/protocol.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'branding/cws/screenshots');
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'browser-profile-mcp-cws-')));
const helper = join(temporary, 'helper');
const run = promisify(execFile);
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const env = { ...process.env };
delete env.BROWSER_MCP_PORT;
let context, bridge, client;
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Browser Profile MCP review page</title><main><h1>Review page</h1><p>A local page with no personal data.</p></main>');
});

const scenes = [
  { file: '01-setup-1280x800.png', heading: 'Your agent.\nYour existing Chrome.',
    intro: 'Connect your coding agent to the profile and tabs you already use.',
    steps: ['Name this profile.', 'Copy the prompt into your agent.', 'Paste the pairing code it returns.'],
    footer: 'Codex / Claude Code / Local MCP agents', state: 'Unpaired; profile name entered by the capture script.' },
  { file: '02-start-agent-1280x800.png', heading: 'Pair once.\nStart your agent.',
    intro: 'After saving the code, open a new agent session and send the message shown.',
    steps: ['Your agent starts the local bridge.', 'Your existing tabs stay in place.', 'Pairing is saved for next time.'],
    footer: 'Local Node.js bridge required / Node.js 20+', state: 'Real disposable pairing saved; no agent attached yet.' },
  { file: '03-connection-controls-1280x800.png', heading: 'Connected.\nYou stay in control.',
    intro: 'Manage the connection from Chrome’s side panel.',
    steps: ['Disconnect or stop current actions.', 'Choose whether to allow clipboard shortcuts.', 'Redo setup whenever you need to.'],
    footer: 'Your profile / Your coding agent', state: 'Real local SDK client attached and tabs listed; connection settings expanded.' },
];

try {
  await mkdir(output, { recursive: true });
  await cp(join(root, 'extension/local-helper'), helper, { recursive: true });
  await symlink(join(root, 'node_modules'), join(helper, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  // Reserve an ephemeral loopback port, then let the disposable bridge bind it.
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const { stdout } = await run(process.execPath, [join(helper, 'bridge.js'), 'profile', 'work', '--port', String(port)], { env });
  const code = /Pairing code for Chrome profile '[^']+':\s+([A-Za-z0-9_-]+)/.exec(stdout)?.[1];
  if (!code) throw new Error('Disposable helper did not return a pairing.');

  context = await chromium.launchPersistentContext(join(temporary, 'chrome'), {
    channel: 'chromium', headless: true, viewport: { width: 420, height: 690 },
    args: ['--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run',
      `--disable-extensions-except=${join(root, 'extension')}`, `--load-extension=${join(root, 'extension')}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).hostname;
  const panel = await context.newPage();
  panel.setDefaultTimeout(12000);
  const errors = [];
  panel.on('pageerror', error => errors.push(error.message));
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.locator('#bootstrap-profile').fill('work');
  await panel.waitForFunction(() => document.getElementById('error').hidden && !document.getElementById('copy-bootstrap').disabled);

  const font = (await readFile(join(root, 'extension/fonts/Geist.ttf'))).toString('base64');
  const icon = (await readFile(join(root, 'extension/icons/mark.png'))).toString('base64');
  const capture = async scene => {
    await panel.evaluate(async () => {
      await document.fonts.ready;
      document.activeElement?.blur();
      window.scrollTo(0, 0);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    if (errors.length) throw new Error(errors.join('\n'));
    if (await panel.locator('.more-controls[open]').count()) {
      const lastControl = await panel.locator('#forget').boundingBox();
      if (!lastControl || lastControl.y + lastControl.height > 690) {
        throw new Error('The final connection control would be clipped in the store capture.');
      }
    }
    const image = (await panel.screenshot({ animations: 'disabled' })).toString('base64');
    const layout = await context.newPage();
    try {
      await layout.setViewportSize({ width: 1280, height: 800 });
      await layout.setContent(`<!doctype html><html lang="en"><meta charset="utf-8"><style>
        @font-face{font-family:Geist;src:url(data:font/ttf;base64,${font}) format('truetype');font-weight:100 900}
        *{box-sizing:border-box}body{margin:0;background:#faf9f6;color:#17181b;font-family:Geist,sans-serif}
        main{position:relative;width:1280px;height:800px;overflow:hidden}
        header{position:absolute;left:56px;top:52px;display:flex;align-items:center;gap:12px;font-size:21px;font-weight:600;letter-spacing:-.5px}
        header img{width:46px;height:46px}h1{position:absolute;left:60px;top:153px;margin:0;font-size:53px;font-weight:600;line-height:1.08;letter-spacing:-2.1px;white-space:pre-line}
        .intro{position:absolute;left:60px;top:301px;width:620px;font-size:24px;line-height:1.4;color:#64666b;margin:0}
        ul{position:absolute;left:60px;top:424px;margin:0;padding:0;list-style:none;width:650px}li{display:flex;gap:14px;align-items:center;margin:0 0 24px;font-size:20px;line-height:1.4}li:before{content:'';width:6px;height:6px;background:#ce482e;border-radius:50%;flex:0 0 auto}
        footer{position:absolute;bottom:48px;left:60px;color:#64666b;font-size:13px;border-top:1px solid #e4e3de;padding-top:22px;width:658px}
        .panel-label{position:absolute;top:29px;left:797px;font-size:11px;color:#64666b;letter-spacing:.02em}
        .panel{position:absolute;left:796px;top:54px;width:422px;height:692px;border:1px solid #deded8;display:block}
        </style><main><header><img src="data:image/png;base64,${icon}" alt="">Browser Profile MCP</header>
        <h1>${scene.heading}</h1><p class="intro">${scene.intro}</p>
        <ul>${scene.steps.map(step => `<li>${step}</li>`).join('')}</ul><footer>${scene.footer}</footer>
        <span class="panel-label">Actual extension panel · v${VERSION}</span>
        <img class="panel" src="data:image/png;base64,${image}" alt="Actual Browser Profile MCP panel"></main></html>`);
      await layout.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.decode())); });
      await layout.screenshot({ path: join(output, scene.file), animations: 'disabled' });
    } finally { await layout.close(); }
  };
  await capture(scenes[0]);

  bridge = spawn(process.execPath, [join(helper, 'bridge.js')], {
    cwd: helper, env: { ...env, BROWSER_MCP_PORT: String(port) }, stdio: 'ignore',
  });
  const deadline = Date.now() + 8000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (bridge.exitCode !== null) throw new Error('Disposable bridge could not bind its port.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      const info = await response.json();
      if (info.version === VERSION && info.stateDirectory === join(helper, '.browser-mcp/')) { healthy = true; break; }
    } catch {}
    await pause(100);
  }
  if (!healthy) throw new Error('Disposable bridge did not become available.');
  await panel.locator('#pairing-code').fill(code);
  await panel.locator('#pair').click();
  await panel.locator('#connected-step').waitFor({ state: 'visible' });
  await panel.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'status' })).connected);
  await panel.getByRole('heading', { name: 'Connect your agent', exact: true }).waitFor();
  await capture(scenes[1]);

  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const sample = await context.newPage();
  await sample.goto(`http://127.0.0.1:${server.address().port}/`);
  client = new Client({ name: 'store-screenshot', version: '1.0.0' }, {
    supportedProtocolVersions: ['2025-11-25', '2025-06-18', '2025-03-26'], versionNegotiation: { mode: 'legacy' },
  });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [join(helper, 'mcp.js'), 'work', '--port', String(port)], cwd: helper, env, stderr: 'ignore' }), { timeout: 10000 });
  const result = await client.callTool({ name: 'tabs', arguments: {} });
  if (result.isError) throw new Error('The disposable SDK client could not list tabs.');
  await panel.getByRole('heading', { name: "You're connected", exact: true }).waitFor();
  await panel.locator('.more-controls').evaluate(element => { element.open = true; });
  await capture(scenes[2]);
  await writeFile(join(output, 'capture-info.json'), JSON.stringify({
    extensionVersion: VERSION, browser: context.browser().version(), dimensions: [1280, 800],
    method: 'Real installed extension in a disposable headless Chromium profile; original panel pixels composed with explanatory captions.',
    controller: 'Local stdio MCP SDK client; no AI provider or real user account.',
    data: 'Disposable profile named work and a loopback sample page; no saved user pairings, clipboard, or personal Chrome data.',
    limitations: 'These captures do not verify Codex/Claude registration, real account sessions, cursor actions, or the complete browser test suite.',
    images: scenes.map(({ file, state }) => ({ file, state })),
  }, null, 2) + '\n');
  console.log('Captured three 1280x800 store images from the real extension. No existing profile or AI account was used.');
} finally {
  await client?.close().catch(() => {});
  if (bridge && bridge.exitCode === null) {
    const exit = once(bridge, 'exit');
    bridge.kill('SIGTERM');
    const timer = setTimeout(() => bridge.kill('SIGKILL'), 2000);
    await exit; clearTimeout(timer);
  }
  await context?.close();
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
