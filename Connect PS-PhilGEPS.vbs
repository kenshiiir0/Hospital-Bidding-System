' Opens the PS-PhilGEPS log-in in Chrome with everything filled in, without a console window. Tick
' "I'm not a robot"; the session is then saved to Supabase and the dashboard's Sync continues by itself.
' Double-click it, or let the dashboard's Sync button open it through the ps-philgeps-connect: link
' (tools/register-connect-link.js). Runs node ps-philgeps-session.js --connect from this folder.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
' The link "ps-philgeps-connect:start?code=..." (from the dashboard) is passed on only when it holds nothing
' but letters, digits and . _ - = ? & : (ps-philgeps-session.js reads the one-time code from it)
link = ""
If WScript.Arguments.Count > 0 Then
    Set re = New RegExp
    re.Pattern = "^ps-philgeps-connect:[A-Za-z0-9._?&=:/-]{0,500}$"
    re.IgnoreCase = True
    If re.Test(WScript.Arguments(0)) Then link = " """ & WScript.Arguments(0) & """"
End If
' 0 = no window, True = wait for the log-in to finish
code = shell.Run("node ps-philgeps-session.js --connect" & link, 0, True)
If code <> 0 Then
    MsgBox "The PS-PhilGEPS log-in did not finish. Press Sync again to retry." & vbCrLf & "(Details: .ps-philgeps\session.log in the project folder.)", vbExclamation, "Connect PS-PhilGEPS"
End If
