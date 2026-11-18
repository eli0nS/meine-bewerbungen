param([switch]$Claude)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $root
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (!$node -or ([version](& $node.Source -p process.versions.node)).Major -lt 24) {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  if ($arch -notin 'x64','arm64') { throw 'Das Setup unterstützt Windows x64 und ARM64.' }
  $origin = 'https://nodejs.org/dist/latest-v24.x'
  $checks = (Invoke-WebRequest -UseBasicParsing "$origin/SHASUMS256.txt").Content
  if ($checks -is [byte[]]) { $checks = [Text.Encoding]::UTF8.GetString($checks) }
  $match = [regex]::Match($checks,"(?m)^([0-9a-f]{64})  (node-v24\.[0-9]+\.[0-9]+-win-$arch\.zip)\s*$")
  if (!$match.Success) { throw 'Die offizielle Node.js-Prüfsumme fehlt.' }
  $file = $match.Groups[2].Value
  $runtime = Join-Path $env:LOCALAPPDATA 'MeineBewerbungen/runtime'
  $folder = Join-Path $runtime ([IO.Path]::GetFileNameWithoutExtension($file))
  if (!(Test-Path (Join-Path $folder 'node.exe'))) {
    $archive = Join-Path ([IO.Path]::GetTempPath()) ("node-"+[guid]::NewGuid()+".zip")
    try {
      Invoke-WebRequest -UseBasicParsing "$origin/$file" -OutFile $archive
      if ((Get-FileHash -LiteralPath $archive).Hash -ne $match.Groups[1].Value) { throw 'Node.js-Prüfsumme stimmt nicht.' }
      New-Item -Force -ItemType Directory -Path $runtime | Out-Null
      Expand-Archive -LiteralPath $archive -DestinationPath $runtime -Force
    } finally { if (Test-Path $archive) { Remove-Item -LiteralPath $archive } }
  }
  $env:PATH = "$folder;$env:PATH"
}
$launchArgs = @('tools/launch.mjs','--background')
if ($Claude) { $launchArgs += '--claude' }
& node.exe @launchArgs
exit $LASTEXITCODE
