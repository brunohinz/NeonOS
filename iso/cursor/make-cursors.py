#!/usr/bin/env python3
"""Gera o tema de cursor "Neon" do NeonOS.

Uso (dentro de um Debian com python3-pil e x11-apps):
    python3 make-cursors.py <pasta-do-tema> <pasta-png-da-interface>

Cada cursor é desenhado numa grade de 32x32 com 4x de superamostragem:
preenchimento escuro, contorno neon e um brilho suave em volta.
"""
import math, os, subprocess, sys, tempfile
from PIL import Image, ImageChops, ImageDraw, ImageFilter

CYAN, HOT, DARK, WHITE = (0, 240, 255), (255, 42, 109), (8, 10, 20), (234, 252, 255)
SIZES = (24, 32, 48, 64)
SS = 4


def render(shape, size, fill=DARK, stroke=CYAN, glow=CYAN, sw=1.5, extra=None, rot=0):
    N = size * SS
    k = N / 32
    mask = Image.new("L", (N, N), 0)
    shape(ImageDraw.Draw(mask), k)
    if rot:
        mask = mask.rotate(rot, resample=Image.BICUBIC, center=(N / 2, N / 2))
    r = max(1, int(sw * k))
    dil = mask.filter(ImageFilter.MaxFilter(2 * r + 1))
    ring = ImageChops.subtract(dil, mask)
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    g = Image.new("RGBA", (N, N), glow + (0,))
    g.putalpha(dil.filter(ImageFilter.GaussianBlur(2.2 * k)).point(lambda v: int(v * .6)))
    img = Image.alpha_composite(img, g)
    f = Image.new("RGBA", (N, N), fill + (255,)); f.putalpha(mask)
    img = Image.alpha_composite(img, f)
    s = Image.new("RGBA", (N, N), stroke + (255,)); s.putalpha(ring)
    img = Image.alpha_composite(img, s)
    if extra:
        layer = Image.new("RGBA", (N, N), (0, 0, 0, 0))
        extra(ImageDraw.Draw(layer), k)
        if rot:
            layer = layer.rotate(rot, resample=Image.BICUBIC, center=(N / 2, N / 2))
        img = Image.alpha_composite(img, layer)
    return img.resize((size, size), Image.LANCZOS)


def P(pts, k):
    return [(x * k, y * k) for x, y in pts]


# ---------------------------------------------------------------- formas (grade 32x32)
ARROW = [(3, 2), (3, 25), (8.6, 19.8), (12.6, 28.6), (16.6, 26.8), (12.6, 18.2), (20.4, 18.2)]


def arrow(d, k): d.polygon(P(ARROW, k), fill=255)


def arrow_extra(d, k):  # risco magenta por dentro, o "detalhe" cyberpunk
    d.line(P([(5.2, 7), (5.2, 18.5)], k), fill=HOT + (255,), width=max(1, int(1.3 * k)))


def hand(d, k):
    rr = lambda x0, y0, x1, y1, rad: d.rounded_rectangle([x0 * k, y0 * k, x1 * k, y1 * k], rad * k, fill=255)
    rr(10, 2, 14.4, 18, 2.2)        # indicador
    rr(14, 10.5, 18, 18, 2)         # dedos
    rr(17.6, 11.5, 21.6, 19, 2)
    rr(21.2, 13, 25, 20, 1.9)
    rr(8, 15, 25, 28.5, 4)          # palma
    d.polygon(P([(8.5, 17.5), (4.6, 13.6), (2.8, 15.2), (7.5, 23)], k), fill=255)  # polegar


def hand_extra(d, k):
    d.line(P([(12.2, 5), (12.2, 12)], k), fill=HOT + (255,), width=max(1, int(1.2 * k)))


def ibeam(d, k):
    d.rectangle([15 * k, 5 * k, 17 * k, 27 * k], fill=255)
    d.rectangle([11 * k, 4 * k, 21 * k, 6 * k], fill=255)
    d.rectangle([11 * k, 26 * k, 21 * k, 28 * k], fill=255)


def cross(d, k):
    for box in ((15, 2, 17, 12), (15, 20, 17, 30), (2, 15, 12, 17), (20, 15, 30, 17)):
        d.rectangle([v * k for v in box], fill=255)
    d.ellipse([14.5 * k, 14.5 * k, 17.5 * k, 17.5 * k], fill=255)


def double_arrow(d, k):  # horizontal ↔
    d.polygon(P([(2, 16), (9, 9), (9, 13.5), (23, 13.5), (23, 9), (30, 16), (23, 23), (23, 18.5), (9, 18.5), (9, 23)], k), fill=255)


def move(d, k):  # cruz fina com quatro pontas de seta
    d.rectangle([14.8 * k, 7 * k, 17.2 * k, 25 * k], fill=255)
    d.rectangle([7 * k, 14.8 * k, 25 * k, 17.2 * k], fill=255)
    for tri in ([(16, 2), (21, 8), (11, 8)], [(16, 30), (21, 24), (11, 24)], [(2, 16), (8, 11), (8, 21)], [(30, 16), (24, 11), (24, 21)]):
        d.polygon(P(tri, k), fill=255)


def ring(d, k):
    d.ellipse([4 * k, 4 * k, 28 * k, 28 * k], fill=255)
    d.ellipse([8 * k, 8 * k, 24 * k, 24 * k], fill=0)


def forbidden_extra(d, k):
    d.line(P([(9, 23), (23, 9)], k), fill=HOT + (255,), width=int(3.4 * k))


def spinner(frame, frames, small=False):
    def extra(d, k):
        cx, cy, R = (24, 24, 6) if small else (16, 16, 10)
        a0 = frame / frames * 360
        box = [(cx - R) * k, (cy - R) * k, (cx + R) * k, (cy + R) * k]
        d.arc(box, a0, a0 + 250, fill=CYAN + (255,), width=int(2.6 * k))
        a = math.radians(a0 + 250)
        d.ellipse([(cx + R * math.cos(a) - 1.8) * k, (cy + R * math.sin(a) - 1.8) * k,
                   (cx + R * math.cos(a) + 1.8) * k, (cy + R * math.sin(a) + 1.8) * k], fill=HOT + (255,))
    return extra


def wait_shape(small):
    def shape(d, k):
        cx, cy, R = (24, 24, 8) if small else (16, 16, 13)
        d.ellipse([(cx - R) * k, (cy - R) * k, (cx + R) * k, (cy + R) * k], fill=255)
        if small:
            arrow(d, k)
    return shape


# ---------------------------------------------------------------- cursores e nomes
CURSORS = {
    # nome: (função que gera a imagem de um tamanho, hotspot na grade 32, nomes alternativos)
    "default": (lambda s: render(arrow, s, extra=arrow_extra), (3, 2),
                ["left_ptr", "arrow", "top_left_arrow", "context-menu", "help", "question_arrow", "copy", "alias", "dnd-none", "dnd-move", "dnd-copy"]),
    "pointer": (lambda s: render(hand, s, extra=hand_extra), (11, 2),
                ["hand1", "hand2", "pointing_hand", "grab", "openhand", "grabbing", "closedhand", "dnd-link"]),
    "text": (lambda s: render(ibeam, s, fill=CYAN, stroke=DARK, sw=1.1), (16, 16), ["xterm", "ibeam", "vertical-text"]),
    "crosshair": (lambda s: render(cross, s, fill=CYAN, stroke=DARK, sw=1.1), (16, 16), ["cross", "tcross", "cell", "color-picker"]),
    "move": (lambda s: render(move, s), (16, 16), ["fleur", "all-scroll", "size_all"]),
    "ew-resize": (lambda s: render(double_arrow, s), (16, 16),
                  ["col-resize", "sb_h_double_arrow", "e-resize", "w-resize", "left_side", "right_side", "h_double_arrow", "size_hor", "split_h"]),
    "ns-resize": (lambda s: render(double_arrow, s, rot=90), (16, 16),
                  ["row-resize", "sb_v_double_arrow", "n-resize", "s-resize", "top_side", "bottom_side", "v_double_arrow", "size_ver", "split_v"]),
    "nwse-resize": (lambda s: render(double_arrow, s, rot=-45), (16, 16),
                    ["se-resize", "nw-resize", "bottom_right_corner", "top_left_corner", "size_fdiag", "bd_double_arrow"]),
    "nesw-resize": (lambda s: render(double_arrow, s, rot=45), (16, 16),
                    ["ne-resize", "sw-resize", "bottom_left_corner", "top_right_corner", "size_bdiag", "fd_double_arrow"]),
    "not-allowed": (lambda s: render(ring, s, fill=HOT, stroke=DARK, glow=HOT, sw=1.1, extra=forbidden_extra), (16, 16),
                    ["no-drop", "forbidden", "crossed_circle", "circle", "dnd-no-drop"]),
}
ANIM = {  # cursores animados: (pequeno?, hotspot, nomes)
    "wait": (False, (16, 16), ["watch"]),
    "progress": (True, (3, 2), ["left_ptr_watch", "half-busy"]),
}
FRAMES, DELAY = 12, 55


def main(theme_dir, png_dir):
    cdir = os.path.join(theme_dir, "cursors")
    os.makedirs(cdir, exist_ok=True)
    os.makedirs(png_dir, exist_ok=True)
    tmp = tempfile.mkdtemp()

    def build(name, images, hot, aliases):
        cfg = os.path.join(tmp, name + ".cfg")
        with open(cfg, "w") as f:
            for size, frames in images.items():
                for i, im in enumerate(frames):
                    path = os.path.join(tmp, f"{name}-{size}-{i}.png")
                    im.save(path)
                    hx, hy = round(hot[0] * size / 32), round(hot[1] * size / 32)
                    f.write(f"{size} {hx} {hy} {path}" + (f" {DELAY}\n" if len(frames) > 1 else "\n"))
        subprocess.run(["xcursorgen", cfg, os.path.join(cdir, name)], check=True)
        for a in aliases:
            link = os.path.join(cdir, a)
            if os.path.lexists(link):
                os.remove(link)
            os.symlink(name, link)

    for name, (fn, hot, aliases) in CURSORS.items():
        build(name, {s: [fn(s)] for s in SIZES}, hot, aliases)
        fn(32).save(os.path.join(png_dir, {"default": "arrow", "not-allowed": "notallowed"}.get(name, name) + ".png"))
    for name, (small, hot, aliases) in ANIM.items():
        imgs = {}
        for s in SIZES:
            imgs[s] = [render(wait_shape(small), s, extra=(lambda d, k, i=i: (arrow_extra(d, k) if small else None, spinner(i, FRAMES, small)(d, k))))
                       for i in range(FRAMES)]
        build(name, imgs, hot, aliases)
        imgs[32][0].save(os.path.join(png_dir, name + ".png"))

    with open(os.path.join(theme_dir, "index.theme"), "w") as f:
        f.write("[Icon Theme]\nName=Neon\nComment=Cursor neon do NeonOS\nInherits=Adwaita\n")
    print("tema de cursor gerado:", len(os.listdir(cdir)), "arquivos")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
