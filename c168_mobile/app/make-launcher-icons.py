"""Regenerate the Android launcher icons: white plate + the brand's own blue mark.

Same design and the same two details as the web icons in
c168_mobile/frontend/scripts/make-icons.py (kept in sync by hand; both are small):

  * mark size — the adaptive foreground uses 46.5% of the 108dp canvas, the largest that
    still fits Android's 66dp safe circle (the mark's furthest ink is 0.6576 of its width
    from centre). The pre-2026 icons sat at ~63% and were clipped by circular masks.
  * optical centring — the mark's ink centroid is 1.54% of its width left of the bbox
    centre, so we shift it 0.77% right (half compensation; full compensation overshoots).

Layers written (one set per density):
  ic_launcher_background.png  full-bleed white           (adaptive background)
  ic_launcher_foreground.png  blue mark inside the safe circle
  ic_launcher.png             white plate + mark         (legacy, pre-API-26 launchers)
  ic_launcher_round.png       white disc + mark          (legacy round)

Run: python c168_mobile/app/make-launcher-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

APP = Path(__file__).resolve().parent
ROOT = APP.parents[1]
RES = APP / "android" / "app" / "src" / "main" / "res"

PLATE = (255, 255, 255, 255)
OPTICAL_SHIFT = 0.0077
FOREGROUND_RATIO = 0.465  # fits Android's 66dp safe circle on every mask shape
LEGACY_RATIO = 0.62
ROUND_RATIO = 0.52

LAYER_DP = {"ldpi": 81, "mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
LEGACY_DP = {"ldpi": 36, "mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}


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


def main() -> None:
    for density, layer_px in LAYER_DP.items():
        out = RES / f"mipmap-{density}"
        out.mkdir(parents=True, exist_ok=True)

        Image.new("RGBA", (layer_px, layer_px), PLATE).save(out / "ic_launcher_background.png")
        place(Image.new("RGBA", (layer_px, layer_px), (0, 0, 0, 0)), FOREGROUND_RATIO).save(
            out / "ic_launcher_foreground.png"
        )

        legacy_px = LEGACY_DP[density]
        plate(legacy_px, LEGACY_RATIO).save(out / "ic_launcher.png")

        disc = Image.new("RGBA", (legacy_px, legacy_px), (0, 0, 0, 0))
        circle = Image.new("L", (legacy_px, legacy_px), 0)
        ImageDraw.Draw(circle).ellipse((0, 0, legacy_px - 1, legacy_px - 1), fill=255)
        disc.paste(Image.new("RGBA", (legacy_px, legacy_px), PLATE), (0, 0), circle)
        place(disc, ROUND_RATIO).save(out / "ic_launcher_round.png")

        print(f"wrote mipmap-{density}: layers {layer_px}px, legacy {legacy_px}px")


if __name__ == "__main__":
    main()
