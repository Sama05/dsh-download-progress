param($Url, $Out)
& curl.exe -s -L --fail -o $Out $Url
if ($LASTEXITCODE -ne 0) { throw "curl failed: $LASTEXITCODE" }
