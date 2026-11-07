"""Make nav-pyt.png / nav-pyt-on.png (228x92) from the Guides pair (Epod 2026-11-07: 'add a button PYT - Mods'): clear its
icon and label with the plate's own background columns, then put the PYT emblem (pyt-button.png) and 'PYT Mods' in
Bahnschrift bold condensed. Run from the repo root: python art/make_nav_pyt.py"""
import importlib.util, os
from PIL import Image

spec = importlib.util.spec_from_file_location("nav", os.path.join(os.path.dirname(__file__), "make_nav_resources.py"))
src = open(spec.origin, encoding="utf-8").read().split("\nfor src, dst in")[0]  # the helpers only, not its own run
ns = {}
exec(src, ns)
clear, label = ns["clear"], ns["label"]

emblem = Image.open("pyt-button.png").convert("RGBA")
for base, dst in (("nav-guides.png", "nav-pyt.png"), ("nav-guides-on.png", "nav-pyt-on.png")):
    im = Image.open(base).convert("RGBA")
    clear(im, 14, 96, 92)    # the icon
    clear(im, 103, 216, 104)  # the label
    h = 66
    ic = emblem.resize((round(emblem.width * h / emblem.height), h), Image.LANCZOS)
    im.alpha_composite(ic, (int(56 - ic.width / 2), int(46 - ic.height / 2)))
    lb = label("PYT Mods", 22)
    im.alpha_composite(lb, (int(158 - lb.width / 2), int(47 - lb.height / 2)))
    im.save(dst)
    print("wrote", dst)
