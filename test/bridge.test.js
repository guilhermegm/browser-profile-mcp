import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { stat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { SecurePeer } from '../extension/secure-channel.js';
import { fixture, until, toolData } from './helpers.mjs';

const fakeTabs = async () => ({ tabs: [{ tabId: 1, title: 'Isolated fixture tab', url: 'https://example.test/', controllable: true }] });

test('profile setup retains credentials, custom port, and private file permissions across regeneration', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const first = await f.profile('work', ['--port', String(f.port)]);
  const again = await f.profile('work');
  assert.equal(again.pairing.port, f.port);
  assert.equal(first.pairing.token, again.pairing.token);
  assert.equal(first.profile.agentToken, again.profile.agentToken);
  assert.match(again.stdout, /--scope local/);
  assert.match(again.stdout, /--scope user/);
  assert.ok(again.pairing.setup.node);
  assert.ok(again.pairing.setup.launcher.startsWith(f.root));
  if (process.platform !== 'win32') assert.equal((await stat(join(f.root, '.browser-mcp/work.json'))).mode & 0o777, 0o600);
  const reset = await f.profile('work', ['--reset']);
  assert.equal(reset.pairing.port, f.port);
  assert.notEqual(reset.pairing.token, first.pairing.token);
  assert.notEqual(reset.profile.agentToken, first.profile.agentToken);
  assert.equal(reset.profile.installationId, undefined);
});

test('invalid setup options and names fail without writing a pairing', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.profile('../escape'), /Usage/);
  await assert.rejects(f.profile('work', ['--port', '70000']), /between 1 and 65535/);
  await assert.rejects(f.profile('work', ['--unknown']), /Usage/);
  await assert.rejects(f.readProfile('work'), /ENOENT/);
});

test('wrong secrets cannot claim an installation or access browser tools', { timeout: 10000 }, async (t) => {
  const f = await fixture(t); await f.profile('work', ['--port', String(f.port)]); await f.startBridge();
  const socket = new WebSocket(`ws://127.0.0.1:${f.port}/extension`, { origin: `chrome-extension://${'b'.repeat(32)}` });
  t.after(() => socket.terminate());
  const peer = new SecurePeer(socket, { credentials: { role: 'extension', profileId: 'work', identity: randomUUID(), secret: randomBytes(32).toString('hex') } });
  await assert.rejects(peer.ready, /verification failed|validation failed|disconnected/);
  assert.equal((await f.readProfile()).installationId, undefined);
  const missing = await fetch(`http://127.0.0.1:${f.port}/mcp`);
  assert.equal(missing.status, 410);
});

test('real stdio MCP launchers share one profile and confirm each session separately', { timeout: 20000 }, async (t) => {
  const f = await fixture(t); await f.profile('work', ['--port', String(f.port)]); await f.startBridge();
  const extension = await f.extension('work', { oncommand: fakeTabs });
  assert.equal(extension.latest().agentCount, 0);
  const one = await f.client(); const two = await f.client();
  await until(() => extension.latest()?.agentCount === 2);
  assert.equal(extension.latest().verifiedAgentCount, 0);
  assert.deepEqual((await one.listTools()).tools.map((tool) => tool.name).sort(), ['act','batch','find','navigate','read','screenshot','snapshot','tabs']);
  const first = toolData(await one.callTool({ name: 'tabs', arguments: {} }));
  assert.equal(first.profile, 'work');
  assert.equal(first.tabs[0].title, 'Isolated fixture tab');
  await until(() => extension.latest()?.verifiedAgentCount === 1);
  toolData(await two.callTool({ name: 'tabs', arguments: { action: 'list' } }));
  await until(() => extension.latest()?.verifiedAgentCount === 2);
  await one.close();
  await until(() => extension.latest()?.agentCount === 1);
  assert.equal(extension.latest().verifiedAgentCount, 1);
  toolData(await two.callTool({ name: 'tabs', arguments: {} }));
});

test('binding conflicts are authenticated, and resetting a pairing moves it off a live old connection', { timeout: 20000 }, async (t) => {
  const f = await fixture(t); await f.profile('work', ['--port', String(f.port)]); await f.startBridge();
  const old = await f.extension('work', { oncommand: fakeTabs });
  const oldAgent = await f.client();
  toolData(await oldAgent.callTool({ name: 'tabs', arguments: {} }));
  const conflict = await f.extension();
  assert.ok(conflict.messages.some((message) => message.type === 'setup_error' && message.code === 'pairing_in_use'));
  assert.equal((await f.readProfile()).installationId, old.identity);
  await f.profile('work', ['--reset']);
  const nextIdentity = randomUUID();
  const firstAttempt = await f.extension('work', { identity: nextIdentity, oncommand: fakeTabs }).catch(() => undefined);
  if (firstAttempt) assert.ok(firstAttempt.messages.some((message) => message.type === 'ready'));
  await until(() => old.socket.readyState === WebSocket.CLOSED);
  await until(() => conflict.socket.readyState === WebSocket.CLOSED);
  await until(async () => { const profile = await f.readProfile(); return profile.installationId === undefined || profile.installationId === nextIdentity; });
  const moved = firstAttempt || await f.extension('work', { identity: nextIdentity, oncommand: fakeTabs });
  assert.ok(moved.messages.some((message) => message.type === 'ready'));
  assert.equal((await f.readProfile()).installationId, nextIdentity);
  const currentAgent = await f.client();
  toolData(await currentAgent.callTool({ name: 'tabs', arguments: {} }));
  await until(() => moved.latest()?.verifiedAgentCount === 1);
  assert.equal(moved.latest().agentCount, 1);
});

test('launchers share compatible artwork releases and reject unknown versions or protocols', { timeout: 30000 }, async (t) => {
  for (const [version, protocol, accepted] of [
    ['0.5.1', 3, true], ['0.5.2', 3, true],
    ['0.5.0', 3, false], ['0.6.0', 3, false], ['0.5.1', 2, false], ['0.5.3', 2, false],
  ]) {
    await t.test(`bridge ${version}, protocol ${protocol}`, async (t) => {
      const f = await fixture(t);
      await f.profile('work', ['--port', String(f.port)]);
      const path = join(f.root, 'bridge.js');
      const source = await readFile(path, 'utf8');
      // Only advertise legacy health metadata. The real authenticated MCP
      // transport is unchanged between these historical artwork releases.
      const changed = source.replace(
        'app: "profile-browser-mcp", version: VERSION,\n      protocol: COMMAND_PROTOCOL, stateDirectory: STATE',
        `app: "profile-browser-mcp", version: "${version}",\n      protocol: ${protocol}, stateDirectory: STATE`,
      );
      assert.notEqual(changed, source);
      await writeFile(path, changed);
      const bridge = await f.startBridge();
      if (accepted) {
        const first = await f.client();
        const second = await f.client();
        assert.equal((await first.listTools()).tools.length, 8);
        assert.equal((await second.listTools()).tools.length, 8);
        await second.close();
        assert.equal((await first.listTools()).tools.length, 8);
        assert.equal((await f.health()).version, version);
        assert.equal(bridge.exitCode, null);
      } else {
        await assert.rejects(f.client(), /incompatible Browser Profile MCP bridge/);
      }
    });
  }
});

test('the launcher starts its own isolated bridge, which exits after the last session closes', { timeout: 80000 }, async (t) => {
  const f = await fixture(t); await f.profile('work', ['--port', String(f.port)]);
  const client = await f.client();
  assert.equal((await f.health()).stateDirectory, join(f.root, '.browser-mcp/'));
  assert.equal((await client.listTools()).tools.length, 8);
  await client.close();
  await until(async () => { try { await f.health(); return false; } catch { return true; } }, { timeout: 65000, label: 'automatic bridge shutdown' });
});
