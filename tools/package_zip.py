from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


root = Path(__file__).resolve().parent.parent
target = root / ".local" / "Meine-Bewerbungen.zip"
target.parent.mkdir(exist_ok=True)
paths = [
    "README.md",
    "INSTALL.md",
    "AGENTS.md",
    "CLAUDE.md",
    "Start Windows.cmd",
    "Start macOS.command",
    "package.json",
    "package-lock.json",
    "docs/WORKFLOW.md",
    "docs/ANLEITUNG.md",
    "tools/launch.mjs",
    "tools/setup.ps1",
    "tools/setup.sh",
    "tools/browser-start.mjs",
    "tools/native-draft.mjs",
    "tools/npm.mjs",
]
files = [root / item for item in paths]
for directory in (
    "server", "web",
    ".agents/skills/meine-bewerbungen", ".codex/agents",
    ".claude/skills/meine-bewerbungen", ".claude/agents",
):
    files.extend(sorted((root / directory).rglob("*")))

with ZipFile(target, "w", ZIP_DEFLATED) as archive:
    for path in files:
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        entry = ZipInfo(relative.as_posix())
        entry.create_system = 3
        entry.external_attr = (0o100755 if path.suffix == ".command" else 0o100644) << 16
        entry.compress_type = ZIP_DEFLATED
        content = path.read_bytes()
        if path.suffix == ".command":
            content = content.replace(b"\r\n", b"\n")
        archive.writestr(entry, content)
        if relative.as_posix() == "web/anleitung.html":
            archive.writestr("Anleitung.html", content)
        if relative.as_posix() == "web/anleitung.css":
            archive.writestr("anleitung.css", content)
        if relative.parts[:2] == ("web", "anleitung-bilder"):
            archive.writestr(Path(*relative.parts[1:]).as_posix(), content)

print(target)
