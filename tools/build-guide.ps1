#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$source = Join-Path $root 'docs/ANLEITUNG.md'
$origin = git -C $root remote get-url origin
if ($origin -notmatch '^(?:https://github\.com/|git@github\.com:)([\w.-]+/[\w.-]+?)(?:\.git)?$') {
    throw 'Für die öffentliche Installationsseite wird ein GitHub-Repository als origin benötigt.'
}
$installLink = 'https://github.com/' + $Matches[1] + '/blob/main/INSTALL.md'
$article = (ConvertFrom-Markdown -Path $source).Html
$article = $article.Replace('../web/anleitung-bilder/', './anleitung-bilder/')
$article = $article.Replace('href="../INSTALL.md"', ('href="{0}"' -f $installLink))
$headings = [regex]::Matches($article, '<h2 id="([^"]+)">([^<]+)</h2>')
$navigation = foreach ($heading in $headings) {
    '<a href="#{0}">{1}</a>' -f $heading.Groups[1].Value, $heading.Groups[2].Value
}
$html = @"
<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Anleitung · Meine Bewerbungen</title>
  <link rel="stylesheet" href="./anleitung.css">
</head>
<body>
  <a class="skip" href="#anleitung">Zum Inhalt</a>
  <aside><strong>Meine Bewerbungen</strong><nav aria-label="Kapitel">$($navigation -join "`n")</nav></aside>
  <main>$article</main>
</body>
</html>
"@
[IO.File]::WriteAllText((Join-Path $root 'web/anleitung.html'), $html + "`n")
