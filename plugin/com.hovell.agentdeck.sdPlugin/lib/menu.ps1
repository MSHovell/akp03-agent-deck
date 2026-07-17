<#
.SYNOPSIS
  Open, close, or read Claude Code Desktop's model / mode / effort menus.

.DESCRIPTION
  These menus are opened through the accessibility tree, NOT keyboard shortcuts.
  That distinction is the whole point of this file: the documented chord for the
  model menu (Ctrl+Shift+I) actually opened an incognito Chat and navigated the
  window off the Code tab. UIA Expand() on the real button opens the real menu
  and nothing else. Verified for all three.

  FINDING THE BUTTONS is the hard part, because each one names itself after its
  current value — "Opus 4.8", "Bypass permissions" — so there is no stable name
  to match, and matching by position breaks the moment the sidebar expands (the
  row moved from x=1177 to x=1689 during development).

  The one stable handle is the effort button's "Effort: " prefix. Everything else
  is derived from it, structurally:

      [mode] [Add] [Dictation] ... [model] [Effort: ...] [Usage]
        ^leftmost                    ^-1        ^anchor

  Offscreen elements are filtered because the Chat tab stays in the tree
  alongside the Code tab, and its controls answer to the same names.

.PARAMETER Menu
  model | mode | effort

.PARAMETER Action
  open  - expand it, print the button's label
  close - collapse it
  state - print the label without touching anything

.OUTPUTS
  The button's current label (e.g. "Opus 4.8"), or "ERROR: <reason>"
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('model', 'mode', 'effort')][string]$Menu,
  [ValidateSet('open', 'close', 'state')][string]$Action = 'state'
)

$ErrorActionPreference = 'Stop'
# Emit UTF-8. Without this the host writes in the OEM code page (Big5 here) and
# Node reads it as UTF-8, so any localised .NET exception message arrives as
# mojibake — which is exactly the text you need when something breaks.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

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

  function Get-ComposerRow {
    $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $pidCond)
    if (-not $win) { return @() }
    $btns = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)

    $anchor = $null
    foreach ($b in $btns) {
      if ($b.Current.Name -like 'Effort:*' -and -not $b.Current.IsOffscreen) { $anchor = $b; break }
    }
    if (-not $anchor) { return @() }

    $ey = $anchor.Current.BoundingRectangle.Y
    $row = @()
    foreach ($b in $btns) {
      if ($b.Current.IsOffscreen) { continue }
      # -join first: on an array, -notmatch filters element-wise instead of
      # returning a boolean, so the naive form skips every button.
      $pats = ($b.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -join ','
      if ($pats -notmatch 'ExpandCollapse') { continue }
      if ([Math]::Abs($b.Current.BoundingRectangle.Y - $ey) -le 6) { $row += $b }
    }
    return @($row | Sort-Object { $_.Current.BoundingRectangle.X })
  }

  function Get-Button($which) {
    # Re-find every call: these elements go stale when their label changes, and a
    # stale reference's Toggle/Expand fails SILENTLY (learned from mic.ps1).
    $row = Get-ComposerRow
    if (-not $row -or $row.Count -eq 0) { return $null }
    $ei = -1
    for ($i = 0; $i -lt $row.Count; $i++) {
      if ($row[$i].Current.Name -like 'Effort:*') { $ei = $i; break }
    }
    if ($ei -lt 0) { return $null }
    switch ($which) {
      'effort' { return $row[$ei] }
      'model'  { return $(if ($ei -gt 0) { $row[$ei - 1] } else { $null }) }
      'mode'   { return $row[0] }
    }
  }

  # Chromium builds its accessibility tree lazily — the first query can be empty.
  $btn = $null
  foreach ($attempt in 1..4) {
    $btn = Get-Button $Menu
    if ($btn) { break }
    Start-Sleep -Milliseconds 700
  }
  if (-not $btn) { Write-Output "ERROR: $Menu button not found (is the Code tab open?)"; exit 1 }

  $pattern = $btn.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)

  # Idempotent on purpose. Expand() on an already-expanded menu throws
  # InvalidOperationException ("Operation is not valid due to the current state
  # of the object"), and a knob fires several ticks faster than this script can
  # run — so open/open/open must not be an error.
  $state = $pattern.Current.ExpandCollapseState
  switch ($Action) {
    'open' {
      if ($state -ne [System.Windows.Automation.ExpandCollapseState]::Expanded) {
        $pattern.Expand()
        Start-Sleep -Milliseconds 250
      }
    }
    'close' {
      if ($state -ne [System.Windows.Automation.ExpandCollapseState]::Collapsed) {
        $pattern.Collapse()
        Start-Sleep -Milliseconds 150
      }
    }
  }

  $btn = Get-Button $Menu   # label may have changed
  Write-Output $(if ($btn) { $btn.Current.Name } else { 'unknown' })
} catch {
  Write-Output "ERROR: $($_.Exception.Message)"
  exit 1
}
