import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { bootstrapPrompt, firstTask } from '../extension/onboarding.js';

const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const source = (await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/, '');
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function panel(storage = new Map()) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], {
    value: '', textContent: '', hidden: false, disabled: false, checked: false,
    listeners: {}, classes: new Set(), addEventListener(type, callback) { this.listeners[type] = callback; },
    classList: { toggle() {} },
  }]));
  let state = { ok: true, paired: false, enabled: false, connected: false, agentCount: 0,
    verifiedAgentCount: 0, installationId: '12345678-1234-1234-1234-123456789abc', os: 'mac' };
  let refresh;
  const messages = []; const copies = [];
  const context = {
    document: { getElementById: (id) => { assert.ok(elements.has(id), `Missing control ${id}`); return elements.get(id); } },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key,value) => storage.set(key,value) },
    navigator: { clipboard: { async writeText(value) { copies.push(value); } } },
    chrome: { runtime: { id: 'a'.repeat(32), async sendMessage(message) {
      messages.push(message);
      if (message.type === 'pair') state = { ...state, paired: true, enabled: true, profileId: 'work-profile', name: 'work-profile', port: 9444 };
      if (message.type === 'forget') state = { ...state, paired: false, enabled: false, connected: false, profileId: undefined, name: undefined };
      if (message.type === 'reconnect') state = { ...state, enabled: true, connected: true, agentCount: 1 };
      return { ...state };
    } } },
    bootstrapPrompt, firstTask, Date,
    setInterval(callback) { refresh = callback; return 1; },
    setTimeout(callback, delay) { return setTimeout(callback, delay).unref(); }, clearTimeout,
  };
  vm.runInNewContext(source, context, { filename: 'sidepanel.js' });
  await flush();
  return {
    element: (id) => elements.get(id), messages, copies, storage,
    async event(id, type = 'click') { elements.get(id).listeners[type]({ preventDefault() {} }); await flush(); },
    async update(value) { state = { ...state, ...value }; refresh(); await flush(); },
  };
}

test('the panel has four explicit steps and no scope/provider dropdowns or terminal instructions', () => {
  for (const label of ['1. Name this profile','2. Copy this prompt into your agent','3. Paste the code your agent gives you','Step 4 of 4']) assert.ok(html.includes(label));
  assert.doesNotMatch(html, /<select\b|bootstrap-scope|agent-scope|npm run|project folder/);
});

test('name first, then copy one complete agent prompt without choosing a project scope', async () => {
  const p = await panel();
  assert.equal(p.element('copy-bootstrap').disabled, true);
  p.element('bootstrap-profile').value = 'Work Profile';
  await p.event('bootstrap-profile', 'input');
  assert.equal(p.element('copy-bootstrap').disabled, false);
  await p.event('copy-bootstrap');
  assert.match(p.copies[0], /profile named "work-profile"/);
  assert.match(p.copies[0], /user-level MCP configuration/);
  assert.match(p.copies[0], /Do not ask me to choose a configuration scope/);
  assert.match(p.copies[0], /local-helper\/ folder/);
  assert.equal(p.element('connected-step').hidden, true);
  assert.equal(p.element('pairing-note').hidden, true);
});

test('pasting the code moves to step four without falsely claiming an attached agent', async () => {
  const p = await panel();
  p.element('pairing-code').value = ' fixture-code ';
  await p.event('pair-form', 'submit');
  assert.equal(p.messages.find((message) => message.type === 'pair').code, 'fixture-code');
  for (const id of ['name-step','prompt-step','pair-form']) assert.equal(p.element(id).hidden, true);
  assert.equal(p.element('connected-step').hidden, false);
  assert.equal(p.element('connection-title').textContent, 'Connect your agent');
  assert.equal(p.element('connection-step-label').textContent, 'Step 4 of 4');
  assert.equal(p.element('connection-state').textContent, 'Waiting for agent');
  assert.match(p.element('status').textContent, /Open a new session in your coding agent/);
  assert.equal(p.element('pairing-note').hidden, false);
  assert.equal(p.element('try-task').hidden, false);
  assert.equal(p.element('first-task').textContent, 'Use browser-work-profile MCP to list my open tabs.');
  await p.event('copy-first-task');
  assert.equal(p.copies[0], p.element('first-task').textContent);
  await p.update({ connected: true, agentCount: 0 });
  assert.equal(p.element('connection-title').textContent, 'Connect your agent');
  await p.update({ agentCount: 1 });
  assert.equal(p.element('connection-title').textContent, "You're connected");
  assert.equal(p.element('connection-state').textContent, 'Connected');
  assert.equal(p.element('connection-step-label').textContent, 'Setup complete');
  await p.event('copy-first-task');
  assert.match(p.copies[0], /browser-work-profile/);
});

test('reconnect resumes a paused connection; redo returns to naming and preserves the name', async () => {
  const p = await panel();
  await p.update({ paired: true, profileId: 'work-profile', name: 'work-profile', port: 9444, enabled: false });
  assert.equal(p.element('connection-title').textContent, 'Connection paused');
  assert.equal(p.element('connection-state').textContent, 'Paused');
  assert.equal(p.element('try-task').hidden, true);
  await p.event('reconnect');
  assert.ok(p.messages.some((message) => message.type === 'reconnect'));
  assert.equal(p.element('connection-title').textContent, "You're connected");
  await p.event('forget');
  assert.equal(p.element('name-step').hidden, false);
  assert.equal(p.element('connected-step').hidden, true);
  assert.equal(p.element('pairing-note').hidden, true);
  assert.equal(p.element('bootstrap-profile').value, 'work-profile');
  const reopened = await panel(p.storage);
  assert.equal(reopened.element('bootstrap-profile').value, 'work-profile');
});

test('a conflicting pairing returns to the code/prompt steps instead of presenting terminal commands', async () => {
  const p = await panel();
  p.element('bootstrap-profile').value = 'personal';
  await p.event('bootstrap-profile', 'input');
  await p.update({ paired: true, profileId: 'work', port: 9444, pairingIssue: true });
  assert.equal(p.element('pairing-conflict').hidden, false);
  assert.equal(p.element('pair-form').hidden, false);
  assert.equal(p.element('connected-step').hidden, true);
  await p.event('copy-bootstrap');
  assert.match(p.copies[0], /profile named "personal"/);
  assert.match(p.copies[0], /never reset it/);
});
