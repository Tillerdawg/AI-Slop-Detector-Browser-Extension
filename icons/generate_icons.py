"""
Generates the extension's toolbar/manifest icons (16/32/48/128 px PNGs).

Simple flat design: a rounded "magnifying glass over a play button" mark,
drawn programmatically with Pillow so there's no binary asset to hand-edit.
Run: python icons/generate_icons.py
"""
import os
from PIL import Image, ImageDraw

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
SIZES = [16, 32, 48, 128]

BG = (46, 49, 56, 255)        # dark slate background circle
ACCENT = (224, 72, 61, 255)   # red accent (matches "ai_generated" band color)
GLASS = (245, 245, 245, 255)  # light magnifier ring
PLAY = (245, 245, 245, 255)   # play triangle


def draw_icon(size):
    scale = 4  # supersample then downscale for smoother edges
    s = size * scale
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = int(s * 0.04)
    d.ellipse([pad, pad, s - pad, s - pad], fill=BG)

    # Play triangle, slightly left/up of center
    cx, cy = s * 0.46, s * 0.46
    tri_r = s * 0.22
    import math
    pts = []
    for angle in (-30, 90, 210):
        rad = math.radians(angle)
        pts.append((cx + tri_r * math.cos(rad), cy + tri_r * math.sin(rad)))
    d.polygon(pts, fill=PLAY)

    # Magnifying glass ring, offset toward bottom-right, overlapping the play icon
    ring_cx, ring_cy = s * 0.60, s * 0.58
    ring_r = s * 0.20
    ring_w = max(2 * scale, int(s * 0.055))
    d.ellipse(
        [ring_cx - ring_r, ring_cy - ring_r, ring_cx + ring_r, ring_cy + ring_r],
        outline=ACCENT,
        width=ring_w,
    )
    # Handle
    import math
    hx1 = ring_cx + ring_r * math.cos(math.radians(45))
    hy1 = ring_cy + ring_r * math.sin(math.radians(45))
    hx2 = hx1 + s * 0.16 * math.cos(math.radians(45))
    hy2 = hy1 + s * 0.16 * math.sin(math.radians(45))
    d.line([hx1, hy1, hx2, hy2], fill=ACCENT, width=ring_w)

    img = img.resize((size, size), Image.LANCZOS)
    return img


def main():
    for size in SIZES:
        icon = draw_icon(size)
        out_path = os.path.join(OUT_DIR, f'icon-{size}.png')
        icon.save(out_path)
        print(f'wrote {out_path}')


if __name__ == '__main__':
    main()
