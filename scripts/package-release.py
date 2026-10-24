"""Build credential-free release ZIPs from explicit source-file allowlists."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent.parent
HELPER = ROOT / 'extension' / 'local-helper'
EXTENSION = ROOT / 'extension'

BRIDGE_FILES = {
    'bridge.js', 'mcp.js', 'settings.js', 'secure-transport.js',
    'extension/onboarding.js', 'extension/protocol.js',
    'extension/scheduler.js', 'extension/secure-channel.js',
    'LICENSE', 'NOTICE', 'README.txt', 'package.json', 'package-lock.json',
}
EXTENSION_FILES = {
    'accessibility.js', 'background.js', 'content.js', 'cursor.js',
    'deadline.js', 'debugger.js', 'onboarding.js', 'protocol.js',
    'scheduler.js', 'secure-channel.js', 'sidepanel.js', 'target.js',
    'manifest.json', 'sidepanel.html', 'sidepanel.css',
    'fonts/Geist.ttf', 'fonts/OFL.txt',
    'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png',
    'icons/icon-128.png', 'icons/mark.png', 'icons/mark.svg',
} | {f'local-helper/{name}' for name in BRIDGE_FILES}
FORBIDDEN = {'.browser-mcp', 'node_modules', '.git', '.codex', '.claude'}


def check_tree(root, allowed):
    actual = set()
    for path in root.rglob('*'):
        relative = path.relative_to(root)
        if path.is_symlink():
            raise ValueError(f'Release contains a symlink: {relative}')
        if any(part in FORBIDDEN or part.startswith('.env') for part in relative.parts):
            raise ValueError(f'Release contains private runtime state: {relative}')
        if path.is_file():
            actual.add(relative.as_posix())
    unexpected = actual - allowed
    missing = allowed - actual
    if unexpected:
        raise ValueError(f'Unexpected release files: {", ".join(sorted(unexpected))}')
    if missing:
        raise ValueError(f'Missing release files: {", ".join(sorted(missing))}')


def write_zip(destination, root, files, prefix=''):
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(files):
            entry = zipfile.ZipInfo(prefix + name, date_time=(2020, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, (root / name).read_bytes())


def main():
    version = json.loads((ROOT / 'package.json').read_text())['version']
    check_tree(HELPER, BRIDGE_FILES)
    check_tree(EXTENSION, EXTENSION_FILES)
    destination = ROOT / 'dist'
    destination.mkdir(exist_ok=True)
    bridge = destination / f'browser-profile-mcp-bridge-v{version}.zip'
    extension = destination / f'browser-profile-mcp-extension-v{version}.zip'
    write_zip(bridge, HELPER, BRIDGE_FILES, 'browser-profile-mcp-bridge/')
    write_zip(extension, EXTENSION, EXTENSION_FILES)
    files = [bridge, extension]
    brand_kit = ROOT / 'branding' / 'browser-profile-mcp-brand-kit.zip'
    if brand_kit.is_file():
        packaged = destination / brand_kit.name
        shutil.copyfile(brand_kit, packaged)
        files.append(packaged)
    checksums = ''.join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n'
                        for path in sorted(files))
    (destination / 'SHA256SUMS').write_text(checksums)
    print(f'Built {len(files)} release archives and SHA256SUMS in dist/.')


if __name__ == '__main__':
    main()
