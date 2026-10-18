#!/usr/bin/env python3
"""Build claude-canvas-<version>.vsix without npm or vsce.

A .vsix is a zip: `[Content_Types].xml`, `extension.vsixmanifest`, and the
extension's files under `extension/`. This packer adds the Claude Code plugin
folder (../plugin) as `extension/plugin/` so the installed extension can
register it with Claude Code (command "Claude Canvas: Register the Claude Code
plugin").

    python3 extension/tools/package_vsix.py            # -> dist/claude-canvas-<v>.vsix
    code --install-extension dist/claude-canvas-<v>.vsix
"""

import json
import mimetypes
import os
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
EXT = HERE.parent
REPO = EXT.parent
PLUGIN = REPO / "plugin"
DIST = REPO / "dist"

INCLUDE = ["package.json", "extension.js", "README.md", "LICENSE", "media"]
SKIP_DIRS = {"node_modules", ".git", "__pycache__", "tools"}

EXTRA_TYPES = {
    ".vsixmanifest": "text/xml",
    ".json": "application/json",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".ts": "text/plain",
    ".tsx": "text/plain",
    ".css": "text/css",
    ".md": "text/markdown",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain",
    "": "application/octet-stream",
}


def iter_files(root: Path):
    for p in sorted(root.rglob("*")):
        if p.is_dir():
            continue
        if any(part in SKIP_DIRS for part in p.relative_to(root).parts):
            continue
        yield p


def content_type(ext: str) -> str:
    if ext in EXTRA_TYPES:
        return EXTRA_TYPES[ext]
    guess, _ = mimetypes.guess_type(f"x{ext}")
    return guess or "application/octet-stream"


def manifest_xml(pkg: dict) -> str:
    desc = escape(pkg.get("description", ""))
    return f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{pkg["name"]}" Version="{pkg["version"]}" Publisher="{pkg["publisher"]}" />
    <DisplayName>{escape(pkg.get("displayName", pkg["name"]))}</DisplayName>
    <Description xml:space="preserve">{desc}</Description>
    <Tags>{escape(",".join(pkg.get("keywords", [])))}</Tags>
    <Categories>{escape(",".join(pkg.get("categories", ["Other"])))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(pkg["engines"]["vscode"])}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui,workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
    </Properties>
    <License>extension/LICENSE</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
  </Assets>
</PackageManifest>
"""


def main() -> int:
    pkg = json.loads((EXT / "package.json").read_text())
    DIST.mkdir(exist_ok=True)
    out = DIST / f"{pkg['name']}-{pkg['version']}.vsix"

    entries = []  # (zip path, source path)
    for name in INCLUDE:
        src = EXT / name
        if not src.exists():
            print(f"missing {src}", file=sys.stderr)
            return 1
        if src.is_dir():
            for f in iter_files(src):
                entries.append((f"extension/{f.relative_to(EXT).as_posix()}", f))
        else:
            entries.append((f"extension/{name}", src))
    if PLUGIN.exists():
        for f in iter_files(PLUGIN):
            entries.append((f"extension/plugin/{f.relative_to(PLUGIN).as_posix()}", f))

    exts = {os.path.splitext(z)[1].lower() for z, _ in entries} | {".vsixmanifest", ".json"}
    types = "".join(
        f'  <Default Extension="{e}" ContentType="{content_type(e)}" />\n' for e in sorted(exts) if e
    )
    content_types = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
        f"{types}</Types>\n"
    )

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("extension.vsixmanifest", manifest_xml(pkg))
        for zpath, src in entries:
            z.write(src, zpath)
    size = out.stat().st_size
    print(f"{out} ({size / 1e6:.1f} MB, {len(entries)} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
