$ProgressPreference = 'SilentlyContinue'
$Url = 'https://npmmirror.com/mirrors/node/v20.18.0/node-v20.18.0-win-x64.zip'
$Out = 'D:\AIworks\dsh-download-progress\lab\work\file-real.bin'
Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing
Write-Output "done"
