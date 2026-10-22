' Opens the PS-PhilGEPS log-in in Chrome with everything filled in, without a console window. Tick
' "I'm not a robot"; the session is then saved to Supabase and the dashboard's Sync continues by itself.
' Double-click it, or let the dashboard's Sync button open it through the ps-philgeps-connect: link
' (tools/register-connect-link.js). Runs node ps-philgeps-session.js --connect from this folder.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
' 0 = no window, True = wait for the log-in to finish
code = shell.Run("node ps-philgeps-session.js --connect", 0, True)
If code <> 0 Then
    MsgBox "The PS-PhilGEPS log-in did not finish. Press Sync again to retry." & vbCrLf & "(Details: .ps-philgeps\session.log in the project folder.)", vbExclamation, "Connect PS-PhilGEPS"
End If
