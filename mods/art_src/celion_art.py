"""Draw Celion's placeholder skill icons and projectile sprites (pixel art, nearest-neighbour upscaled)."""

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "lukas_champions"

NAVY = (24, 22, 58, 255)
VIOLET = (92, 62, 168, 255)
CYAN = (110, 220, 255, 255)
WHITE = (250, 250, 255, 255)
GOLD = (255, 205, 90, 255)
ORANGE = (255, 140, 60, 255)


def star(d, cx, cy, r_out, r_in, color, points=4):
    pts = []
    for i in range(points * 2):
        r = r_out if i % 2 == 0 else r_in
        a = -math.pi / 2 + i * math.pi / points
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    d.polygon(pts, fill=color)


def icon_base():
    im = Image.new("RGBA", (32, 32), NAVY)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 31, 31], outline=VIOLET)
    for x, y in [(4, 5), (26, 8), (7, 25), (23, 27), (15, 3)]:
        d.point((x, y), fill=(180, 180, 230, 255))
    return im, d


def save(im, path, scale):
    path.parent.mkdir(parents=True, exist_ok=True)
    im.resize((im.width * scale, im.height * scale), Image.NEAREST).save(path)


def skill_icon():
    # Starlance: a bright star with a trail toward the bottom-left.
    im, d = icon_base()
    for i in range(6):
        d.line([(6 + i, 26 - i), (18 - i // 2, 14 + i // 2)], fill=VIOLET if i % 2 else CYAN)
    star(d, 20, 12, 9, 3, CYAN)
    star(d, 20, 12, 5, 2, WHITE)
    return im


def skill2_icon():
    # Falling Star: a comet diving down onto an impact ring.
    im, d = icon_base()
    d.ellipse([5, 22, 27, 30], outline=ORANGE)
    for i in range(8):
        d.line([(26 - i, 3 + i), (17 - i // 2, 16 + i // 3)], fill=ORANGE if i < 4 else GOLD)
    d.ellipse([10, 15, 19, 24], fill=GOLD)
    d.ellipse([12, 17, 17, 22], fill=WHITE)
    return im


def ult_icon():
    # Mana Surge: concentric arcane rings around a core.
    im, d = icon_base()
    d.ellipse([3, 3, 28, 28], outline=VIOLET, width=2)
    d.ellipse([8, 8, 23, 23], outline=CYAN, width=2)
    star(d, 15.5, 15.5, 7, 2.5, WHITE)
    for a in range(0, 360, 45):
        x = 15.5 + 13 * math.cos(math.radians(a))
        y = 15.5 + 13 * math.sin(math.radians(a))
        d.point((x, y), fill=CYAN)
    return im


def bolt_sprite():
    im = Image.new("RGBA", (12, 12), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    star(d, 6, 6, 6, 2, CYAN)
    star(d, 6, 6, 3, 1, WHITE)
    return im


def comet_sprite():
    im = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse([3, 3, 13, 13], fill=ORANGE)
    d.ellipse([5, 5, 11, 11], fill=GOLD)
    d.ellipse([6, 6, 9, 9], fill=WHITE)
    return im


if __name__ == "__main__":
    save(skill_icon(), OUT / "icons/celion_skill.png", 2)
    save(skill2_icon(), OUT / "icons/celion_skill2.png", 2)
    save(ult_icon(), OUT / "icons/celion_ult.png", 2)
    save(bolt_sprite(), OUT / "projectiles/celion_bolt.png", 2)
    save(comet_sprite(), OUT / "projectiles/celion_comet.png", 3)
    print("wrote art to", OUT)
