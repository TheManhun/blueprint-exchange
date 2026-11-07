#!/usr/bin/env python3
"""Builds the site's pages from src/ into this folder.

The site is plain static HTML on GitHub Pages, so there is no server to
share a header between pages. Instead every page in src/ carries two
markers and this script swaps in the shared pieces:

    <!--HEADER:index-->   the banner + navigation, with the named page
                          highlighted (index, upload, guides, tools,
                          plug, about)
    <!--FOOTER-->         the shared footer
    <!--INCLUDE:name-->   the contents of src/_name.html (shared markup such
                          as the preview-image field and its dialog)

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
        if marked == header and key != "none":   # HEADER:none -- a page with no nav button of its own
            raise SystemExit("%s: no nav link with data-nav=%r" % (name, key))
        text = text.replace(marker.group(0), marked.rstrip("\n"))
    if "<!--FOOTER-->" in text:
        text = text.replace("<!--FOOTER-->", footer.rstrip("\n"))
    text = re.sub(r"<!--INCLUDE:(\w+)-->",
                  lambda m: read(os.path.join(SRC, "_%s.html" % m.group(1))).rstrip("\n"), text)
    # Search Console (2026-11-07: 'User-declared canonical: None'): every indexable page names its own address
    if 'rel="canonical"' not in text and "noindex" not in text and "</head>" in text:
        url = "https://tfbpx.com/" + ("" if name == "index.html" else name)
        text = text.replace("</head>", '<link rel="canonical" href="%s">\n</head>' % url, 1)
    return text


def page_date(src_path):
    """The day the page's own source last changed: its last commit, or today while it has uncommitted edits.
    Only src/<page> counts -- a shared header / footer change is not new content."""
    import datetime
    import subprocess
    rel = os.path.relpath(src_path, ROOT).replace(os.sep, "/")
    run = lambda *a: subprocess.run(["git", *a], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    if run("status", "--porcelain", "--", rel):
        return datetime.date.today().isoformat()
    return run("log", "-1", "--format=%cs", "--", rel) or datetime.date.today().isoformat()


def sitemap_lastmod():
    """Keep sitemap.xml's page list as written, with a <lastmod> per page (Search Console, 2026-11-07)."""
    path = os.path.join(ROOT, "sitemap.xml")
    text = read(path)

    def one(m):
        loc = m.group(1)
        name = loc.split("tfbpx.com/", 1)[1] or "index.html"
        src = os.path.join(SRC, name)
        if not os.path.exists(src):
            return "  <url><loc>%s</loc></url>" % loc
        return "  <url><loc>%s</loc><lastmod>%s</lastmod></url>" % (loc, page_date(src))

    new = re.sub(r"  <url><loc>([^<]+)</loc>(?:<lastmod>[^<]*</lastmod>)?</url>", one, text)
    if new != text:
        with io.open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(new)
        print("sitemap.xml: lastmod dates updated")


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
    if not check:
        sitemap_lastmod()
    if check:
        if stale:
            print("out of date:", ", ".join(stale))
            sys.exit(1)
        print("all pages up to date")
    else:
        print("built:", ", ".join(stale) if stale else "(nothing changed)")


if __name__ == "__main__":
    main()
