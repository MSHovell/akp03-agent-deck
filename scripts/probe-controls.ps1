<#
.SYNOPSIS
  Probe Claude Code Desktop's composer controls before trusting any of them.

.DESCRIPTION
  Written after two lessons learned the hard way in this project:

  1. Position matching breaks. The composer row sat at x=1177 until the sidebar
     expanded and moved it to x=1689.
  2. The documented keyboard shortcut for the model menu (Ctrl+Shift+I) opened an
     incognito chat and navigated the window off the Code tab entirely.

  So: locate by structure, verify by reading, never by coordinates or docs.

  The nub of the problem is that the model/mode/effort buttons NAME THEMSELVES
  after their current value ("Opus 4.8", "Effort: Medium", "Bypass permissions"),
  so there is no stable name to match. Only "Effort: " has a stable prefix. This
  probe tests whether it can anchor on that and find the others relative to it.

  It also checks a trap: BOTH the Code and Chat tabs live in the tree at once,
  so a naive FindFirst can return a control from the hidden tab.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\probe-controls.ps1
#>

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$proc = Get-Process claude -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1
if (-not $proc) { Write-Host 'Claude Desktop is not running' -ForegroundColor Red; exit 1 }

$root = [System.Windows.Automation.AutomationElement]::RootElement
$pidCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $pidCond)
if (-not $win) { Write-Host 'no window' -ForegroundColor Red; exit 1 }

$btnCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button)
$btns = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)

Write-Host ''
Write-Host '=== 1. Can IsOffscreen tell the hidden tab apart? ===' -ForegroundColor Cyan
$mics = @()
foreach ($b in $btns) {
  if ($b.Current.Name -in @('Press and hold to record', 'Stop dictation')) { $mics += $b }
}
Write-Host "  dictation buttons in the tree: $($mics.Count)"
foreach ($m in $mics) {
  $r = $m.Current.BoundingRectangle
  Write-Host ("    offscreen={0,-5} x={1,-6} y={2,-6} '{3}'" -f `
    $m.Current.IsOffscreen, [int]$r.X, [int]$r.Y, $m.Current.Name)
}
if ($mics.Count -gt 1) {
  Write-Host '    -> more than one: mic.ps1 MUST filter on IsOffscreen' -ForegroundColor Yellow
} else {
  Write-Host '    -> only one; no ambiguity right now' -ForegroundColor Green
}

Write-Host ''
Write-Host '=== 2. Anchor: a button whose name starts with "Effort:" ===' -ForegroundColor Cyan
$effort = $null
foreach ($b in $btns) {
  if ($b.Current.Name -like 'Effort:*' -and -not $b.Current.IsOffscreen) { $effort = $b; break }
}
if (-not $effort) { Write-Host '  NOT FOUND — the anchor idea fails' -ForegroundColor Red; exit 1 }
$er = $effort.Current.BoundingRectangle
Write-Host ("  '{0}'  x={1} y={2}" -f $effort.Current.Name, [int]$er.X, [int]$er.Y) -ForegroundColor Green

Write-Host ''
Write-Host '=== 3. Its row: on-screen ExpandCollapse buttons at the same y ===' -ForegroundColor Cyan
$row = @()
foreach ($b in $btns) {
  if ($b.Current.IsOffscreen) { continue }
  # -join first: on an array, `-notmatch` FILTERS element-wise and returns the
  # non-matching ones, so `if ($pats -notmatch 'X')` is true whenever ANY pattern
  # isn't X — which silently skipped every button here.
  $pats = ($b.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -join ','
  if ($pats -notmatch 'ExpandCollapse') { continue }
  $r = $b.Current.BoundingRectangle
  if ([Math]::Abs($r.Y - $er.Y) -le 6) { $row += $b }
}
$row = @($row | Sort-Object { $_.Current.BoundingRectangle.X })
foreach ($b in $row) {
  Write-Host ("    x={0,-6} '{1}'" -f [int]$b.Current.BoundingRectangle.X, $b.Current.Name)
}

Write-Host ''
Write-Host '=== 4. Derive model / mode from the anchor ===' -ForegroundColor Cyan
if (-not $row -or $row.Count -eq 0) {
  Write-Host '  row is empty — cannot derive anything' -ForegroundColor Red
  exit 1
}
# Match on position, not object identity: FindAll hands back fresh wrappers, so
# the anchor we captured is not reference-equal to its twin in this list.
$idx = -1
for ($i = 0; $i -lt $row.Count; $i++) {
  if ([Math]::Abs($row[$i].Current.BoundingRectangle.X - $er.X) -lt 1) { $idx = $i; break }
}
$model = if ($idx -gt 0) { $row[$idx - 1] } else { $null }
$mode  = $row[0]

Write-Host ("  mode  (leftmost)      : '{0}'" -f $(if ($mode)  { $mode.Current.Name }  else { 'NOT FOUND' }))
Write-Host ("  model (left of Effort): '{0}'" -f $(if ($model) { $model.Current.Name } else { 'NOT FOUND' }))
Write-Host ("  effort (anchor)       : '{0}'" -f $effort.Current.Name)

Write-Host ''
Write-Host '=== 5. Sanity: does the derived model button look like a model? ===' -ForegroundColor Cyan
if ($model -and $model.Current.Name -match '^(Opus|Sonnet|Haiku|Fable)') {
  Write-Host "  yes — '$($model.Current.Name)'" -ForegroundColor Green
} elseif ($model) {
  Write-Host "  NO — got '$($model.Current.Name)'. The relative-position idea is wrong." -ForegroundColor Red
}
Write-Host ''
