<#
.SYNOPSIS
    把 TabDock 桥注册成登录后自动运行的计划任务（可在开机后无窗口常驻）。
    注：计划任务名沿用 TabBridge（历史部署标识），改名会导致重复任务。

.DESCRIPTION
    计划任务以「当前用户 + 交互会话」运行，这样桥能看到的只是本机回环端口，
    不需要管理员权限；隐藏窗口，失败自动重启。

.EXAMPLE
    pwsh -File scripts/install-bridge-task.ps1
    pwsh -File scripts/install-bridge-task.ps1 -Port 17891
    pwsh -File scripts/install-bridge-task.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'TabBridge',
    [int]$Port = 17890,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

function Remove-BridgeTask {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "已删除计划任务：$TaskName" -ForegroundColor Yellow
    }
    else {
        Write-Host "没有找到计划任务：$TaskName" -ForegroundColor DarkGray
    }
}

if ($Uninstall) {
    Remove-BridgeTask
    return
}

# ---- 定位 node 和服务端脚本 ----
# 注意：mise 的 shims\node.exe 依赖 mise.exe，而本机火绒曾反复终止 mise.exe
# 导致 shim 静默失效。所以优先解析到真实的 node.exe（mise installs 下的版本目录），
# 只有在解析失败时才退回 shim。
$nodeCmd = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeCmd) { $nodeCmd = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $nodeCmd) { throw '找不到 node，请确认 Node 已安装并在 PATH 中。' }

$node = $nodeCmd
try {
    $real = (& $nodeCmd -e "process.stdout.write(process.execPath)" 2>$null)
    if ($real -and (Test-Path $real.Trim())) {
        $node = $real.Trim()
    }
}
catch {
    Write-Host "解析真实 node 路径失败，退回 shim：$nodeCmd" -ForegroundColor Yellow
}

# 兜底：shim 依赖 mise.exe（本机火绒会随机终止它，解析时好时坏）。
# 直接扫 mise installs 的版本目录取最新版 node.exe，不执行任何 mise 组件。
if ($node -like '*shims*') {
    $miseDir = Join-Path $env:LOCALAPPDATA 'mise\installs\node'
    if (Test-Path $miseDir) {
        $cand = Get-ChildItem $miseDir -Directory |
            Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
            Sort-Object { [version]$_.Name } -Descending |
            Select-Object -First 1
        if ($cand -and (Test-Path (Join-Path $cand.FullName 'node.exe'))) {
            $node = Join-Path $cand.FullName 'node.exe'
            Write-Host "shim 解析失败，已从 mise installs 目录取到：$node" -ForegroundColor Yellow
        }
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$server = Join-Path $repoRoot 'bridge\server.mjs'
if (-not (Test-Path $server)) { throw "找不到桥脚本：$server" }

Write-Host "node   : $node"
if ($node -ne $nodeCmd) { Write-Host "         (shim: $nodeCmd)" -ForegroundColor DarkGray }
Write-Host "server : $server"
Write-Host "port   : $Port"
Write-Host ''
Write-Host '注意：node 若升级到新版本目录，请重跑本脚本刷新任务里的路径。' -ForegroundColor DarkGray

Remove-BridgeTask | Out-Null

# 清理可能残留的旧桥进程：否则新任务一启动就因端口被占而退出（返回码 1）
$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($owner -and $owner.CommandLine -like '*server.mjs*') {
        Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Host "已清理占用端口 $Port 的旧桥进程（pid $($listener.OwningProcess)）" -ForegroundColor Yellow
        Start-Sleep -Seconds 2
    }
    else {
        Write-Warning "端口 $Port 被其它程序占用（pid $($listener.OwningProcess)）：$($owner.CommandLine)"
        Write-Warning '桥可能无法启动，请换端口或先停掉那个程序。'
    }
}

$launcher = Join-Path $PSScriptRoot 'start-bridge-hidden.vbs'
if (-not (Test-Path $launcher)) { throw "找不到隐藏启动器：$launcher" }

# 用 wscript.exe 而不是直接跑 node.exe：node 是控制台程序，计划任务直接启动它
# 一定会分配一个黑色控制台窗口；wscript 是 GUI 子系统，可隐藏启动并同步等待，
# 任务状态仍是 Running、进程树归任务管。
$arg = '"{0}" "{1}" "{2}" {3}' -f $launcher, $node, $server, $Port
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" `
    -Argument $arg `
    -WorkingDirectory (Join-Path $repoRoot 'bridge')

$triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"),
    # 兜底：每 5 分钟再触发一次。桥常驻时 MultipleInstances=IgnoreNew 直接忽略；
    # 万一 node 崩了且 RestartCount 用尽，最多 5 分钟内被重新拉起，不用等下次登录
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 5) `
        -RepetitionDuration (New-TimeSpan -Days 3650))
)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew
# MultipleInstances=IgnoreNew 与「每 5 分钟重复」触发器配合：桥已在跑时，
# 重复触发直接被忽略，不会叠加第二个实例。
# 注意：不要加 -Hidden。那个参数会让任务在任务计划程序里被归入“隐藏任务”
# （默认列表看不见，要勾“显示隐藏的任务”），而它并不能隐藏 node 的控制台窗口
# —— 窗口问题由 wscript + start-bridge-hidden.vbs 解决。

$desc = "TabDock：标签页桥 + GitHub 批次收藏（127.0.0.1:$Port）"

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Principal $principal -Settings $settings -Description $desc | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

$info = Get-ScheduledTaskInfo -TaskName $TaskName
$listening = (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0

Write-Host ''
Write-Host "任务已注册并启动：$TaskName" -ForegroundColor Green
Write-Host "  上次结果: $($info.LastTaskResult)"
Write-Host "  端口 $Port 监听: $listening"
Write-Host ''
Write-Host "验证： curl 127.0.0.1:$Port/health" -ForegroundColor Cyan
Write-Host "卸载： pwsh -File scripts/install-bridge-task.ps1 -Uninstall" -ForegroundColor DarkGray
