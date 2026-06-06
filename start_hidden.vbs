Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c npm run dev", 0
Set WshShell = Nothing
