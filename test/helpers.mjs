import { mkdtemp, cp, symlink, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { SecurePeer } from '../extension/secure-channel.js';
import { PROTOCOL_VERSIONS } from '../settings.js';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const runFile = promisify(execFile);
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check, { timeout = 8000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; }
    catch (error) { last = error; }
    await delay(40);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

export async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit').catch(() => {});
  child.kill('SIGTERM');
  let timer;
  await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 2500); })]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}

export async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'browser-mcp-test-')));
  const callbacks = [];
  let closed = false;
  const env = { ...process.env };
  delete env.BROWSER_MCP_PORT;
  for (const file of ['bridge.js', 'mcp.js', 'settings.js', 'secure-transport.js', 'package.json', 'extension']) {
    await cp(join(ROOT, file), join(root, file), { recursive: true });
  }
  await symlink(join(ROOT, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const port = await unusedPort();
  const f = {
    root, port, env,
    addCleanup(callback) { callbacks.push(callback); },
    async close() {
      if (closed) return;
      closed = true;
      for (const callback of callbacks.reverse()) await callback().catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
    async profile(id = 'work', options = []) {
      const { stdout } = await runFile(process.execPath, [join(root, 'bridge.js'), 'profile', id, ...options], { env, cwd: root });
      const code = /Pairing code for Chrome profile '[^']+':\s+([A-Za-z0-9_-]+)/.exec(stdout)?.[1];
      if (!code) throw new Error('Setup did not print a pairing code');
      return { code, stdout, pairing: JSON.parse(Buffer.from(code, 'base64url')), profile: await f.readProfile(id) };
    },
    async readProfile(id = 'work') { return JSON.parse(await readFile(join(root, '.browser-mcp', `${id}.json`), 'utf8')); },
    async health() {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (!response.ok) throw new Error(`Health returned ${response.status}`);
      return response.json();
    },
    async startBridge() {
      const child = spawn(process.execPath, [join(root, 'bridge.js')], { cwd: root, env: { ...env, BROWSER_MCP_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { output += data; });
      f.addCleanup(() => stopChild(child));
      await until(async () => {
        if (child.exitCode !== null) throw new Error(`Bridge exited: ${output}`);
        return f.health();
      }, { label: 'isolated bridge startup' });
      return child;
    },
    async client(id = 'work') {
      const client = new Client({ name: 'isolated-browser-test', version: '1.0.0' }, {
        supportedProtocolVersions: PROTOCOL_VERSIONS, versionNegotiation: { mode: 'legacy' },
      });
      const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'mcp.js'), id, '--port', String(port)], cwd: root, env, stderr: 'pipe' });
      let stderr = '';
      transport.stderr.on('data', (data) => { stderr += data; });
      f.addCleanup(() => client.close());
      try { await client.connect(transport, { timeout: 10_000 }); }
      catch (error) { await transport.close(); throw new Error(`${error.message}\n${stderr}`); }
      client.launcherErrors = () => stderr;
      return client;
    },
    async extension(id = 'work', { identity = randomUUID(), secret, oncommand } = {}) {
      const profile = await f.readProfile(id);
      const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: `chrome-extension://${'a'.repeat(32)}` });
      const messages = [];
      const peer = new SecurePeer(socket, { credentials: { role: 'extension', profileId: id, identity, secret: secret || profile.extensionToken },
        onmessage: async (message) => {
          messages.push(message);
          if (message.type === 'ping') await peer.send({ type: 'pong' });
          if (message.type === 'command' && oncommand) {
            const result = await oncommand(message);
            await peer.send({ type: 'result', id: message.id, ok: true, result });
          }
        },
      });
      f.addCleanup(async () => { socket.terminate(); });
      await peer.ready;
      await until(() => messages.find((message) => ['ready', 'setup_error'].includes(message.type)), { label: 'extension ready or setup error' });
      return { socket, peer, identity, messages, latest: () => [...messages].reverse().find((m) => m.type === 'ready' || m.type === 'agent_status') };
    },
  };
  t.after(() => f.close());
  return f;
}

export function toolData(result) {
  if (result.isError) throw new Error(result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n'));
  return JSON.parse(result.content.find((item) => item.type === 'text').text);
}
