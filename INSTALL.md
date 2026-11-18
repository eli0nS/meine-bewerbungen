# Im lokalen Chat installieren

Öffne Codex oder Claude Code auf deinem Computer und teile den Link zu dieser Seite. Ein kurzer Auftrag macht die Absicht eindeutig:

> Installiere diese App auf meinem Gerät und öffne sie im Browser.

Der lokale Chat übernimmt die folgenden Schritte. Du wählst anschließend deinen eigenen Lebenslauf als PDF. Codex oder Claude Code können beim ersten Zugriff um Systemberechtigungen, Projektvertrauen oder eine persönliche Anmeldung bitten. Ein Link allein kann auf einem fremden Gerät keine Software starten.

## Auftrag an den lokalen Assistenten

1. Ermittle das GitHub-Repository aus dem geteilten Link. Klone das vollständige Projekt in einen eigenen Ordner. Verwende einen bereits vorhandenen passenden Checkout wieder und bewahre lokale Änderungen.
2. Lies `AGENTS.md` und arbeite im Projektordner. Starte das passende Setup aus diesem Ordner. Es nutzt Node.js ab Version 24 oder lädt eine mit der offiziellen SHA-256-Prüfsumme geprüfte Node-24-Version in das Benutzerkonto. Es installiert die im Lockfile festgelegten Pakete und Chromium und öffnet den eigenen Arbeitsbereich.
3. **Windows mit Codex:** `powershell -NoProfile -ExecutionPolicy RemoteSigned -File tools/setup.ps1`. **Windows mit Claude Code:** hänge `-Claude` an.
4. **macOS oder Linux mit Codex:** `bash tools/setup.sh`. **Mit Claude Code:** `bash tools/setup.sh --claude`. Unter Linux können je nach Distribution die vom Chromium-Browser benötigten Systembibliotheken fehlen. Melde konkrete fehlende Pakete.
5. Prüfe die vom Starter ausgegebene lokale Adresse. Ziehe auf der persönlichen Startseite deinen Lebenslauf ins PDF-Feld oder wähle **Datei auswählen**. Nach dem Upload führt **Jetzt Stellen finden** zum Suchprofil. Prüfe auch Name und E-Mail und wähle **Suchprofil speichern**. Auf kleinen Bildschirmen sind alle Bereiche über **Menü** erreichbar. Die persönliche Anmeldung erfolgt bei Bedarf direkt beim Anbieter.
6. Verwende im selben Chat den [Projekt-Skill](.agents/skills/meine-bewerbungen/SKILL.md) und die vier projektlokalen Rollen. Bei frisch geklontem Projekt kannst du den Skill zunächst direkt aus der Datei lesen. Bei einer privat installierten Node-Version liegt der Befehl unter Windows in `%LOCALAPPDATA%/MeineBewerbungen/runtime/node-v24.*-win-*/node.exe`, unter macOS und Linux in `~/.bewerbungsatelier/runtime/node-v24.*/bin/node`.
7. Recherche beginnt, wenn die Person ihren Lebenslauf hinterlegt und im Browser eine Suche startet. Bei begleiteter Einrichtung verarbeite den dort gestarteten Webauftrag über den Projekt-Skill. Nur die Browser-App steuert die Freigabe für jede Bewerbung.

[Zur bebilderten Anleitung](docs/ANLEITUNG.md)
