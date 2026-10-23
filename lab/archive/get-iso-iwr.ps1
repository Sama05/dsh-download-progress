param($Url, $Out)
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing
