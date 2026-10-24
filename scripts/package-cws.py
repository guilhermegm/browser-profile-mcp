"""Package the store handoff with an explicit file list, never draft assets."""
from pathlib import Path
from io import BytesIO
import hashlib
import json
import zipfile
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent


def main():
    version = json.loads((ROOT / 'package.json').read_text())['version']
    manifest = json.loads((ROOT / 'extension/manifest.json').read_text())
    if manifest['version'] != version:
        raise ValueError('Extension and package versions differ.')
    info = json.loads((ROOT / 'branding/cws/screenshots/capture-info.json').read_text())
    if info['extensionVersion'] != version:
        raise ValueError('Capture the store images again for the current version.')
    extension = f'dist/browser-profile-mcp-extension-v{version}.zip'
    files = {
        'CHROME_WEB_STORE.md': 'CHROME_WEB_STORE.md',
        'PRIVACY.md': 'PRIVACY.md', 'LICENSE': 'LICENSE', 'NOTICE': 'NOTICE',
        extension: f'browser-profile-mcp-extension-v{version}.zip',
    }
    for name in ('listing.txt', 'privacy-declarations.txt', 'reviewer-instructions.txt',
                 'store-icon-128.png', 'promo-small-440x280.png', 'promo-marquee-1400x560.png',
                 'screenshots/capture-info.json', 'screenshots/01-setup-1280x800.png',
                 'screenshots/02-start-agent-1280x800.png', 'screenshots/03-connection-controls-1280x800.png'):
        files[f'branding/cws/{name}'] = f'branding/cws/{name}'

    contents = {}
    for source, target in files.items():
        path = ROOT / source
        if path.is_symlink():
            raise ValueError(f'Symlink not permitted: {source}')
        contents[target] = path.read_bytes()
        if source.endswith('.png'):
            expected = ((1280, 800) if '/screenshots/' in source else
                        (128, 128) if 'store-icon' in source else
                        (440, 280) if 'promo-small' in source else (1400, 560))
            with Image.open(BytesIO(contents[target])) as image:
                if image.size != expected or image.getexif():
                    raise ValueError(f'Unexpected dimensions or metadata: {source}')
    with zipfile.ZipFile(BytesIO(contents[files[extension]])) as package:
        packaged_manifest = json.loads(package.read('manifest.json'))
        if packaged_manifest != manifest:
            raise ValueError('Rebuild the extension ZIP before packaging the kit.')

    sums = ''.join(f'{hashlib.sha256(data).hexdigest()}  {name}\n'
                   for name, data in sorted(contents.items()))
    contents['SHA256SUMS'] = sums.encode()
    destination = ROOT / 'dist' / f'browser-profile-mcp-cws-kit-v{version}.zip'
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(contents.items()):
            entry = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, data)
    checksum_file = ROOT / 'dist' / 'SHA256SUMS'
    sums = {name: digest for digest, name in
            (line.split('  ', 1) for line in checksum_file.read_text().splitlines())}
    sums[destination.name] = hashlib.sha256(destination.read_bytes()).hexdigest()
    checksum_file.write_text(''.join(f'{digest}  {name}\n' for name, digest in sorted(sums.items())))
    print(f'Built {destination.relative_to(ROOT)} with {len(contents)} explicit files.')


if __name__ == '__main__':
    main()
