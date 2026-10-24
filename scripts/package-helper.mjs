import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['bridge.js', 'mcp.js', 'settings.js', 'secure-transport.js',
  'extension/onboarding.js', 'extension/protocol.js', 'extension/scheduler.js', 'extension/secure-channel.js',
  'LICENSE', 'NOTICE'];

// Ship the Node helper's source with the extension, without credentials,
// dependencies, development tools, or any browser/profile data.
export async function packageHelper(destination = join(root, 'extension/local-helper')) {
  for (const name of ['.browser-mcp', 'node_modules', '.env']) {
    let exists = false;
    try { await access(join(destination, name)); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exists) throw new Error(`The helper bundle contains ${name}. Keep runtime installations outside the extension before packaging.`);
  }
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    await mkdir(dirname(join(destination, file)), { recursive: true });
    await cp(join(root, file), join(destination, file));
  }
  const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = { name: 'browser-profile-mcp-helper', version: source.version, private: true,
    license: source.license, repository: source.repository,
    type: 'module', engines: source.engines, scripts: { profile: 'node bridge.js profile' }, dependencies: source.dependencies };
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  lock.name = manifest.name;
  lock.packages = Object.fromEntries(Object.entries(lock.packages).filter(([path, pkg]) => path && !pkg.dev));
  lock.packages[''] = { name: manifest.name, version: manifest.version, engines: manifest.engines, dependencies: manifest.dependencies };
  await writeFile(join(destination, 'package.json'), JSON.stringify(manifest, null, 2)+'\n');
  await writeFile(join(destination, 'package-lock.json'), JSON.stringify(lock, null, 2)+'\n');
  await writeFile(join(destination, 'README.txt'), 'Browser Profile MCP local helper\n\nCopy this entire folder to a stable installation location, preserving any\nexisting .browser-mcp folder. Install Node.js 20+ and run:\n\n  npm ci --omit=dev --ignore-scripts\n  node bridge.js profile work\n\nThe profile command prints a pairing code and agent registration commands.\nThe coding agent starts mcp.js automatically after registration. Do not use\nnpm start for daily use. Never distribute a .browser-mcp credentials folder.\n');
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Bundled helper: ${await packageHelper()}`);
}
