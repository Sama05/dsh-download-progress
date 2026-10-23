param(
  [string]$Url = 'https://npmmirror.com/mirrors/node/v20.18.0/node-v20.18.0-win-x64.zip',
  [string]$Out = "$env:TEMP\ddp-live-test\node-v20.18.0-win-x64.zip",
  [string]$Rate = '1400k'
)
$ProgressPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $Out
if (-not (Test-Path -LiteralPath $dir)) { [void][System.IO.Directory]::CreateDirectory($dir) }
if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }
& curl.exe -s -L --fail --limit-rate $Rate -o $Out $Url
if ($LASTEXITCODE -ne 0) { throw "curl exit $LASTEXITCODE" }
Write-Host "DONE bytes=$((Get-Item -LiteralPath $Out).Length)"
