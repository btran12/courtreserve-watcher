Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Title   = [string]$args[0]
$Message = [string]$args[1]
$Kind    = if ($args.Length -ge 3) { [string]$args[2] } else { 'Info' }
$Millis  = if ($args.Length -ge 4) { [int]$args[3] } else { 10000 }

# Balloon tips are rendered as modern toasts on Windows 10/11. This avoids
# WinRT ToastNotificationManager, which needs a registered AUMID and throws
# "element not found" on machines that lack one.
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = switch ($Kind) {
  'Warning' { [System.Drawing.SystemIcons]::Warning }
  'Error'   { [System.Drawing.SystemIcons]::Error }
  default   { [System.Drawing.SystemIcons]::Information }
}
$tip = switch ($Kind) {
  'Warning' { [System.Windows.Forms.ToolTipIcon]::Warning }
  'Error'   { [System.Windows.Forms.ToolTipIcon]::Error }
  default   { [System.Windows.Forms.ToolTipIcon]::Info }
}

$icon.BalloonTipTitle = $Title
$icon.BalloonTipText  = $Message
$icon.BalloonTipIcon  = $tip
$icon.Visible = $true
$icon.ShowBalloonTip($Millis)

# Give the toast time to render before the process exits and disposes the icon.
Start-Sleep -Milliseconds 2500
$icon.Visible = $false
$icon.Dispose()
exit 0
