# 上傳 data/controllers.db 到 Railway 服務（存進 Volume）
# 用法：
#   .\upload_controllers.ps1 -Token "你的ADMIN_TOKEN"
#   .\upload_controllers.ps1 -Token "..." -Api "https://api.azzo133456.page"
param(
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$Api = "https://api.azzo133456.page"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$db = Join-Path $PSScriptRoot "data\controllers.db"
if (-not (Test-Path $db)) {
    Write-Host "找不到 $db，請先執行 .\rebuild_controllers.ps1" -ForegroundColor Red
    exit 1
}

$sizeMB = [math]::Round((Get-Item $db).Length / 1MB, 1)
Write-Host "上傳 controllers.db（$sizeMB MB）到 $Api ..." -ForegroundColor Cyan

# 用 curl.exe --data-binary 上傳原始位元組
$resp = curl.exe -s -X POST "$Api/admin/upload-controllers" `
    -H "X-Admin-Token: $Token" `
    --data-binary "@$db"

Write-Host "伺服器回應：$resp"
if ($resp -match '"ok"\s*:\s*true') {
    Write-Host "上傳成功。" -ForegroundColor Green
} else {
    Write-Host "上傳未成功，請檢查 Token 或伺服器狀態。" -ForegroundColor Red
    exit 1
}
