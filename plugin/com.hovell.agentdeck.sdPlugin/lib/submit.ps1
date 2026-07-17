<#
.SYNOPSIS
  Send whatever is sitting in Claude Code Desktop's composer.

.DESCRIPTION
  Pairs with local voice dictation: the transcript lands in the composer so you
  can read it before it goes anywhere (STT mangles names and code terms), and
  this is the second half — commit it without reaching for the keyboard.

  UIA SetFocus() puts the caret in the composer first, so Enter lands there and
  not in whatever window happened to be in front.

  Focus-then-Enter, deliberately: sending Enter blind would fire it into any
  focused window, and there is no undo on a sent prompt.
#>
$ErrorActionPreference = 'Stop'
# Emit UTF-8 so localised .NET exception messages survive the trip to Node.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

  $proc = Get-Process claude -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1
  if (-not $proc) { Write-Output 'ERROR: Claude Desktop is not running'; exit 1 }

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $pidCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
  $promptCond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Group)),
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, 'Prompt'))
  )

  # Chromium builds its accessibility tree lazily — the first query can be empty.
  $prompt = $null
  foreach ($attempt in 1..4) {
    $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $pidCond)
    if ($win) {
      $prompt = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $promptCond)
      if ($prompt) { break }
    }
    Start-Sleep -Milliseconds 700
  }
  if (-not $prompt) { Write-Output 'ERROR: composer not found (is the Code tab open?)'; exit 1 }

  # Refuse to send an empty prompt rather than firing a stray Enter into the UI.
  #
  # An empty composer does NOT read as "": UIA hands back the placeholder text
  # instead, so a naive -not check passes and we fire anyway. Treat the
  # placeholder as empty. Extend this list if the placeholder changes or you run
  # Claude in another language; the cost of a miss is only a no-op Enter.
  $PLACEHOLDERS = @('Type / for commands', 'How can I help?', 'Reply to Claude')

  $text = ''
  try {
    $text = $prompt.GetCurrentPattern(
      [System.Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(-1).Trim()
  } catch {}
  if (-not $text -or $PLACEHOLDERS -contains $text) {
    Write-Output 'ERROR: composer is empty'
    exit 1
  }

  $prompt.SetFocus()
  Start-Sleep -Milliseconds 150
  (New-Object -ComObject WScript.Shell).SendKeys('{ENTER}')

  Write-Output 'OK'
} catch {
  Write-Output "ERROR: $($_.Exception.Message)"
  exit 1
}
