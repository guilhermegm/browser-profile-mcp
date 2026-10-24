import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageHelper } from '../scripts/package-helper.mjs';
import { ROOT, runFile } from './helpers.mjs';

test('the extension ships a standalone production helper that can generate a pairing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-mcp-package-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, 'installed-helper');
  await packageHelper(destination);
  const pkg = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(destination, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.devDependencies, undefined);
  assert.deepEqual(pkg.dependencies, lock.packages[''].dependencies);
  assert.ok(!Object.keys(lock.packages).some((path) => /playwright/.test(path)));
  await symlink(join(ROOT, 'node_modules'), join(destination, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const { stdout } = await runFile(process.execPath, [join(destination, 'bridge.js'), 'profile', 'fresh-user', '--port', '9444']);
  const code = /Pairing code for Chrome profile '[^']+':\s+([A-Za-z0-9_-]+)/.exec(stdout)?.[1];
  assert.ok(code);
  const pairing = JSON.parse(Buffer.from(code, 'base64url'));
  assert.equal(pairing.profileId, 'fresh-user');
  assert.equal(pairing.port, 9444);
  assert.ok(pairing.setup.launcher.includes('installed-helper'));
});

test('packaging refuses to include existing runtime credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-mcp-package-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.browser-mcp'));
  await assert.rejects(packageHelper(root), /contains .browser-mcp/);
});
