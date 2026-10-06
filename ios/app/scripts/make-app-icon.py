"""Draws the iPhone app icon with the desktop app's icon code (scripts/make-icon.py): 1024 px, full
bleed and opaque (iOS rounds the corners itself). Needs Pillow and Windows' Bahnschrift font.
Run: python ios/app/scripts/make-app-icon.py
"""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("make_icon", ROOT / "scripts" / "make-icon.py")
make_icon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(make_icon)

out = ROOT / "ios" / "app" / "Kinoteatri" / "Assets.xcassets" / "AppIcon.appiconset" / "AppIcon.png"
make_icon.draw(1024, full_bleed=True).convert("RGB").save(out)
print("wrote", out)
