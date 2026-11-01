' 快捷方式的启动器：不弹黑色命令行窗口，在后台启动 node server.js。
' 用法：wscript launch.vbs <node.exe 路径> [--open | --background]
Set args = WScript.Arguments
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
mode = "--open"
If args.Count > 1 Then mode = args(1)
cmd = """" & args(0) & """ """ & root & "\server.js"" " & mode
CreateObject("WScript.Shell").Run cmd, 0, False
