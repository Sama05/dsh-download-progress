param([string]$Url, [string]$Out)
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing
