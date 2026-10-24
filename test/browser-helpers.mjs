import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { chromium } from 'playwright';
import { until, stopChild, delay } from './helpers.mjs';

// Attach only to the panel, never to inspected tabs or the extension worker.
// This leaves chrome.debugger exclusive control and lets MV3 idle normally.
class Cdp extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.nextId = 0; this.pending = new Map();
    socket.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else this.emit('event', message);
    });
    socket.on('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Test browser disconnected')); }
      this.pending.clear();
    });
  }
  async send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

export async function browser(f, name = 'browser') {
  const userData = join(f.root, name);
  await mkdir(userData, { recursive: true });
  let child; let cdp; let extensionId;
  const extensionPath = join(f.root, 'extension');
  const normalizedPath = process.platform === 'win32' ? extensionPath.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : extensionPath;
  const expectedId = createHash('sha256').update(Buffer.from(normalizedPath, process.platform === 'win32' ? 'utf16le' : 'utf8'))
    .digest('hex').slice(0,32).replace(/[0-9a-f]/g, (hex) => String.fromCharCode(97 + Number.parseInt(hex,16)));
  const b = {
    async start() {
      child = spawn(chromium.executablePath(), [
        '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userData}`,
        '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--no-proxy-server',
        '--disable-component-update', '--disable-sync',
        `--disable-extensions-except=${join(f.root, 'extension')}`,
        `--load-extension=${join(f.root, 'extension')}`,
        'about:blank',
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = ''; child.stderr.on('data', (data) => { stderr += data; });
      const endpoint = await until(async () => {
        if (child.exitCode !== null) throw new Error(`Browser exited: ${stderr}`);
        const [port, path] = (await readFile(join(userData, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
        return `ws://127.0.0.1:${port}${path}`;
      }, { timeout: 15000, label: 'isolated browser debugging endpoint' });
      const socket = new WebSocket(endpoint); await once(socket, 'open'); cdp = new Cdp(socket);
      const info = await cdp.send('Browser.getVersion'); b.version = info.product;
      extensionId = await until(async () => {
        const { targetInfos } = await cdp.send('Target.getTargets');
        const target = targetInfos.find((item) => item.type === 'service_worker' && item.url === `chrome-extension://${expectedId}/background.js`);
        return target?.url.split('/')[2];
      }, { timeout: 15000, label: 'loaded extension worker' });
      return b;
    },
    async stop() {
      if (cdp) cdp.socket.close();
      if (child) await stopChild(child);
      cdp = undefined; child = undefined;
      // A previous debugging endpoint must not be mistaken for a restarted browser.
      const { rm } = await import('node:fs/promises'); await rm(join(userData, 'DevToolsActivePort'), { force: true });
    },
    async panel() {
      const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel.html` });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Page.enable', {}, sessionId);
      const errors = [];
      cdp.on('event', (event) => { if (event.sessionId === sessionId && event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text); });
      const panel = {
        errors,
        async evaluate(expression) {
          const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
          return result.result.value;
        },
        async pair(code) {
          await panel.evaluate(`document.getElementById('pairing-code').value=${JSON.stringify(code)}`);
          await panel.click('pair');
          await until(async () => panel.evaluate(`document.getElementById('connected-step').hidden === false`), { label: 'pairing saved' });
        },
        async state() { return panel.evaluate(`chrome.runtime.sendMessage({type:'status'})`); },
        async text(id) { return panel.evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`); },
        async click(id) {
          const point = await panel.evaluate(`(()=>{const element=document.getElementById(${JSON.stringify(id)});element.scrollIntoView({block:'center'});const box=element.getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2}})()`);
          await cdp.send('Input.dispatchMouseEvent', { type:'mousePressed', ...point, button:'left', clickCount:1 }, sessionId);
          await cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased', ...point, button:'left', clickCount:1 }, sessionId);
        },
        async choose(id, value) { return panel.evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)}; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change',{bubbles:true}));`); },
        async close() { await cdp.send('Target.closeTarget', { targetId }); },
      };
      try {
        await until(async () => {
          // A worker target can appear just before a newly installed extension's
          // resources are navigable. Retry only this bootstrap navigation, never
          // an application action or a page controlled by the MCP server.
          const location = await panel.evaluate('location.href');
          if (location.startsWith('chrome-error:')) {
            await delay(150);
            await cdp.send('Page.navigate', { url: `chrome-extension://${extensionId}/sidepanel.html` }, sessionId);
            return false;
          }
          return panel.evaluate(`document.readyState === 'complete' && !!document.getElementById('profile-name') && document.getElementById('error').hidden`);
        }, { label: 'onboarding panel ready' });
      } catch (error) {
        const detail = await panel.evaluate(`({url:location.href,ready:document.readyState,error:document.getElementById('error')?.textContent,body:document.body?.innerText?.slice(0,700)})`);
        const targets = (await cdp.send('Target.getTargets')).targetInfos.map(({type,url}) => ({type,url}));
        throw new Error(`${error.message}: ${JSON.stringify({ requested: `chrome-extension://${extensionId}/sidepanel.html`, ...detail, targets, errors })}`);
      }
      return panel;
    },
  };
  f.addCleanup(() => b.stop());
  await b.start();
  return b;
}

export async function pages(f) {
  const server = createServer((request, response) => {
    const title = new URL(request.url, 'http://fixture').searchParams.get('profile') || 'work';
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><title>${title} fixture</title></head><body><main><h1>${title} fixture inbox</h1><p id="summary">Two test messages are ready.</p><label>Search<input aria-label="Search"></label><button id="increment" onclick="document.getElementById('count').textContent=String(++window.fixtureCount)">Increment</button><p id="count">0</p><button disabled>Disabled action</button><a href="/?profile=next">Next page</a><script>window.fixtureCount=0;</script></main></body></html>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  f.addCleanup(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
