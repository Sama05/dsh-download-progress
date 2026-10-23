$ProgressPreference = 'SilentlyContinue'
$Url = 'https://npmmirror.com/mirrors/node/v20.18.0/node-v20.18.0-win-x64.zip'
$Out = 'D:\AIworks\dsh-download-progress\lab\work\slow-real.bin'
& curl.exe -s -L --fail --limit-rate 2M -o $Out $Url
Write-Output "exit=$LASTEXITCODE"
