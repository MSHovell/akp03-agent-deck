<#
.SYNOPSIS
  Drop transcribed text into Claude Code Desktop's composer.

.DESCRIPTION
  The composer is a contenteditable. UIA sees it as a Group named "Prompt" with
  only a TextPattern — read-only — so there is no SetValue to write into. The
  only way in is the clipboard plus a paste keystroke.

  UIA SetFocus() puts the caret in the composer first, so this works without the
  user having clicked the window.

  The clipboard is saved and restored: dictation should not cost you whatever
  you had copied. Text only — if the clipboard held an image or files, those are
  NOT preserved.

.PARAMETER TextFile
  UTF-8 file holding the text. Passed as a file, not an argument, so Chinese
  survives: shell layers mangle non-ASCII argv (this project already watched
  "AKP03專案" arrive as "AKP03撠?").

.PARAMETER Submit
  Also press Enter to send the prompt.
#>
param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [switch]$Submit
)

$ErrorActionPreference = 'Stop'
# Emit UTF-8 so localised .NET exception messages survive the trip to Node.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

  $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8).Trim()
  if (-not $text) { Write-Output 'ERROR: nothing to paste'; exit 1 }

  $proc = Get-Process claude -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1
  if (-not $proc) { Write-Output 'ERROR: Claude Desktop is not running'; exit 1 }

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $pidCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)

  # Same lazy-accessibility dance as mic.ps1: Chromium only builds the tree once
  # a UIA client asks, so the first query can come back empty.
  $prompt = $null
  $promptCond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Group)),
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, 'Prompt'))
  )
  foreach ($attempt in 1..4) {
    $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $pidCond)
    if ($win) {
      $prompt = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $promptCond)
      if ($prompt) { break }
    }
    Start-Sleep -Milliseconds 700
  }
  if (-not $prompt) { Write-Output 'ERROR: composer not found (is the Code tab open?)'; exit 1 }

  # Save the clipboard before we borrow it.
  $saved = $null
  try { $saved = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}

  Set-Clipboard -Value $text
  $prompt.SetFocus()
  Start-Sleep -Milliseconds 150

  $wsh = New-Object -ComObject WScript.Shell
  $wsh.SendKeys('^v')
  Start-Sleep -Milliseconds 250

  if ($Submit) {
    $wsh.SendKeys('{ENTER}')
    Start-Sleep -Milliseconds 100
  }

  # Restore. The paste has landed by now; putting the old text back any sooner
  # races the paste and pastes the wrong thing.
  if ($null -ne $saved) { Set-Clipboard -Value $saved } else { Set-Clipboard -Value '' }

  Write-Output 'OK'
} catch {
  Write-Output "ERROR: $($_.Exception.Message)"
  exit 1
}
