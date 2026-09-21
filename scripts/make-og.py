"""
生成社交分享图（og:image）。

微信、X、Slack 抓到链接时展示的就是这张图，1200x630 是通用尺寸。
构图上刻意和站内程序化封面保持一致：同一套深色底 + 同心圆 + 左上角那一段强调色短线。

这是一次性资源生成脚本，不是构建链路的一部分——产物 public/og-default.png 提交进仓库即可。
要重跑才需要 Python + Pillow：

    python scripts/make-og.py
"""
from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630

BG_TOP = (15, 36, 32)
BG_BOTTOM = (6, 15, 13)
INK = (245, 245, 247)
MUTED = (161, 161, 166)
FAINT = (110, 110, 115)
ACCENT = (95, 208, 186)

FONT_REGULAR = r"C:\Windows\Fonts\msyh.ttc"
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "og-default.png")


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def gradient() -> Image.Image:
    """先画一张极小的渐变再放大，比逐像素算 1200x630 快且足够平滑。"""
    sw, sh = 120, 63
    small = Image.new("RGB", (sw, sh))
    px = small.load()
    for y in range(sh):
        for x in range(sw):
            t = (x / (sw - 1)) * 0.65 + (y / (sh - 1)) * 0.35
            px[x, y] = (
                lerp(BG_TOP[0], BG_BOTTOM[0], t),
                lerp(BG_TOP[1], BG_BOTTOM[1], t),
                lerp(BG_TOP[2], BG_BOTTOM[2], t),
            )
    return small.resize((W, H), Image.BICUBIC)


def draw_rings(layer: Image.Image) -> None:
    """右侧同心圆，和站内封面的第一种构图同源。"""
    draw = ImageDraw.Draw(layer)
    cx, cy = 1010, 288
    rings = [(112, 58), (212, 46), (322, 36), (442, 26), (572, 16)]
    for radius, alpha in rings:
        draw.ellipse(
            [cx - radius, cy - radius, cx + radius, cy + radius],
            outline=(ACCENT[0], ACCENT[1], ACCENT[2], alpha),
            width=2,
        )
    draw.ellipse([cx - 13, cy - 13, cx + 13, cy + 13], fill=(ACCENT[0], ACCENT[1], ACCENT[2], 230))


def draw_spaced_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    font: ImageFont.FreeTypeFont,
    fill: tuple[int, int, int],
    spacing: int = 0,
) -> None:
    """PIL 没有字距参数，逐字排。中文标题加一点字距会明显更松弛。"""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + spacing


def main() -> None:
    img = gradient().convert("RGBA")

    rings = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw_rings(rings)
    img = Image.alpha_composite(img, rings)

    draw = ImageDraw.Draw(img)

    # 左上角那一段强调色短线：和站内封面、页头 logo 是同一个记号
    draw.rectangle([72, 62, 72 + 38, 62 + 3], fill=ACCENT)

    eyebrow = ImageFont.truetype(FONT_REGULAR, 23)
    title = ImageFont.truetype(FONT_BOLD, 108)
    sub = ImageFont.truetype(FONT_REGULAR, 38)
    foot = ImageFont.truetype(FONT_REGULAR, 23)

    draw_spaced_text(draw, (72, 150), "技术笔记 · 学习记录", eyebrow, FAINT, spacing=4)
    draw_spaced_text(draw, (68, 208), "知行笔记", title, INK, spacing=4)
    draw_spaced_text(draw, (72, 380), "把踩过的坑，写成能复现的笔记。", sub, MUTED, spacing=1)
    draw_spaced_text(
        draw, (72, 512), "Linux · Kubernetes · 混沌工程 · 虚拟化", foot, FAINT, spacing=3
    )

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.convert("RGB").save(OUT, "PNG", optimize=True)
    size_kb = os.path.getsize(OUT) / 1024
    print(f"· og-default.png 已生成：{W}x{H}，{size_kb:.1f}KB")


if __name__ == "__main__":
    main()
