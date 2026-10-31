# 桌面端综合回归一键脚本
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\run_e2e.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\run_e2e.ps1 -FreshUserData
#
# -FreshUserData 会清空 userData 后再启动，用于模拟「全新电脑」场景
# （首次注册酷狗设备指纹、酷我取 csrf token 等冷启动路径）。
#
# 脚本会自行启动 Electron、等待调试端口就绪、执行 test\e2e\verify_all.e2e.js，
# 结束后关闭 Electron。全程使用就绪轮询而非固定等待，通常 10 秒内完成。
#
# 放在 scripts\ 而不是 test\ 下，是因为 .gitignore 里忽略了整个 test 目录，
# 放在那里无法纳入版本控制。
param(
  [switch]$FreshUserData
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

$exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) {
  $cmd = Get-Command electron -ErrorAction SilentlyContinue
  if ($cmd) { $exe = $cmd.Source }
}
if (-not $exe) { Write-Host 'EXE_NOT_FOUND (run npm install first)'; exit 3 }

$eArgs = @('./app', '--remote-debugging-port=9222')
if ($FreshUserData) {
  $userData = Join-Path $root 'test\e2e\_fresh_userdata'
  if (Test-Path $userData) { Remove-Item -Recurse -Force $userData }
  New-Item -ItemType Directory -Force -Path $userData | Out-Null
  $eArgs += "--user-data-dir=$userData"
  Write-Host '[runner] fresh userData (simulating a brand new machine)'
}

$out = Join-Path $root 'test\e2e\_app.out.txt'
$err = Join-Path $root 'test\e2e\_app.err.txt'
Start-Process -FilePath $exe -ArgumentList $eArgs -WorkingDirectory $root `
  -RedirectStandardOutput $out -RedirectStandardError $err | Out-Null

# Wait only until the CDP endpoint answers; the page readiness is polled inside
# verify_all.e2e.js, so there is no fixed sleep here.
$ready = $false
for ($i = 0; $i -lt 100; $i++) {
  Start-Sleep -Milliseconds 300
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json' -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch {}
}
if (-not $ready) {
  Write-Host 'CDP_NOT_READY'
  Get-Content $err -Tail 40
  Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  exit 2
}
Write-Host '[runner] CDP ready, running e2e...'

$sw = [System.Diagnostics.Stopwatch]::StartNew()
& node "$root\test\e2e\verify_all.e2e.js" 2>&1 | ForEach-Object { Write-Host $_ }
$code = $LASTEXITCODE
$sw.Stop()
Write-Host ("[runner] e2e finished in {0} sec (exit code {1})" -f [int]$sw.Elapsed.TotalSeconds, $code)

Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
if ($FreshUserData -and (Test-Path (Join-Path $root 'test\e2e\_fresh_userdata'))) {
  Remove-Item -Recurse -Force (Join-Path $root 'test\e2e\_fresh_userdata')
}
exit $code