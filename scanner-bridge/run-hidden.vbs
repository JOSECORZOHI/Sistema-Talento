' Ejecutor en modo silencioso (sin consola negra visible)
Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

bridgeDir = FSO.GetParentFolderName(WScript.ScriptFullName)
rootDir = FSO.GetParentFolderName(bridgeDir)

WshShell.CurrentDirectory = rootDir
WshShell.Run "node """ & rootDir & "\scanner-bridge\bridge.js""", 0, False
