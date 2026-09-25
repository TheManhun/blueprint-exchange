#!/usr/bin/env python3
"""Builds the site's pages from src/ into this folder.

The site is plain static HTML on GitHub Pages, so there is no server to
share a header between pages. Instead every page in src/ carries two
markers and this script swaps in the shared pieces:

    <!--HEADER:index-->   the banner + navigation, with the named page
                          highlighted (index, upload, guides, tools,
                          plug, about)
    <!--FOOTER-->         the shared footer

Edit src/*.html and src/_header.html / src/_footer.html, then run

    python build.py           write the pages
    python build.py --check   exit 1 if the built pages are out of date

Files in src/ starting with an underscore are partials, not pages.
Pages without markers (like the old guide.html redirect) are copied as is.
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")


def read(path):
    with io.open(path, encoding="utf-8") as f:
        return f.read()


def render(name, header, footer):
    text = read(os.path.join(SRC, name))
    marker = re.search(r"<!--HEADER:(\w+)-->", text)
    if marker:
        key = marker.group(1)
        marked = re.sub(r'(<a class="navbtn" href="[^"]*" data-nav="%s")' % re.escape(key),
                        r'\1 aria-current="page"', header)
        if marked == header:
            raise SystemExit("%s: no nav link with data-nav=%r" % (name, key))
        text = text.replace(marker.group(0), marked.rstrip("\n"))
    if "<!--FOOTER-->" in text:
        text = text.replace("<!--FOOTER-->", footer.rstrip("\n"))
    return text


def main():
    check = "--check" in sys.argv
    header = read(os.path.join(SRC, "_header.html"))
    footer = read(os.path.join(SRC, "_footer.html"))
    stale = []
    for name in sorted(os.listdir(SRC)):
        if name.startswith("_") or not name.endswith(".html"):
            continue
        out_path = os.path.join(ROOT, name)
        built = render(name, header, footer)
        current = read(out_path) if os.path.exists(out_path) else None
        if current != built:
            stale.append(name)
            if not check:
                with io.open(out_path, "w", encoding="utf-8", newline="\n") as f:
                    f.write(built)
    if check:
        if stale:
            print("out of date:", ", ".join(stale))
            sys.exit(1)
        print("all pages up to date")
    else:
        print("built:", ", ".join(stale) if stale else "(nothing changed)")


if __name__ == "__main__":
    main()
