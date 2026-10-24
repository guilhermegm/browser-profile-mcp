import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, runFile } from './helpers.mjs';

async function releaseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'browser-mcp-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(ROOT, 'extension'), join(root, 'extension'), { recursive: true });
  await cp(join(ROOT, 'package.json'), join(root, 'package.json'));
  await mkdir(join(root, 'scripts'));
  await cp(join(ROOT, 'scripts/package-release.py'), join(root, 'scripts/package-release.py'));
  return root;
}

test('release archives include complete source, valid checksums, and no local runtime files', async (t) => {
  const root = await releaseFixture(t);
  await mkdir(join(root, '.browser-mcp'));
  await writeFile(join(root, '.browser-mcp/private.json'), 'private-runtime-fixture');
  await writeFile(join(root, '.env'), 'private-environment-fixture');
  await runFile('python3', [join(root, 'scripts/package-release.py')]);
  const sums = (await readFile(join(root, 'dist/SHA256SUMS'), 'utf8')).trim().split('\n');
  assert.equal(sums.length, 2);
  for (const row of sums) {
    const [checksum, name] = row.split('  ');
    assert.equal(createHash('sha256').update(await readFile(join(root, 'dist', name))).digest('hex'), checksum);
  }
  const { stdout } = await runFile('python3', ['-c', `
from pathlib import Path
import json, sys, zipfile
archives = {}
for path in Path(sys.argv[1]).glob('*.zip'):
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        for name in archive.namelist():
            assert not name.startswith('/') and '..' not in Path(name).parts
            assert not any(part in ('.browser-mcp', 'node_modules', '.env') for part in Path(name).parts)
            contents = archive.read(name)
            assert b'private-runtime-fixture' not in contents
            assert b'private-environment-fixture' not in contents
        archives[path.name] = archive.namelist()
print(json.dumps(archives))
`, join(root, 'dist')]);
  const archives = JSON.parse(stdout);
  const bridge = Object.entries(archives).find(([name]) => name.includes('-bridge-'))[1];
  const extension = Object.entries(archives).find(([name]) => name.includes('-extension-'))[1];
  for (const required of ['mcp.js', 'bridge.js', 'LICENSE', 'package-lock.json', 'extension/secure-channel.js']) {
    assert.ok(bridge.includes(`browser-profile-mcp-bridge/${required}`));
  }
  assert.ok(extension.includes('manifest.json'));
  assert.ok(extension.includes('local-helper/LICENSE'));
});

test('release packaging stops before writing archives if helper credentials are present', async (t) => {
  const root = await releaseFixture(t);
  await mkdir(join(root, 'extension/local-helper/.browser-mcp'));
  await assert.rejects(runFile('python3', [join(root, 'scripts/package-release.py')]), /private runtime state/);
  await assert.rejects(readdir(join(root, 'dist')), { code: 'ENOENT' });
});
