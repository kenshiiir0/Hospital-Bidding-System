' Makes this laptop the office log-in laptop for PS-PhilGEPS (tools/ps-connect-host.js): when anyone presses
' Sync PS-PhilGEPS on any device and the log-in has ended, the log-in opens in Chrome on this laptop and its
' picture shows on their screen, where they tick "I'm not a robot" (one tick here, instead of the picture-puzzle
' loop on GitHub's computer). Runs without a console window; output goes to .ps-philgeps\host.log.
' To start it with Windows: press Win+R, type shell:startup, and put a shortcut to this file there.
' To stop it: end "node.exe" for ps-connect-host.js in Task Manager (the dashboard falls back to GitHub in 90 s).
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FolderExists(".ps-philgeps") Then fso.CreateFolder(".ps-philgeps")
' 0 = no window, False = don't wait
shell.Run "cmd /c node tools\ps-connect-host.js >> .ps-philgeps\host.log 2>&1", 0, False
