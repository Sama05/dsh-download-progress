
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Write-Output 'READY'
$T = [char]9
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq 'QUIT') { break }
  if ($line -eq '') { continue }
  try {
    # One snapshot of every process, so whole-tree questions cost one query.
    $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine |
             Where-Object { $_.Name -in @('powershell.exe','pwsh.exe','curl.exe','wget.exe','aria2c.exe','bitsadmin.exe') }
    foreach ($p in $all) {
      $cmd = [string]$p.CommandLine
      if ($cmd.Length -gt 900) { $cmd = $cmd.Substring(0,900) }
      $cmd = $cmd.Replace([string][char]13, ' ').Replace([string][char]10, ' ').Replace([string][char]9, ' ')
      Write-Output ('P' + $T + $p.ProcessId + $T + $p.ParentProcessId + $T + $p.Name + $T + $cmd)
    }
    Write-Output ('END' + $T + @($all).Count)
  } catch {
    Write-Output ('END' + $T + 0)
  }
}
