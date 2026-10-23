param($Url, $Out)
$ProgressPreference = 'SilentlyContinue'
$iso = "D:\AIworks\dsh-download-progress\lab\work\e2e.iso"
Invoke-WebRequest -Uri $Url -OutFile $iso -UseBasicParsing
Write-Output "done"
