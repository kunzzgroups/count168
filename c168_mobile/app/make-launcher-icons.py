"""Regenerate the Android launcher icons: brand-blue tile + white brand mark.

Why: the shell used the blue mark on a white square (values/ic_launcher_background was
#FFFFFF), which reads as a dirty white chip on the launcher. Same mark, reversed — white
mark on the brand-blue gradient the logo itself uses (sampled off images/count_logo.png),
matching the web app icons in c168_mobile/frontend/scripts/make-icons.py.

Layers written (one set per density):
  ic_launcher_background.png  full-bleed gradient          (adaptive background)
  ic_launcher_foreground.png  white mark inside the safe circle (adaptive foreground)
  ic_launcher.png             gradient + mark composite    (legacy, pre-API-26 launchers)
  ic_launcher_round.png       circular gradient + mark     (legacy round)

The adaptive layers are sized for the 108dp canvas and the v26 XML no longer applies the
old 16.7% inset, so the mark sits in Android's 66dp safe circle on every mask shape.

Run: python c168_mobile/app/make-launcher-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

APP = Path(__file__).resolve().parent
ROOT = APP.parents[1]
RES = APP / "android" / "app" / "src" / "main" / "res"

GRAD_FROM, GRAD_TO = (83, 200, 242), (3, 83, 249)  # sampled off the mark in images/count_logo.png
MARK_CROP = (14, 42, 108, 138)  # mark inside images/count_whitelogo.png

# 108dp adaptive canvas per density (ldpi is legacy but still in the tree)
LAYER_DP = {"ldpi": 81, "mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
# 48dp legacy launcher icon per density
LEGACY_DP = {"ldpi": 36, "mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

# Mark size as a fraction of the canvas. 0.44 keeps the mark inside Android's 66dp safe
# circle (a square of side s fits when s/√2 ≤ 33dp → s ≤ 0.43·108dp) — the launcher's mask
# may be a circle, a squircle or a rounded square, all of which cut the corners.
FOREGROUND_RATIO = 0.44
LEGACY_RATIO = 0.62
ROUND_RATIO = 0.52


def white_mark() -> Image.Image:
    logo = Image.open(ROOT / "images" / "count_whitelogo.png").convert("RGBA")
    return logo.crop(MARK_CROP)


def gradient(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(img)
    for i in range(2 * size):
        t = i / (2 * size - 1)
        rgb = tuple(round(a + (b - a) * t) for a, b in zip(GRAD_FROM, GRAD_TO))
        draw.line([(i, 0), (0, i)], fill=rgb + (255,))
    return img


def scaled_mark(size: int, ratio: float) -> Image.Image:
    mark = white_mark()
    width = round(size * ratio)
    return mark.resize((width, round(width * mark.height / mark.width)), Image.LANCZOS)


def place(canvas: Image.Image, mark: Image.Image) -> Image.Image:
    canvas.alpha_composite(mark, ((canvas.width - mark.width) // 2, (canvas.height - mark.height) // 2))
    return canvas


def main() -> None:
    for density, layer_px in LAYER_DP.items():
        out = RES / f"mipmap-{density}"
        out.mkdir(parents=True, exist_ok=True)

        gradient(layer_px).save(out / "ic_launcher_background.png")  # full bleed, no inset
        place(Image.new("RGBA", (layer_px, layer_px), (0, 0, 0, 0)), scaled_mark(layer_px, FOREGROUND_RATIO)).save(
            out / "ic_launcher_foreground.png"
        )

        legacy_px = LEGACY_DP[density]
        place(gradient(legacy_px), scaled_mark(legacy_px, LEGACY_RATIO)).save(out / "ic_launcher.png")

        disc = Image.new("RGBA", (legacy_px, legacy_px), (0, 0, 0, 0))
        circle = Image.new("L", (legacy_px, legacy_px), 0)
        ImageDraw.Draw(circle).ellipse((0, 0, legacy_px - 1, legacy_px - 1), fill=255)
        disc.paste(gradient(legacy_px), (0, 0), circle)
        place(disc, scaled_mark(legacy_px, ROUND_RATIO)).save(out / "ic_launcher_round.png")

        print(f"wrote mipmap-{density}: layers {layer_px}px, legacy {legacy_px}px")


if __name__ == "__main__":
    main()
