# 從智控總表 Markdown 重建 data/controllers.db
# 用法：
#   .\rebuild_controllers.ps1                      # 用腳本內預設來源
#   .\rebuild_controllers.ps1 -Source "D:\xxx.md"  # 指定來源 md
param(
    [string]$Source = "C:\Users\azzo1\OneDrive\GeminiCLI\智控總表_20240408.md"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "重建 controllers.db，來源：$Source" -ForegroundColor Cyan
node build_controllers_db.mjs "$Source"
if ($LASTEXITCODE -ne 0) { Write-Host "重建失敗" -ForegroundColor Red; exit 1 }

Write-Host "`n完成。接著執行 .\upload_controllers.ps1 -Token <你的ADMIN_TOKEN> 上傳到雲端。" -ForegroundColor Green
