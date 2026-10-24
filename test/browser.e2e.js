import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until, delay, toolData } from './helpers.mjs';

const refOf = (snapshot) => {
  const ref = /\[([^\]]+)\]/.exec(snapshot)?.[1];
  assert.ok(ref, `No ref in ${snapshot}`); return ref;
};
const call = async (client, name, args = {}) => toolData(await client.callTool({ name, arguments: args }));

test('loaded extension: onboarding, real page tools, isolated profiles, and persistence', {
  timeout: 240000,
  skip: process.env.BROWSER_MCP_BROWSER_TESTS !== '1'
    ? 'Browser checks are opt-in because they can show browser/OS permission prompts.' : false,
}, async (t) => {
  const { browser, pages } = await import('./browser-helpers.mjs');
  const scenario = async (name, options, run) => {
    if (typeof options === 'function') { run = options; options = {}; }
    let passed = false;
    await t.test(name, options, async () => { await run(); passed = true; });
    if (!passed) throw new Error(`Browser scenario failed: ${name}`);
  };
  const f = await fixture(t);
  const work = await f.profile('work', ['--port', String(f.port)]);
  const base = await pages(f);
  const a = await browser(f, 'profile-a');
  t.diagnostic(`Isolated ${a.version}; no live Chrome profiles or credentials used.`);
  let panel = await a.panel();
  let client; let second; let tabId; let increment;

  await scenario('fresh pairing shows browser connection without falsely claiming an agent', async () => {
    assert.equal((await panel.state()).paired, false);
    await panel.evaluate(`document.getElementById('bootstrap-profile').value='work';document.getElementById('bootstrap-profile').dispatchEvent(new Event('input',{bubbles:true}));`);
    await panel.pair(work.code);
    assert.equal((await panel.state()).connected, false);
    assert.equal(await panel.evaluate(`document.getElementById('copy-bootstrap').disabled`), false);
    // Real onboarding saves the pairing before any agent starts the bridge.
    // Confirm the extension recovers its initial failed connection on its own.
    await until(async () => (await panel.state()).lastConnectionIssue, { label: 'initial offline connection' });
    await f.startBridge();
    let state;
    try { state = await until(async () => { const value = await panel.state(); return value.connected && value; }, { timeout: 25000, label: 'browser reconnect after bridge startup' }); }
    catch (error) { throw new Error(`${error.message}: ${JSON.stringify(await panel.state())}`); }
    assert.equal(state.agentCount, 0);
    assert.equal(state.verifiedAgentCount, 0);
    await until(async () => (await panel.text('connection-title')) === 'Connect your agent');
    assert.equal(state.port, f.port);
  });

  await scenario('the panel presents four steps without configuration dropdowns', async () => {
    assert.equal(await panel.evaluate(`document.querySelectorAll('select').length`), 0);
    assert.equal(await panel.evaluate(`document.querySelectorAll('.step').length`), 4);
    assert.deepEqual(panel.errors, []);
  });

  client = await f.client();
  await scenario('a real stdio MCP client confirms tab access and setup stays available', async () => {
    await until(async () => (await panel.state()).agentCount === 1);
    assert.equal((await panel.state()).verifiedAgentCount, 0);
    const result = await call(client, 'tabs');
    assert.equal(result.profile, 'work'); assert.ok(result.tabs.length);
    await until(async () => (await panel.state()).verifiedAgentCount === 1);
    await until(async () => (await panel.text('connection-title')) === "You're connected");
    assert.equal(await panel.evaluate(`document.getElementById('copy-another-agent').disabled`), false);
    const tab = await call(client, 'tabs', { action: 'create', url: `${base}/?profile=work` });
    tabId = tab.tab.tabId;
    await until(async () => (await call(client, 'tabs')).tabs.find((tab) => tab.tabId === tabId)?.title === 'work fixture');
    await call(client, 'tabs', { action: 'focus', tabId });
  });

  await scenario('real page reads, scoped snapshots, find, click-and-read, and screenshot work', async () => {
    const content = await call(client, 'read', { tabId, selector: 'main' });
    assert.match(content.text, /work fixture inbox/);
    const snapshot = await call(client, 'snapshot', { tabId, selector: 'main', maxNodes: 100 });
    assert.match(snapshot.snapshot, /Increment/);
    const found = await call(client, 'find', { tabId, name: 'Increment', role: 'button' });
    assert.equal(found.matches, 1); increment = refOf(found.snapshot);
    const clicked = await call(client, 'act', { tabId, action: 'click', ref: increment, read: { mode: 'text', selector: '#count', settleMs: 0 } });
    assert.equal(clicked.done, true); assert.equal(clicked.read.text, '1');
    const image = await client.callTool({ name: 'screenshot', arguments: { tabId } });
    assert.equal(image.isError, undefined);
    assert.ok(image.content.some((part) => part.type === 'image' && part.mimeType === 'image/jpeg' && part.data.length > 100));
  });

  await scenario('batches stop at the first failure and blocked clipboard work performs no preceding action', async () => {
    const complete = await call(client, 'batch', { tabId, actions: [{ action: 'click', ref: increment }, { action: 'click', ref: increment }], read: { mode: 'text', selector: '#count', settleMs: 0 } });
    assert.equal(complete.completed, 2); assert.equal(complete.read.text, '3');
    const failure = await client.callTool({ name: 'batch', arguments: { tabId, actions: [{ action: 'click', ref: increment }, { action: 'click', ref: 'nonexistent-ref' }, { action: 'click', ref: increment }] } });
    assert.equal(failure.isError, true);
    const partial = JSON.parse(failure.content[0].text);
    assert.equal(partial.completed, 1); assert.equal(partial.failedStep, 2);
    assert.equal((await call(client, 'read', { tabId, selector: '#count' })).text, '4');
    const blocked = await client.callTool({ name: 'batch', arguments: { tabId, actions: [{ action: 'click', ref: increment }, { action: 'key', key: 'Mod+v' }] } });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /clipboard shortcuts are disabled/);
    assert.equal((await call(client, 'read', { tabId, selector: '#count' })).text, '4');
  });

  second = await f.client();
  await scenario('two agent sessions retain their own refs and coexist on one browser profile', async () => {
    const other = await call(second, 'snapshot', { tabId, selector: 'main' });
    assert.match(other.snapshot, /Increment/);
    const own = await call(client, 'act', { tabId, action: 'click', ref: increment, read: { mode: 'text', selector: '#count', settleMs: 0 } });
    assert.equal(own.read.text, '5');
    await call(second, 'tabs');
    await until(async () => (await panel.state()).verifiedAgentCount === 2);
    await second.close();
    await until(async () => (await panel.state()).agentCount === 1);
  });

  await scenario('control survives a closed panel beyond the normal service-worker idle interval', { timeout: 60000 }, async () => {
    await panel.close();
    // No DevTools session is attached to the worker or inspected page. Wait
    // longer than MV3's idle interval and the 5-second debugger idle detach.
    await delay(35000);
    const content = await call(client, 'read', { tabId, selector: '#count' });
    assert.equal(content.text, '5');
    const existingRef = await call(client, 'act', { tabId, action: 'click', ref: increment, read: { mode: 'text', selector: '#count', settleMs: 0 } });
    assert.equal(existingRef.read.text, '6');
    panel = await a.panel();
    assert.equal((await panel.state()).connected, true);
  });

  await scenario('pairing survives a full browser restart without pasting the code again', { timeout: 30000 }, async () => {
    await a.stop(); await a.start();
    panel = await a.panel();
    const state = await until(async () => { const state = await panel.state(); return state.connected && state; });
    assert.equal(state.paired, true); assert.equal(state.profileId, 'work');
    assert.equal(state.verifiedAgentCount, 0);
    await call(client, 'tabs');
    await until(async () => (await panel.state()).verifiedAgentCount === 1);
  });

  const personal = await f.profile('personal', ['--port', String(f.port)]);
  const b = await browser(f, 'profile-b'); const panelB = await b.panel();
  await scenario('two Chrome profiles expose only their own tabs', async () => {
    await panelB.pair(personal.code);
    await until(async () => (await panelB.state()).connected);
    const personalClient = await f.client('personal');
    const created = await call(personalClient, 'tabs', { action: 'create', url: `${base}/?profile=personal` });
    await until(async () => (await call(personalClient, 'tabs')).tabs.find((tab) => tab.tabId === created.tab.tabId)?.title === 'personal fixture');
    const workTabs = await call(client, 'tabs'); const personalTabs = await call(personalClient, 'tabs');
    assert.ok(workTabs.tabs.every((tab) => tab.title !== 'personal fixture'));
    assert.ok(personalTabs.tabs.every((tab) => tab.title !== 'work fixture'));
    await personalClient.close();
  });

  await scenario('a real profile conflict stops retries; deliberate reset moves a live pairing', { timeout: 30000 }, async () => {
    await panelB.click('forget');
    await until(async () => !(await panelB.state()).paired);
    await panelB.pair(work.code);
    await until(async () => (await panelB.state()).pairingIssue);
    const conflict = await panelB.state();
    assert.equal(conflict.enabled, false); assert.equal(conflict.connected, false);
    assert.match(conflict.status, /assigned to another Chrome profile/);
    await until(async () => panelB.evaluate(`document.getElementById('pairing-conflict').hidden === false`));
    assert.equal(await panelB.evaluate(`document.getElementById('pair-form').hidden`), false);
    assert.equal(await panelB.evaluate(`document.querySelectorAll('select').length`), 0);
    const reset = await f.profile('work', ['--reset']);
    assert.equal(reset.pairing.port, f.port);
    await panelB.click('forget');
    await until(async () => !(await panelB.state()).paired);
    await panelB.pair(reset.code);
    await until(async () => (await panelB.state()).connected, { timeout: 15000, label: 'moved pairing' });
    const newClient = await f.client(); await call(newClient, 'tabs');
    await until(async () => (await panelB.state()).verifiedAgentCount === 1);
    assert.equal((await panel.state()).enabled, false);
    assert.deepEqual(panelB.errors, []);
  });
});
