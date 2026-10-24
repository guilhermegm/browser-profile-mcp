import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSetup, bootstrapPrompt, setupMetadata, profileSetupCommand, firstTask } from '../extension/onboarding.js';
import { runFile } from './helpers.mjs';
import { VERSION } from '../extension/protocol.js';

const setup = { node: '/opt/node with spaces/bin/node', launcher: '/project with spaces/mcp.js', platform: 'darwin' };

test('all registration forms retain the profile, custom port, and exact paths', () => {
  const commands = agentSetup('client-work', 9444, setup);
  for (const name of ['codex', 'claudeLocal', 'claudeUser', 'codexConfig']) {
    assert.ok(commands[name].includes('browser-client-work'));
    assert.ok(commands[name].includes('9444'));
    assert.ok(commands[name].includes(setup.node));
    assert.ok(commands[name].includes(setup.launcher));
  }
  assert.match(commands.claudeLocal, /--scope local/);
  assert.match(commands.claudeUser, /--scope user/);
  assert.equal(profileSetupCommand('client-work', 9444, true), 'npm run profile -- client-work --port 9444 --reset');
});

test('legacy metadata gets an explicit fallback; malformed paths cannot become setup commands', () => {
  assert.equal(agentSetup('work', 9333, undefined), undefined);
  for (const value of ['', '/node\nmalicious', '/node\0malicious', 'x'.repeat(4097)]) {
    assert.equal(setupMetadata({ ...setup, node: value }), undefined);
  }
});

test('copied POSIX commands preserve quotes and shell metacharacters as literal arguments', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-mcp-quote-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); await mkdir(bin);
  for (const command of ['codex', 'claude']) {
    await writeFile(join(bin, command), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  }
  const unusual = { node: "/node's bin/$(touch SHOULD_NOT_EXIST)", launcher: '/repo `touch ALSO_NOT`/mcp.js', platform: 'linux' };
  const commands = agentSetup('work', 9444, unusual);
  for (const command of [commands.codex, commands.claudeLocal, commands.claudeUser]) {
    const { stdout } = await runFile('/bin/sh', ['-c', command], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const argv = JSON.parse(stdout);
    assert.deepEqual(argv.slice(argv.indexOf('--') + 1), [unusual.node, unusual.launcher, 'work', '--port', '9444']);
  }
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual((await readdir(root)).sort(), ['bin']);
});

test('PowerShell setup quotes apostrophes without using POSIX escape sequences', () => {
  const commands = agentSetup('work', 9333, { node: "C:\\Node's folder\\node.exe", launcher: 'C:\\project\\mcp.js', platform: 'win32' });
  assert.match(commands.codex, /'C:\\Node''s folder\\node.exe'/);
  assert.equal(commands.terminal, 'PowerShell');
});

test('the first task targets the actual server and is read-only', () => {
  assert.match(firstTask('client-acme'), /Use browser-client-acme MCP to list my open tabs/);
  assert.match(firstTask('client-acme'), /Do not open, navigate, or change any tabs/);
});

test('first-run setup is self-contained and points to the helper shipped inside the actual extension', () => {
  const extensionId = 'a'.repeat(32);
  const prompt = bootstrapPrompt({ extensionId, profileId: 'personal', installationId: '12345678-1234-1234-1234-123456789abc', os: 'mac' });
  assert.ok(prompt.includes(extensionId));
  assert.ok(prompt.includes(`https://github.com/guilhermegm/browser-profile-mcp/releases/download/v${VERSION}/browser-profile-mcp-bridge-v${VERSION}.zip`));
  assert.match(prompt, /SHA256SUMS/);
  assert.match(prompt, /verify the ZIP's SHA-256 checksum/);
  assert.match(prompt, /local-helper\/ folder/);
  assert.match(prompt, /user-level MCP configuration/);
  assert.match(prompt, /across my projects/);
  assert.match(prompt, /npm ci --omit=dev --ignore-scripts/);
  assert.match(prompt, /node bridge.js profile personal/);
  assert.match(prompt, /installation is 12345678/);
  assert.match(prompt, /never reset it/);
  assert.match(prompt, /Do not launch another Chrome, run browser tests/);
  assert.match(prompt, /Do not ask me to choose a configuration scope, locate a project folder/);
  assert.ok(!prompt.includes('npx '));
});

test('agent prompts configure the profile once and use this computer\'s platform', () => {
  const prompt = bootstrapPrompt({ extensionId: 'b'.repeat(32), profileId: 'client-acme', os: 'win' });
  assert.match(prompt, /across my projects/);
  assert.match(prompt, /Do not ask me to choose a configuration scope/);
  assert.ok(!prompt.includes('only in my current project'));
  assert.match(prompt, /%LOCALAPPDATA%/);
  assert.doesNotMatch(prompt, /\/(?:Users|home)\/[^/\s]+\//);
  assert.ok(!prompt.includes('chrome://extensions'));
  assert.throws(() => bootstrapPrompt({ extensionId: 'b'.repeat(32), profileId: 'bad; command' }), /lowercase/);
  assert.throws(() => bootstrapPrompt({ extensionId: 'invalid' }), /identity/);
});
