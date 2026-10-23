# Polls the plugin's state route at ~1 Hz and appends one line per sample.
# Used by the regression matrix: the download itself must be the only thing the
# pwsh tool call contains, so observation runs in its own background job.
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [int]$Seconds = 60,
  [string]$Out = ''
)

$ProgressPreference = 'SilentlyContinue'
if (-not $Out) { $Out = Join-Path $PSScriptRoot "work\watch-$Tag.log" }
$uri = 'http://127.0.0.1:64866/download-progress/state'

Set-Content -LiteralPath $Out -Value "# watch $Tag $(Get-Date -Format 'HH:mm:ss')" -Encoding utf8

$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
  $stamp = (Get-Date).ToString('HH:mm:ss.fff')
  try {
    $r = Invoke-RestMethod -Uri $uri -TimeoutSec 4
    $tasks = @($r.tasks)
    $bg = @($r.background)
    $line = "$stamp|build=$($r.buildTag)|tasks=$($tasks.Count)|bg=$($bg.Count)"
    foreach ($t in $tasks) {
      $bytes = [double]$t.bytes
      $total = [double]$t.total
      $pct = if ($total -gt 0) { [math]::Round($bytes / $total * 100, 1) } else { 'NA' }
      $spd = if ($t.speed) { [math]::Round([double]$t.speed / 1024, 1) } else { 0 }
      $line += ("|T[{0} k={1} tool={2} lbl='{3}' b={4:N0} tot={5:N0} pct={6} spd={7}KB/s ph={8} done={9} unr={10}]" -f `
          $t.id, $t.kind, $t.name, $t.label, $bytes, $total, $pct, $spd, $t.phase, $t.done, $t.unresolved)
    }
    foreach ($b in $bg) {
      $line += ("|B[{0}/{1}/{2}/{3}s]" -f $b.type, $b.status, $(if ($b.waiting) { 'wait' } else { 'run' }), [math]::Round([double]$b.elapsedMs / 1000))
    }
    Add-Content -LiteralPath $Out -Value $line -Encoding utf8
  } catch {
    Add-Content -LiteralPath $Out -Value "$stamp|ERR $($_.Exception.Message)" -Encoding utf8
  }
  Start-Sleep -Milliseconds 700
}
Add-Content -LiteralPath $Out -Value "# watch $Tag end $(Get-Date -Format 'HH:mm:ss')" -Encoding utf8
