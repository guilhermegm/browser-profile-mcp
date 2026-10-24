"""Local Geist typography; SVG text is outlined for portable brand exports."""
from functools import lru_cache
from pathlib import Path
from html import escape
from PIL import ImageFont
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

FONT_FILE = Path(__file__).resolve().parent / 'fonts' / 'Geist.ttf'


@lru_cache(maxsize=128)
def face(size, bold=False, scale=3):
    result = ImageFont.truetype(str(FONT_FILE), round(size*scale), layout_engine=ImageFont.Layout.BASIC)
    result.set_variation_by_axes([650 if bold else 450])
    return result


@lru_cache(maxsize=2)
def vector_font(bold):
    font = TTFont(FONT_FILE)
    return font.getGlyphSet(location={'wght': 650 if bold else 450}), font.getBestCmap(), font['head'].unitsPerEm


def outline(value, x, baseline, size, bold, color, raster_face, raster_scale):
    glyphs, cmap, em = vector_font(bold)
    scale = size/em
    parts = [f'<g aria-label="{escape(value, quote=True)}" fill="{color}">']
    for index, char in enumerate(value):
        name = cmap.get(ord(char), '.notdef')
        glyph = glyphs[name]
        pen = SVGPathPen(glyphs)
        glyph.draw(pen)
        data = pen.getCommands()
        if not data:
            continue
        # The BASIC renderer keeps glyph placement deterministic without libraqm.
        prefix = value[:index+1]
        left = (raster_face.getlength(prefix) - raster_face.getlength(char))/raster_scale
        parts.append(f'<path d="{data}" transform="translate({x+left:.5f} {baseline:.5f}) scale({scale:.7f} {-scale:.7f})"/>')
    parts.append('</g>')
    return '\n'.join(parts)
