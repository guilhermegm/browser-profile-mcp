"""Render the supplied logo artwork and exact-size publication assets.

Requires Python 3, Pillow, and FontTools. This generates artwork; it does not start Chrome,
exercise the extension, or access browser/profile data. Run from any directory.
"""
from pathlib import Path
from html import escape
from functools import lru_cache
from base64 import b64encode
from io import BytesIO
import json
import zipfile
from PIL import Image, ImageDraw, ImageFont
import importlib.util

_type_spec = importlib.util.spec_from_file_location('bpm_typeface', Path(__file__).resolve().parent / 'typeface.py')
_type = importlib.util.module_from_spec(_type_spec)
_type_spec.loader.exec_module(_type)
ROOT = Path(__file__).resolve().parent
EXTENSION = ROOT.parent / 'extension' / 'icons'
LOGO_SOURCE = ROOT / 'logo' / 'monkey-source.png'
COLORS = dict(signal='#F15B3A', paper='#FAF9F6', ink='#17181B', muted='#64666B',
              white='#FFFFFF', line='#DEDFDF', soft='#F0F0ED', inverse='#B9BBC0')
FONT_STACK = "Geist, Arial, sans-serif"
SCALE = 3


@lru_cache(maxsize=128)
def font(size, bold=False):
    return _type.face(size, bold, SCALE)


@lru_cache(maxsize=1)
def logo_image():
    with Image.open(LOGO_SOURCE) as image:
        artwork = image.convert('RGBA')
    # Ignore almost invisible stray alpha when finding the empty margins.
    # Keep the original source intact, plus a two-pixel antialias allowance.
    bounds = artwork.getchannel('A').point(lambda value: 255 if value >= 8 else 0).getbbox()
    if bounds is None:
        raise ValueError('The supplied logo is fully transparent.')
    left, top, right, bottom = bounds
    cropped = artwork.crop((max(0, left-2), max(0, top-2),
                            min(artwork.width, right+2), min(artwork.height, bottom+2)))
    side = max(cropped.size)
    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    square.paste(cropped, ((side-cropped.width)//2, (side-cropped.height)//2))
    return square


@lru_cache(maxsize=1)
def logo_data():
    buffer = BytesIO()
    logo_image().save(buffer, format='PNG', optimize=True)
    return b64encode(buffer.getvalue()).decode('ascii')


class Canvas:
    def __init__(self, width, height, background=None, title='Browser Profile MCP'):
        self.width, self.height = width, height
        self.image = Image.new('RGBA', (width * SCALE, height * SCALE), (0, 0, 0, 0))
        self.draw = ImageDraw.Draw(self.image)
        self.has_logo = False
        self.svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="{escape(title)}">',
                    f'<title>{escape(title)}</title>']
        if background:
            self.rect(0, 0, width, height, background)

    def rect(self, x, y, w, h, fill='none', radius=0, stroke=None, sw=1):
        self.svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}"' +
                        (f' stroke="{stroke}" stroke-width="{sw}"' if stroke else '') + '/>')
        inset = sw / 2 if stroke else 0
        box = tuple(round(v * SCALE) for v in (x-inset, y-inset, x+w+inset, y+h+inset))
        self.draw.rounded_rectangle(box, radius=round((radius+inset) * SCALE), fill=None if fill == 'none' else fill,
                                    outline=stroke, width=max(1, round(sw * SCALE)))

    def line(self, points, color, width=1):
        self.svg.append(f'<polyline points="{" ".join(f"{x},{y}" for x, y in points)}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"/>')
        xy = [(round(x * SCALE), round(y * SCALE)) for x, y in points]
        self.draw.line(xy, fill=color, width=max(1, round(width * SCALE)), joint='curve')
        r = width * SCALE / 2
        for x, y in xy:
            self.draw.ellipse((round(x-r), round(y-r), round(x+r), round(y+r)), fill=color)

    def polygon(self, points, fill, stroke=None, sw=1):
        self.svg.append(f'<polygon points="{" ".join(f"{x},{y}" for x, y in points)}" fill="{fill}"' +
                        (f' stroke="{stroke}" stroke-width="{sw}" stroke-linejoin="round" paint-order="stroke fill"' if stroke else '') + '/>')
        xy = [(round(x * SCALE), round(y * SCALE)) for x, y in points]
        if stroke:
            self.draw.polygon(xy, fill=fill)
            self.draw.line(xy + [xy[0]], fill=stroke, width=round(sw * SCALE), joint='curve')
        self.draw.polygon(xy, fill=fill)

    def text(self, x, y, value, size=24, color=None, bold=False):
        color = color or COLORS['ink']
        face = font(size, bold)
        baseline = y-face.getbbox(value, anchor='ls')[1]/SCALE
        self.svg.append(_type.outline(value, x, baseline, size, bold, color, face, SCALE))
        self.draw.text((round(x * SCALE), round(y * SCALE)), value, font=face, fill=color, anchor='lt')

    def logo(self, x, y, size):
        if not self.has_logo:
            self.svg.append(f'<defs><image id="brand-icon" width="1" height="1" preserveAspectRatio="none" href="data:image/png;base64,{logo_data()}"/></defs>')
            self.has_logo = True
        self.svg.append(f'<use href="#brand-icon" transform="translate({x} {y}) scale({size})"/>')
        pixels = max(1, round(size * SCALE))
        raster = logo_image().resize((pixels, pixels), Image.Resampling.LANCZOS)
        self.image.alpha_composite(raster, (round(x*SCALE), round(y*SCALE)))

    def save(self, relative, png=True, svg=True, opaque=False):
        target = ROOT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if svg:
            target.with_suffix('.svg').write_text('\n'.join(self.svg + ['</svg>']) + '\n')
        if png:
            image = self.image.resize((self.width, self.height), Image.Resampling.LANCZOS)
            if opaque:
                background = Image.new('RGBA', image.size, COLORS['paper'])
                background.alpha_composite(image)
                image = background.convert('RGB')
            image.save(target.with_suffix('.png'), optimize=True)


def mark(canvas, x, y, size, foreground=None):
    """Use the supplied full-color artwork unchanged on light and dark surfaces."""
    canvas.logo(x, y, size)


def wordmark(canvas, x, y, dark=False, size=48, show_mark=True):
    color = COLORS['paper'] if dark else COLORS['ink']
    if show_mark:
        mark(canvas, x, y, size, color)
    name_x = x+size+size*.32 if show_mark else x
    type_size = size*.60
    canvas.text(name_x, y+size*.17, 'Browser Profile', type_size, color, True)
    width = font(type_size, True).getlength('Browser Profile')/SCALE
    badge_x = name_x+width+size*.30
    badge_y = y+size*.22
    canvas.rect(badge_x, badge_y, size*.89, size*.48, 'none', size*.055, color, size*.021)
    canvas.text(badge_x+size*.12, badge_y+size*.10, 'MCP', size*.23, color, True)


def kicker(canvas, x, y, value, dark=False, size=14):
    canvas.text(x, y, value, size, COLORS['inverse'] if dark else COLORS['muted'], True)


def build_icons():
    EXTENSION.mkdir(parents=True, exist_ok=True)
    extension_fonts = EXTENSION.parent/'fonts'
    extension_fonts.mkdir(exist_ok=True)
    for name in ['Geist.ttf', 'OFL.txt']:
        (extension_fonts/name).write_bytes((ROOT/'fonts'/name).read_bytes())
    for size in [16, 32, 48, 128, 256, 512, 1024]:
        padding = size//8 if size >= 128 else 0
        artwork_size = size - 2*padding
        canvas = Canvas(size, size)
        mark(canvas, padding, padding, artwork_size)
        canvas.save(f'icons/icon-{size}', svg=size == 1024)
        # Resize directly from the source and retain alpha; never add a plate.
        raster = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        artwork = logo_image().resize((artwork_size, artwork_size), Image.Resampling.LANCZOS)
        raster.paste(artwork, (padding, padding))
        raster.save(ROOT/f'icons/icon-{size}.png', optimize=True)
        if size in [16, 32, 48, 128]:
            (EXTENSION/f'icon-{size}.png').write_bytes((ROOT/f'icons/icon-{size}.png').read_bytes())
    (ROOT/'cws').mkdir(exist_ok=True)
    (ROOT/'cws/store-icon-128.png').write_bytes((ROOT/'icons/icon-128.png').read_bytes())
    for name, color in [('mark',COLORS['ink']), ('mark-ink',COLORS['ink']), ('mark-inverse',COLORS['paper'])]:
        canvas = Canvas(256, 256)
        mark(canvas, 0, 0, 256, color)
        canvas.save('logo/'+name)
    (EXTENSION/'mark.svg').write_bytes((ROOT/'logo/mark.svg').read_bytes())
    (EXTENSION/'mark.png').write_bytes((ROOT/'logo/mark.png').read_bytes())
    for dark in [False, True]:
        canvas = Canvas(700, 112)
        wordmark(canvas, 16, 20, dark=dark, size=72)
        canvas.save('logo/wordmark-inverse' if dark else 'logo/wordmark')
    (ROOT/'website').mkdir(exist_ok=True)
    for size in [16, 32, 48]:
        (ROOT/f'website/favicon-{size}.png').write_bytes((ROOT/f'icons/icon-{size}.png').read_bytes())
    Image.open(ROOT/'icons/icon-48.png').save(ROOT/'website/favicon.ico', sizes=[(16,16),(32,32),(48,48)])
    canvas = Canvas(128, 128)
    mark(canvas, 8, 8, 112)
    canvas.save('website/favicon', png=False)
    canvas = Canvas(180, 180, COLORS['ink'])
    mark(canvas, 38, 38, 104, COLORS['paper'])
    canvas.save('website/apple-touch-icon-180', svg=False, opaque=True)


def build_promo():
    canvas = Canvas(440, 280, COLORS['paper'])
    wordmark(canvas, 24, 24, size=30)
    canvas.text(24, 99, 'Your browser.', 43, bold=True)
    canvas.text(24, 151, 'Agent connected.', 43, bold=True)
    kicker(canvas, 24, 239, 'EXISTING CHROME PROFILES', size=11)
    mark(canvas, 365, 212, 50)
    canvas.save('cws/promo-small-440x280', opaque=True)
    canvas = Canvas(1400, 560, COLORS['ink'])
    wordmark(canvas, 64, 48, dark=True, size=44)
    canvas.text(64, 190, 'Your browser.', 84, COLORS['paper'], True)
    canvas.text(64, 284, 'Agent connected.', 84, COLORS['paper'], True)
    mark(canvas, 1045, 167, 275, COLORS['paper'])
    canvas.line([(64,455),(1336,455)], '#3A3B3E')
    kicker(canvas, 64, 490, 'CODEX  /  CLAUDE CODE  /  MCP AGENTS', True, 16)
    canvas.text(1046, 490, 'Existing profiles. Existing tabs.', 16, COLORS['inverse'])
    canvas.save('cws/promo-marquee-1400x560', opaque=True)


def build_website():
    canvas = Canvas(1200, 630, COLORS['paper'])
    wordmark(canvas, 56, 48, size=44)
    canvas.text(56, 203, 'Your browser.', 80, bold=True)
    canvas.text(56, 295, 'Agent connected.', 80, bold=True)
    mark(canvas, 930, 222, 204)
    canvas.rect(0, 534, 1200, 96, COLORS['ink'])
    kicker(canvas, 56, 575, 'BROWSER CONTROL THROUGH MCP', True, 16)
    canvas.text(770, 575, 'Your existing Chrome profiles and tabs.', 18, COLORS['inverse'])
    canvas.save('website/og-image-1200x630', opaque=True)
    canvas = Canvas(1280, 640, COLORS['ink'])
    wordmark(canvas, 64, 50, dark=True, size=44)
    canvas.text(64, 216, 'The browser', 84, COLORS['paper'], True)
    canvas.text(64, 312, 'you already use.', 84, COLORS['paper'], True)
    mark(canvas, 990, 228, 222, COLORS['paper'])
    canvas.line([(64,524),(1216,524)], '#3A3B3E')
    kicker(canvas, 64, 567, 'CONNECTED TO YOUR CODING AGENT', True, 16)
    canvas.text(970, 567, 'Codex  /  Claude Code  /  MCP', 18, COLORS['inverse'])
    canvas.save('website/repository-social-1280x640', opaque=True)
    canvas = Canvas(1280, 640, COLORS['paper'], title='Concept: MCP agents connect to existing Chrome profiles')
    wordmark(canvas, 56, 44, size=36)
    canvas.text(56, 133, 'Your agent. Your profiles.', 46, bold=True)
    # Orthogonal routes follow the mark's square grid.
    for y in [300, 464]:
        canvas.line([(336,y),(443,y),(443,382),(529,382)], '#8F9196', 3)
        canvas.line([(665,382),(793,382),(793,y),(902,y)], '#8F9196', 3)
    for x,y,title,subtitle in [(56,269,'Codex','Coding agent'),(56,433,'Claude Code','Coding agent'),
                               (930,269,'Work profile','Existing tabs and logins'),(930,433,'Personal profile','Existing tabs and logins')]:
        canvas.text(x, y, title, 27, bold=True)
        canvas.text(x, y+47, subtitle, 18, COLORS['muted'])
    mark(canvas, 529, 314, 136)
    canvas.text(491, 488, 'Local MCP bridge', 23, bold=True)
    canvas.text(56, 591, 'Concept diagram. Each Chrome profile has its own saved pairing.', 17, COLORS['muted'])
    canvas.save('website/connection-diagram-1280x640', opaque=True)


def build_templates():
    scenes = [
        ('01-existing-browser', 'Your browser. Agent connected.', 'Capture a real webpage and the connected side panel.'),
        ('02-separate-profiles', 'One pairing per Chrome profile.', 'Capture real panels in two paired profiles; redact pairing codes.'),
        ('03-shared-agents', 'Codex and Claude Code. Same profile.', 'Capture real agent activity and the controlled browser tab.'),
        ('04-visible-actions', 'Follow the action.', 'Capture the real orange cursor on a harmless page during an action.'),
        ('05-your-controls', 'You control the connection.', 'Capture Disconnect, Stop current actions, and clipboard controls.'),
    ]
    for name, title, brief in scenes:
        canvas = Canvas(1280, 800, COLORS['paper'], title='DRAFT capture layout: '+title)
        wordmark(canvas, 48, 32, size=36)
        canvas.text(48, 112, title, 43, bold=True)
        canvas.rect(48, 203, 1184, 530, COLORS['white'], 0, COLORS['line'], 1)
        canvas.text(193, 398, 'REPLACE WITH A REAL PRODUCT CAPTURE', 32, COLORS['muted'], True)
        canvas.text(150, 458, brief, 21, COLORS['muted'])
        kicker(canvas, 48, 761, 'DRAFT LAYOUT / REAL CAPTURE REQUIRED', size=14)
        canvas.save('cws/capture-templates/'+name, opaque=True)


def build_board():
    canvas = Canvas(1600, 1200, COLORS['paper'])
    canvas.rect(0, 0, 1600, 580, COLORS['ink'])
    wordmark(canvas, 64, 45, dark=True, size=48)
    kicker(canvas, 1310, 62, 'IDENTITY / 05', True)
    canvas.text(64, 209, 'Your browser.', 100, COLORS['paper'], True)
    canvas.text(64, 324, 'Agent connected.', 100, COLORS['paper'], True)
    mark(canvas, 1200, 208, 274, COLORS['paper'])
    kicker(canvas, 66, 514, 'BROWSER CONTROL THROUGH MCP', True, 16)
    canvas.text(1153, 514, 'Existing profiles. Existing tabs.', 19, COLORS['inverse'])
    kicker(canvas, 64, 630, '01 / THE MARK')
    mark(canvas, 64, 691, 176, COLORS['ink'])
    mark(canvas, 291, 691, 80)
    canvas.rect(283, 807, 96, 96, COLORS['ink'])
    mark(canvas, 300, 824, 62, COLORS['paper'])
    canvas.text(64, 932, 'Proboscis Monkey', 26, bold=True)
    canvas.text(64, 977, 'Full color. Black source background.', 18, COLORS['muted'])
    canvas.text(64, 1006, 'Supplied artwork. Original colors.', 18, COLORS['muted'])
    canvas.line([(448,630),(448,1097)], COLORS['line'])
    kicker(canvas, 512, 630, '02 / TYPE')
    canvas.text(508, 695, 'Geist', 78, bold=True)
    canvas.text(512, 806, 'Browser Profile', 35, bold=True)
    canvas.text(512, 866, 'Aa Bb Cc 012345', 30)
    canvas.text(512, 937, '650 / Headlines and identity', 18, COLORS['muted'])
    canvas.text(512, 972, '450 / Body and supporting copy', 18, COLORS['muted'])
    canvas.text(512, 1023, 'Local font. Outlined SVG exports.', 18, COLORS['muted'])
    canvas.line([(1020,630),(1020,1097)], COLORS['line'])
    kicker(canvas, 1084, 630, '03 / COLOR + SCALE')
    for index,(name,key) in enumerate([('Signal','signal'),('Ink','ink'),('Paper','paper')]):
        y = 689+index*82
        canvas.rect(1084, y, 53, 53, COLORS[key], 0, COLORS['line'])
        canvas.text(1157, y+1, name, 23, bold=True)
        canvas.text(1157, y+33, COLORS[key], 16, COLORS['muted'])
    for x,size in [(1085,16),(1147,32),(1225,48),(1335,96)]:
        # Actual occupied sizes, not a simulated screenshot of the toolbar.
        mark(canvas, x, 1001, size)
        canvas.text(x, 1124, str(size)+' px', 14, COLORS['muted'])
    canvas.line([(64,1158),(1536,1158)], COLORS['line'])
    kicker(canvas, 64, 1175, 'BROWSER PROFILE MCP / SUPPLIED MONKEY ARTWORK', size=11)
    canvas.text(1307, 1175, 'Your browser. Connected.', 13, COLORS['muted'])
    canvas.save('brand-board', opaque=True)


def inventory():
    rows = []
    for path in sorted(ROOT.rglob('*')):
        if path.suffix.lower() not in ['.png', '.svg', '.ico'] or 'gauntlet' in path.relative_to(ROOT).parts:
            continue
        item = {'file': str(path.relative_to(ROOT))}
        if path.suffix.lower() != '.svg':
            with Image.open(path) as image:
                item.update(width=image.width, height=image.height, mode=image.mode)
        item['status'] = ('capture-template-only' if 'capture-templates' in path.parts else
                          'logo-concept' if 'generated-v2' in path.name else 'ready-artwork')
        rows.append(item)
    (ROOT / 'asset-manifest.json').write_text(json.dumps({'name': 'Browser Profile MCP', 'assets': rows}, indent=2)+'\n')
    with zipfile.ZipFile(ROOT / 'browser-profile-mcp-brand-kit.zip', 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        for name in ('LICENSE', 'NOTICE'):
            bundle.write(ROOT.parent / name, Path('browser-profile-mcp-brand-kit') / name)
        for path in sorted(ROOT.rglob('*')):
            if (path.is_file() and not path.is_symlink() and path.suffix.lower() in
                    ['.png', '.svg', '.ico', '.html', '.txt', '.json', '.py', '.ttf'] and
                    '__pycache__' not in path.parts and 'gauntlet' not in path.relative_to(ROOT).parts and
                    path.name != 'brand-review.txt'):
                relative = Path('browser-profile-mcp-brand-kit') / path.relative_to(ROOT)
                if path == ROOT / 'index.html':
                    portable = path.read_text().replace('href="browser-profile-mcp-brand-kit.zip" download>Download brand kit',
                                                        'href="asset-manifest.json">Asset inventory')
                    bundle.writestr(str(relative), portable)
                else:
                    bundle.write(path, relative)


if __name__ == '__main__':
    build_icons()
    build_promo()
    build_website()
    build_templates()
    build_board()
    inventory()
    print('Rendered brand artwork, Chrome icons, capture layouts, and downloadable brand kit.')
