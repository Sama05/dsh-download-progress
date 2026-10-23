#!/usr/bin/env pwsh
# Copy a slow artifact to the temp dir so a re-run starts from nothing on disk.
# Usage: prepare-fresh.ps1 <target> <source-bytes>
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [int]$Size = 1048576
)
if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Force }
"removed: $(-not (Test-Path -LiteralPath $Target))"
