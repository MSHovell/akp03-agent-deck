<#
.SYNOPSIS
  Drive the Claude Code Desktop dictation button through UI Automation.

.DESCRIPTION
  Claude Code Desktop has no keyboard shortcut for the microphone: the Ctrl+/
  list has no voice entry, and the CLI's `voice:pushToTalk` binding does not
  apply to the desktop app. So the deck operates the button itself.

  Despite its "Press and hold to record" label, the button exposes a UIA
  TogglePattern — Toggle() starts, Toggle() stops, no holding required. It also
  reports ToggleState, so the deck shows whether Claude is REALLY recording
  instead of guessing.

  Two behaviours cost an hour to find, both verified on Claude v1.21459.3:

  1. The button RENAMES itself with state: "Press and hold to record" when idle,
     "Stop dictation" while recording. Searching for one name only works half
     the time.
  2. After the rename, an element reference captured before the toggle goes
     stale, and calling Toggle() on it SILENTLY DOES NOTHING — no exception, no
     effect. It must be re-found by name every single time.

  Located by accessible NAME, never coordinates or AutomationId — the id
  (base-ui-_r_jb_) is regenerated per render.

.PARAMETER Action
  toggle - flip recording, print the resulting state
  state  - print current state, touch nothing

.OUTPUTS
  "On" | "Off" | "ERROR: <reason>"
#>
param(
  [ValidateSet('toggle', 'state')]
  [string]$Action = 'state'
)

$ErrorActionPreference = 'Stop'
# Emit UTF-8: the host otherwise writes in the OEM code page and Node reads it
# as UTF-8, turning localised .NET exception messages into mojibake.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Both faces of the same button.
$NAMES = @('Press and hold to record', 'Stop dictation')

try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

  $proc = Get-Process claude -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1
  if (-not $proc) { Write-Output 'ERROR: Claude Desktop is not running'; exit 1 }

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $pidCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
  $btnCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)

  # Always re-find: see note 2 above.
  function Find-Mic {
    $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $pidCond)
    if (-not $win) { return $null }
    foreach ($n in $NAMES) {
      $c = New-Object System.Windows.Automation.AndCondition($btnCond,
        (New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::NameProperty, $n)))
      $hit = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
      if ($hit) { return $hit }
    }
    return $null
  }

  # Chromium builds its accessibility tree lazily, only once a UIA client asks.
  # The first query after Claude starts comes back empty; that query is what
  # wakes the engine. Retry rather than report a missing button.
  $mic = $null
  foreach ($attempt in 1..4) {
    $mic = Find-Mic
    if ($mic) { break }
    Start-Sleep -Milliseconds 800
  }
  if (-not $mic) { Write-Output 'ERROR: dictation button not found (is the Code tab open?)'; exit 1 }

  if ($Action -eq 'toggle') {
    $mic.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
    Start-Sleep -Milliseconds 400
    $mic = Find-Mic   # the old reference is stale now — it renamed itself
    if (-not $mic) { Write-Output 'ERROR: button vanished after toggle'; exit 1 }
  }

  Write-Output $mic.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState
} catch {
  Write-Output "ERROR: $($_.Exception.Message)"
  exit 1
}
