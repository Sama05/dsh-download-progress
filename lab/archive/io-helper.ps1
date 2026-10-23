$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Write-Output 'READY'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  if ($line -eq 'QUIT') { break }
  $count = 0
  foreach ($t in $line.Split(',')) {
    $n = 0
    if (-not [int]::TryParse($t.Trim(), [ref]$n)) { continue }
    if ($n -le 0) { continue }
    try {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$n" -Property ProcessId,ReadTransferCount,WriteTransferCount,OtherTransferCount,Name
      if ($p) {
        Write-Output ('P' + [char]9 + [int]$p.ProcessId + [char]9 + [double]$p.ReadTransferCount + [char]9 + [double]$p.WriteTransferCount + [char]9 + [double]$p.OtherTransferCount + [char]9 + [string]$p.Name)
        $count++
      }
    } catch { }
  }
  Write-Output ('END' + [char]9 + $count)
}
