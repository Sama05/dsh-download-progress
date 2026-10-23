param(
  [string]$Url = 'http://127.0.0.1:45999/file?mb=1',
  [string]$Out = "$env:TEMP\ddp-live-test\probe.bin",
  [string]$Rate = '400k'
)
$ProgressPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $Out
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -LiteralPath $dir -Force | Out-Null }
if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }
& curl.exe -s -L --fail --limit-rate $Rate -o $Out $Url
if ($LASTEXITCODE -ne 0) { throw "curl exit $LASTEXITCODE" }
Write-Host "DONE bytes=$((Get-Item -LiteralPath $Out).Length)"
