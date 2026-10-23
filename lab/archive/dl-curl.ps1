# Downloads with a curl.exe CHILD process, i.e. the bytes land somewhere else.
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Out
)
& curl.exe -s -L --fail -o $Out $Url
if ($LASTEXITCODE -ne 0) { throw "curl failed: $LASTEXITCODE" }
