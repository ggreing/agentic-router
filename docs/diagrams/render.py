import sys, glob, os, time
from playwright.sync_api import sync_playwright

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "src")
OUT = os.path.dirname(SRC)
only = sys.argv[1:]

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome")
    pg = b.new_page(viewport={"width": 900, "height": 1400}, device_scale_factor=2.5)
    msgs = []
    pg.on("console", lambda m: msgs.append(m.text))
    pg.on("pageerror", lambda e: msgs.append("PAGEERROR " + str(e)))
    for f in sorted(glob.glob(os.path.join(SRC, "fig*.html"))):
        name = os.path.splitext(os.path.basename(f))[0]
        if only and name not in only:
            continue
        msgs.clear()
        pg.goto("file:///" + f.replace("\\", "/"))
        try:
            pg.wait_for_function("window.__done === true", timeout=8000)
        except Exception:
            print(name, "FAILED", *msgs); continue
        pg.locator("#fig").screenshot(path=os.path.join(OUT, name + ".png"))
        box = pg.locator("#fig").bounding_box()
        print(name, int(box["width"]), "x", int(box["height"]), *msgs)
    b.close()
