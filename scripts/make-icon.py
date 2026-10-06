"""Draws the app icon: a velvet tile ringed with marquee bulbs around a bold K.

Writes build/icon.png (512 px) and build/icon.ico (16-256 px, each size drawn
on its own so small sizes stay legible). Run: python scripts/make-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build"

HOUSE = (22, 13, 18)
CURTAIN = (44, 27, 37)
SEAM = (61, 40, 51)
SCREEN = (244, 234, 223)
BULB = (255, 198, 92)

FONT_FILE = "C:/Windows/Fonts/bahnschrift.ttf"
LETTER = "K"  # Kope's Kinoteatri


def letter_font(px: int) -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(FONT_FILE, px)
    names = [n.decode() if isinstance(n, bytes) else n for n in font.get_variation_names()]
    for wanted in ("Bold Condensed", "Bold SemiCondensed", "Bold"):
        if wanted in names:
            font.set_variation_by_name(wanted)
            break
    return font


def perimeter_points(x0, y0, x1, y1, r, count):
    """Evenly spaced points along a rounded rectangle's outline."""
    import math

    straight_w, straight_h = (x1 - x0) - 2 * r, (y1 - y0) - 2 * r
    arc = math.pi * r / 2
    total = 2 * straight_w + 2 * straight_h + 4 * arc
    segments = [
        ("line", (x0 + r, y0), (x1 - r, y0), straight_w),
        ("arc", (x1 - r, y0 + r), -90, arc),
        ("line", (x1, y0 + r), (x1, y1 - r), straight_h),
        ("arc", (x1 - r, y1 - r), 0, arc),
        ("line", (x1 - r, y1), (x0 + r, y1), straight_w),
        ("arc", (x0 + r, y1 - r), 90, arc),
        ("line", (x0, y1 - r), (x0, y0 + r), straight_h),
        ("arc", (x0 + r, y0 + r), 180, arc),
    ]
    points = []
    for i in range(count):
        d = total * i / count
        for kind, a, b, length in segments:
            if d > length:
                d -= length
                continue
            t = d / length if length else 0
            if kind == "line":
                points.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            else:
                ang = math.radians(b + 90 * t)
                points.append((a[0] + r * math.cos(ang), a[1] + r * math.sin(ang)))
            break
    return points


def draw(size: int) -> Image.Image:
    s = 1024  # supersample, then downscale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    margin = s * 0.04
    radius = s * 0.22

    # Velvet tile with a vertical sheen.
    tile = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    grad = Image.new("RGBA", (1, s))
    for y in range(s):
        t = y / (s - 1)
        grad.putpixel((0, y), tuple(int(CURTAIN[i] * (1 - t) + HOUSE[i] * t) for i in range(3)) + (255,))
    grad = grad.resize((s, s))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle((margin, margin, s - margin, s - margin), radius, fill=255)
    tile.paste(grad, (0, 0), mask)
    ImageDraw.Draw(tile).rounded_rectangle((margin, margin, s - margin, s - margin), radius, outline=SEAM, width=int(s * 0.012))
    img.alpha_composite(tile)

    # Marquee bulbs (only where they read: 32 px and up).
    if size >= 32:
        count = 22 if size >= 64 else 14
        bulb_r = s * (0.026 if size >= 64 else 0.04)
        inset = s * 0.135
        pts = perimeter_points(inset, inset, s - inset, s - inset, radius * 0.62, count)
        glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        for x, y in pts:
            gd.ellipse((x - bulb_r * 2.2, y - bulb_r * 2.2, x + bulb_r * 2.2, y + bulb_r * 2.2), fill=BULB + (110,))
        img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(s * 0.02)))
        d = ImageDraw.Draw(img)
        for x, y in pts:
            d.ellipse((x - bulb_r, y - bulb_r, x + bulb_r, y + bulb_r), fill=BULB)

    # The letter: warm silver on large icons, bulb amber when tiny (more contrast).
    d = ImageDraw.Draw(img)
    letter_px = int(s * (0.50 if size >= 32 else 0.74))
    font = letter_font(letter_px)
    color = SCREEN if size >= 32 else BULB
    bbox = d.textbbox((0, 0), LETTER, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((s - w) / 2 - bbox[0], (s - h) / 2 - bbox[1]), LETTER, font=font, fill=color)

    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(exist_ok=True)
    draw(512).save(OUT / "icon.png")
    sizes = [256, 128, 64, 48, 32, 24, 16]
    frames = [draw(n) for n in sizes]
    frames[0].save(OUT / "icon.ico", format="ICO", sizes=[(n, n) for n in sizes], append_images=frames[1:])
    print("wrote", OUT / "icon.png", "and", OUT / "icon.ico")


if __name__ == "__main__":
    main()
