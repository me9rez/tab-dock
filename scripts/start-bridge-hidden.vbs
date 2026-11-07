' TabBridge 隐藏启动器
' ---------------------------------------------------------------
' 由计划任务调用：wscript.exe start-bridge-hidden.vbs <node.exe> <server.mjs> <port>
'
' 为什么需要它：node.exe 是控制台子系统程序，计划任务直接启动它必然分配一个
' 控制台窗口（任务设置里的 -Hidden 只隐藏任务计划程序里的显示，不隐藏窗口）。
' wscript.exe 是 GUI 子系统，不分配控制台；sh.Run(cmd, 0, True) 里的 0 = 隐藏窗口，
' True = 同步等待，这样任务状态保持 Running，进程树也归任务管（停止任务可整树结束）。
' ---------------------------------------------------------------
Option Explicit

Dim args, nodeExe, scriptPath, port, fso, workDir, cmd, sh

Set args = WScript.Arguments
If args.Count < 3 Then
    WScript.Echo "用法: wscript start-bridge-hidden.vbs <node.exe> <server.mjs> <port>"
    WScript.Quit 1
End If

nodeExe = args(0)
scriptPath = args(1)
port = args(2)

Set fso = CreateObject("Scripting.FileSystemObject")
If Not fso.FileExists(nodeExe) Then
    WScript.Echo "找不到 node: " & nodeExe
    WScript.Quit 2
End If
If Not fso.FileExists(scriptPath) Then
    WScript.Echo "找不到脚本: " & scriptPath
    WScript.Quit 3
End If

workDir = fso.GetParentFolderName(scriptPath)
cmd = """" & nodeExe & """ """ & scriptPath & """ --port " & port

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = workDir
' 0 = 隐藏窗口，True = 等待子进程退出（让任务保持 Running 并受管理）
sh.Run cmd, 0, True
