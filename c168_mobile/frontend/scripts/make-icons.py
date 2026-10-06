"""Regenerate the phone-version icons.

Design: white plate + the brand's own blue mark (images/count_logo.png) — what the mark
was drawn for. Two deliberate details:

  * mark size. The adaptive/"any" tiles use 62% of the canvas; the maskable one uses 46.5%,
    because the mark's furthest ink sits at 0.6576 of its width from centre, and Android's
    mask and the web-app-manifest safe circle only guarantee the central 66/80%.
    (The pre-2026 icons sat at ~63% of an adaptive canvas and were clipped by circle masks.)
  * optical centring. The mark's ink centroid is 1.54% of its width left of the bounding-box
    centre (its left column is heavier), so a pure bbox centre reads as shifted left. We
    compensate half of it (+0.77% to the right) — full compensation overshoots.

The tab favicon is the one exception: it stays the transparent blue mark (no plate), so the
browser's tab strip shows through — that is the desktop look the client asked for.

Source art: images/count_logo.png (blue mark, transparent background).
Run from anywhere:  python c168_mobile/frontend/scripts/make-icons.py
Writes c168_mobile/frontend/public/{favicon.ico,icons/*.png}.
The built site serves c168_mobile/frontend/dist/, so copy the files there too (or run
`npm run build`, which copies public/ verbatim).
The Android launcher icons come from c168_mobile/app/make-launcher-icons.py (same design).
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
PUBLIC = ROOT / "c168_mobile" / "frontend" / "public"
ICONS = PUBLIC / "icons"

PLATE = (255, 255, 255, 255)
OPTICAL_SHIFT = 0.0077  # +0.77% of the mark's width, to the right (half of the 1.54% bias)
ANY_RATIO = 0.62
MASKABLE_RATIO = 0.465
TAB_RATIO = 0.92  # the transparent tab mark; 92% keeps the browser's own padding

SIZES = [
    ("icon-192.png", 192, ANY_RATIO),
    ("icon-512.png", 512, ANY_RATIO),
    ("apple-touch-icon.png", 180, ANY_RATIO),
    ("icon-maskable-512.png", 512, MASKABLE_RATIO),
]


def blue_mark() -> Image.Image:
    logo = Image.open(ROOT / "images" / "count_logo.png").convert("RGBA")
    return logo.crop(logo.split()[3].getbbox())


def place(canvas: Image.Image, ratio: float) -> Image.Image:
    mark = blue_mark()
    width = round(canvas.width * ratio)
    mark = mark.resize((width, round(width * mark.height / mark.width)), Image.LANCZOS)
    x = round((canvas.width - mark.width) / 2 + OPTICAL_SHIFT * mark.width)
    canvas.alpha_composite(mark, (x, round((canvas.height - mark.height) / 2)))
    return canvas


def plate(size: int, ratio: float) -> Image.Image:
    return place(Image.new("RGBA", (size, size), PLATE), ratio)


def on_transparent(size: int, ratio: float) -> Image.Image:
    return place(Image.new("RGBA", (size, size), (0, 0, 0, 0)), ratio)


def main() -> None:
    for name, size, ratio in SIZES:
        path = ICONS / name
        plate(size, ratio).save(path)
        print(f"wrote {path.relative_to(ROOT)}")

    favicon = PUBLIC / "favicon.ico"
    on_transparent(512, TAB_RATIO).save(favicon, sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"wrote {favicon.relative_to(ROOT)}")

    png = ICONS / "mark-192.png"
    on_transparent(192, TAB_RATIO).save(png)
    print(f"wrote {png.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
