"""Make nav-resources.png / nav-resources-on.png (228x92) from the Guides pair: clear its icon and label with the
plate's own background columns, then draw a layers icon and 'Resources' in Bahnschrift bold condensed.
Run from the repo root: python art/make_nav_resources.py"""
from PIL import Image, ImageDraw, ImageFont

FONT = "C:/Windows/Fonts/bahnschrift.ttf"
SS = 4  # supersampling for the icon and text


def clear(im, x0, x1, src_x, y0=10, y1=82):
    px = im.load()
    for y in range(y0, y1):
        c = px[src_x, y]
        for x in range(x0, x1):
            px[x, y] = c


def layers_icon(size):
    """Three stacked rhombi (the 'layers' sign), white, drawn at SS x."""
    w = h = size * SS
    ic = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(ic)
    cx = w / 2
    rw, rh = w * 0.46, h * 0.17  # half width, half height of one layer
    stroke = int(w * 0.065)
    white = (240, 241, 243, 255)
    # bottom two as open chevrons, the top as a filled rhombus
    for i, cy in enumerate((h * 0.70, h * 0.53)):
        d.line([(cx - rw, cy), (cx, cy + rh), (cx + rw, cy)], fill=white, width=stroke, joint="curve")
    cy = h * 0.33
    d.polygon([(cx, cy - rh), (cx + rw, cy), (cx, cy + rh), (cx - rw, cy)], fill=white)
    return ic.resize((size, size), Image.LANCZOS)


def label(text, px_size):
    f = ImageFont.truetype(FONT, px_size * SS)
    try:
        f.set_variation_by_name("Bold Condensed")
    except Exception:
        pass
    l, t, r, b = f.getbbox(text)
    im = Image.new("RGBA", (r - l + 8, b - t + 8), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((4 - l, 4 - t), text, font=f, fill=(240, 241, 243, 255))
    return im.resize((max(1, im.width // SS), max(1, im.height // SS)), Image.LANCZOS)


for src, dst in (("nav-guides.png", "nav-resources.png"), ("nav-guides-on.png", "nav-resources-on.png")):
    im = Image.open(src).convert("RGBA")
    clear(im, 14, 96, 92)   # the icon
    clear(im, 103, 216, 104)  # the label
    ic = layers_icon(54)
    im.alpha_composite(ic, (int(56 - ic.width / 2), int(46 - ic.height / 2)))
    lb = label("Resources", 22)
    im.alpha_composite(lb, (int(158 - lb.width / 2), int(47 - lb.height / 2)))
    im.save(dst)
    print("wrote", dst)
