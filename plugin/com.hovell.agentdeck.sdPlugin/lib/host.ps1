<#
.SYNOPSIS
  Long-lived UI Automation host. Reads one command per line on stdin, writes one
  result per line on stdout.

.DESCRIPTION
  Exists because spawning a script per knob tick is hopeless. Measured, per call:

      PowerShell start      215 ms
      Add-Type UIA           75 ms
      walk 600+ elements    ~400 ms
      ------------------------------
      total                 ~690 ms

  A knob emits a tick every ~100ms and a mouse wheel feels instant, so 690ms per
  notch turns scrolling into a slideshow. None of that cost is per-command — it
  is per-process. So: pay it once, stay resident, and cache the elements.

  The scroll container is cached and only re-found when it goes stale, which is
  what takes scrolling from ~690ms to single-digit ms.

  PROTOCOL
    stdin :  <cmd> <arg>          e.g. "scroll 3", "usage", "mode-set Plan"
    stdout:  one line per command, "ERROR: ..." on failure

  Commands: scroll <ticks> | scroll-bottom | scroll-pct | usage | usage-toggle
            mode | mode-open | mode-set <name> | mode-close | fork | archive
            ping | quit
#>

param([int]$ParentPid = 0)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

# Die with the plugin.
#
# Closing stdin is supposed to end us, but [Console]::In.ReadLine() just blocks
# forever on a broken pipe — so when OpenDeck force-kills the plugin (and it can
# only BE force-killed: it runs in the tray and ignores WM_CLOSE), this process
# is orphaned holding a UIA connection. They pile up one per restart.
if ($ParentPid) {
  $timer = New-Object System.Timers.Timer
  $timer.Interval = 3000
  $timer.AutoReset = $true
  Register-ObjectEvent -InputObject $timer -EventName Elapsed -MessageData $ParentPid -Action {
    if (-not (Get-Process -Id $Event.MessageData -ErrorAction SilentlyContinue)) {
      [Environment]::Exit(0)
    }
  } | Out-Null
  $timer.Start()
}

$MODES = @('Manual', 'Accept edits', 'Plan', 'Auto', 'Bypass permissions')

# ── cached handles ──────────────────────────────────────────────────────────
$script:Win = $null
$script:Scroller = $null

# Where we INTEND the transcript to be, and when we last said so.
#
# Both exist because scrolling is animated: SetScrollPercent returns at once but
# the position only lands ~200ms later, so reading VerticalScrollPercent right
# after a scroll returns the OLD value. Read-modify-write per tick therefore
# computed every notch from the same stale origin — a whole spin moved exactly
# one notch, which read as "it jumps once and stops".
#
# So a spin accumulates against our own target, and we only re-sync from the
# real position once the user has paused long enough for it to be true again.
$script:ScrollTarget = $null
$script:ScrollAt = [datetime]::MinValue
$RESYNC_AFTER = [timespan]::FromMilliseconds(700)

function Get-Win {
  # A cached window handle survives until Claude restarts; re-find only when the
  # cached one stops answering.
  if ($script:Win) {
    try { $null = $script:Win.Current.Name; return $script:Win } catch { $script:Win = $null }
  }
  $proc = Get-Process claude -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1
  if (-not $proc) { return $null }
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
  $script:Win = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
    [System.Windows.Automation.TreeScope]::Children, $cond)
  return $script:Win
}

function Get-Scroller {
  # The expensive one: a full tree walk asking every element whether it scrolls.
  # Cache it — this is the difference between a wheel and a slideshow.
  if ($script:Scroller) {
    try {
      $p = $script:Scroller.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
      if ($p.Current.VerticallyScrollable) { return $script:Scroller }
    } catch { }
    $script:Scroller = $null
  }
  $w = Get-Win; if (-not $w) { return $null }
  $best = $null; $bestArea = 0
  foreach ($e in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      $p = $e.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
      if (-not $p.Current.VerticallyScrollable) { continue }
      $r = $e.Current.BoundingRectangle
      $area = $r.Width * $r.Height
      # Several elements answer to 'Chat messages' and most are slivers a few
      # pixels tall; the transcript is the big one.
      if ($area -gt $bestArea) { $best = $e; $bestArea = $area }
    } catch { }
  }
  $script:Scroller = $best
  return $best
}

function Find-Btn($predicate) {
  $w = Get-Win; if (-not $w) { return $null }
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
  foreach ($b in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
    if ($b.Current.IsOffscreen) { continue }  # the Chat tab shares these names
    if (& $predicate $b) { return $b }
  }
  return $null
}

# The mode button names itself after the current mode, so it has no stable name.
# The fixed handle in that row is the effort button's 'Effort: ' prefix; mode is
# the leftmost ExpandCollapse button beside it. Never matched by coordinates —
# the row shifts when the sidebar opens.
function Find-Mode {
  $w = Get-Win; if (-not $w) { return $null }
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
  $btns = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $anchor = $null
  foreach ($b in $btns) {
    if ($b.Current.Name -like 'Effort:*' -and -not $b.Current.IsOffscreen) { $anchor = $b; break }
  }
  if (-not $anchor) { return $null }
  $ey = $anchor.Current.BoundingRectangle.Y
  $row = @()
  foreach ($b in $btns) {
    if ($b.Current.IsOffscreen) { continue }
    # -join first: on an array -notmatch filters element-wise instead of
    # returning a boolean, which silently skips every button.
    $pats = ($b.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -join ','
    if ($pats -notmatch 'ExpandCollapse') { continue }
    if ([Math]::Abs($b.Current.BoundingRectangle.Y - $ey) -le 6) { $row += $b }
  }
  return @($row | Sort-Object { $_.Current.BoundingRectangle.X })[0]
}

function Toggle-Expand($el, [string]$want) {
  # Expand() on an already-expanded control throws InvalidOperationException,
  # and keys get pressed faster than this runs.
  $p = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  $open = $p.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded
  switch ($want) {
    'open'   { if (-not $open) { $p.Expand() } }
    'close'  { if ($open) { $p.Collapse() } }
    'toggle' { if ($open) { $p.Collapse() } else { $p.Expand() } }
  }
}

function Invoke-Named($controlType, $prefix) {
  $w = Get-Win; if (-not $w) { return $false }
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType)
  foreach ($e in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
    if ($e.Current.Name -like "$prefix*") {
      $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      return $true
    }
  }
  return $false
}

# ── command loop ────────────────────────────────────────────────────────────

Write-Output 'READY'
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $line = $line.Trim()
  if (-not $line) { continue }
  $sp = $line.IndexOf(' ')
  $cmd = if ($sp -lt 0) { $line } else { $line.Substring(0, $sp) }
  $arg = if ($sp -lt 0) { '' } else { $line.Substring($sp + 1).Trim() }

  try {
    switch ($cmd) {
      'ping' { Write-Output 'pong' }
      'quit' { Write-Output 'bye'; exit 0 }

      'debug' {
        $box = Get-Scroller
        if (-not $box) { Write-Output 'ERROR: no scroller'; break }
        $d = $box.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
        Write-Output ("pct={0} view={1} target={2} | arg='{3}' asDouble={4}" -f `
          $d.Current.VerticalScrollPercent, $d.Current.VerticalViewSize,
          $script:ScrollTarget, $arg, ([double]$arg))
      }

      'scroll' {
        $box = Get-Scroller
        if (-not $box) { Write-Output 'ERROR: no scrollable transcript'; break }
        $sp2 = $box.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)

        # SetScrollPercent, not Scroll(SmallIncrement): measured, 120
        # SmallDecrements moved this container 0.0%. The small amount is a no-op
        # here, LargeIncrement jumps a whole page, and only SetScrollPercent
        # gives a wheel-sized step.
        $view = $sp2.Current.VerticalViewSize

        # Re-sync from reality only after a pause. Mid-spin the real position is
        # still catching up with the last SetScrollPercent, so trusting it would
        # rewind every notch to the same origin.
        $now = [datetime]::UtcNow
        if ($null -eq $script:ScrollTarget -or ($now - $script:ScrollAt) -gt $RESYNC_AFTER) {
          $pct = $sp2.Current.VerticalScrollPercent
          # The pattern reports >100 mid-render; out of range means "at bottom".
          if ($pct -lt 0 -or $pct -gt 100) { $pct = 100 }
          $script:ScrollTarget = $pct
        }

        # ~15% of a viewport per notch ≈ 7 notches to a page, which is roughly
        # how far a physical wheel notch takes you.
        #
        # 0.0/100.0, NOT 0/100. An int literal makes PowerShell bind the
        # Min(int,int) overload, which ROUNDS the double first:
        #   [Math]::Min(100.0, 99.85) -> 100      (not 99.85)
        # Every sub-1% step was silently rounded away, so a notch moved nothing
        # and the knob looked dead. The tell was in the output all along — every
        # reported position was a whole number.
        $script:ScrollTarget = [Math]::Max(0.0, [Math]::Min(100.0,
          $script:ScrollTarget + ([double]$arg * $view * 0.15)))
        $script:ScrollAt = $now

        $sp2.SetScrollPercent(-1, $script:ScrollTarget)
        Write-Output ([math]::Round($script:ScrollTarget, 1))
      }

      'scroll-bottom' {
        $box = Get-Scroller
        if (-not $box) { Write-Output 'ERROR: no scrollable transcript'; break }
        $box.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern).SetScrollPercent(-1, 100)
        $script:ScrollTarget = 100
        $script:ScrollAt = [datetime]::UtcNow
        Write-Output '100'
      }

      'scroll-pct' {
        $box = Get-Scroller
        if (-not $box) { Write-Output 'ERROR: no scrollable transcript'; break }
        $pct = $box.GetCurrentPattern(
          [System.Windows.Automation.ScrollPattern]::Pattern).Current.VerticalScrollPercent
        Write-Output ([math]::Round([Math]::Max(0.0, [Math]::Min(100.0, $pct)), 1))
      }

      { $_ -in 'usage', 'usage-toggle' } {
        $b = Find-Btn { param($x) $x.Current.Name -like 'Usage:*' }
        if (-not $b) { Write-Output 'ERROR: usage button not found'; break }
        if ($cmd -eq 'usage-toggle') {
          Toggle-Expand $b 'toggle'
          Start-Sleep -Milliseconds 150
          $b = Find-Btn { param($x) $x.Current.Name -like 'Usage:*' }
        }
        $n = if ($b) { $b.Current.Name } else { '' }
        if ($n -match 'context\s+(\d+)\s*%.*?plan\s+(\d+)\s*%') {
          Write-Output "$($Matches[1]),$($Matches[2])"
        } else { Write-Output "ERROR: could not parse '$n'" }
      }

      'mode' {
        $m = Find-Mode
        Write-Output $(if ($m) { $m.Current.Name } else { 'ERROR: mode button not found' })
      }

      'mode-open' {
        $m = Find-Mode
        if (-not $m) { Write-Output 'ERROR: mode button not found'; break }
        Toggle-Expand $m 'open'
        Write-Output $m.Current.Name
      }

      'mode-close' {
        $m = Find-Mode
        if (-not $m) { Write-Output 'ERROR: mode button not found'; break }
        Toggle-Expand $m 'close'
        Write-Output 'OK'
      }

      'mode-set' {
        if (-not $arg) { Write-Output 'ERROR: mode-set needs a name'; break }
        $m = Find-Mode
        if (-not $m) { Write-Output 'ERROR: mode button not found'; break }
        Toggle-Expand $m 'open'
        Start-Sleep -Milliseconds 250
        # The options are RadioButtons carrying Invoke — pick outright rather
        # than arrowing around. Number keys are not an option either: a CJK IME
        # rewrites them ('2' arrives as 'ㄉ').
        if (-not (Invoke-Named ([System.Windows.Automation.ControlType]::RadioButton) $arg)) {
          Write-Output "ERROR: no mode option '$arg'"; break
        }
        Start-Sleep -Milliseconds 300
        $m2 = Find-Mode
        Write-Output $(if ($m2) { $m2.Current.Name } else { $arg })
      }

      'fast-toggle' {
        # Fast mode lives inside the model menu as a MenuItem that RENAMES
        # itself — 'Enable fast mode' / 'Disable fast mode' — so match both.
        # Same trap as the dictation button, which is 'Press and hold to record'
        # until it becomes 'Stop dictation'.
        $m = Find-Mode
        $btns = (Get-Win).FindAll([System.Windows.Automation.TreeScope]::Descendants,
          (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Button)))
        $model = $null
        foreach ($b in $btns) {
          if (-not $b.Current.IsOffscreen -and $b.Current.Name -match '^(Opus|Sonnet|Haiku|Fable)') { $model = $b; break }
        }
        if (-not $model) { Write-Output 'ERROR: model button not found'; break }

        Toggle-Expand $model 'open'
        Start-Sleep -Milliseconds 350
        $did = $false
        foreach ($label in 'Disable fast mode', 'Enable fast mode') {
          if (Invoke-Named ([System.Windows.Automation.ControlType]::MenuItem) $label) {
            Write-Output $(if ($label -like 'Disable*') { 'off' } else { 'on' })
            $did = $true
            break
          }
        }
        if (-not $did) {
          Toggle-Expand $model 'close'
          Write-Output 'ERROR: fast mode item not found'
        }
      }

      'fast-state' {
        $btns = (Get-Win).FindAll([System.Windows.Automation.TreeScope]::Descendants,
          (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Button)))
        $model = $null
        foreach ($b in $btns) {
          if (-not $b.Current.IsOffscreen -and $b.Current.Name -match '^(Opus|Sonnet|Haiku|Fable)') { $model = $b; break }
        }
        Write-Output $(if ($model) { $model.Current.Name } else { 'ERROR: model button not found' })
      }

      'session-latest' {
        # Recents is ordered newest-first, so the first entry under its header is
        # the latest session. Anchored on the header rather than a coordinate —
        # the sidebar moves, and entries gain a 'Running ' prefix when active.
        $w = Get-Win; if (-not $w) { Write-Output 'ERROR: no window'; break }
        $cond = New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::Button)
        $all = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)

        # Do NOT require the header to be visible. It is a structural anchor, and
        # it scrolls out of the sidebar's viewport as soon as the list is long —
        # which is exactly when you need this. The newest session can be scrolled
        # off too, so entries are matched offscreen as well; Invoke works on them
        # regardless.
        $recentsY = $null
        foreach ($b in $all) {
          if ($b.Current.Name -eq 'Recents') { $recentsY = $b.Current.BoundingRectangle.Y; break }
        }
        if ($null -eq $recentsY) { Write-Output 'ERROR: Recents not found (is the sidebar open?)'; break }

        $best = $null; $bestY = [double]::MaxValue
        foreach ($b in $all) {
          $r = $b.Current.BoundingRectangle
          if ($r.X -gt 500 -or $r.Y -le $recentsY) { continue }
          $n = $b.Current.Name
          if (-not $n -or $n -like 'More options*' -or $n -like 'Show * in Recents') { continue }
          $pats = ($b.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -join ','
          if ($pats -notmatch 'Invoke') { continue }
          if ($r.Y -lt $bestY) { $best = $b; $bestY = $r.Y }
        }
        if (-not $best) { Write-Output 'ERROR: no session under Recents'; break }
        $name = $best.Current.Name
        $best.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        Write-Output ($name -replace '^Running ', '')
      }

      { $_ -in 'fork', 'archive' } {
        $sa = Find-Btn { param($x) $x.Current.Name -like 'Session actions*' }
        if (-not $sa) { Write-Output 'ERROR: session actions button not found'; break }
        Toggle-Expand $sa 'open'
        Start-Sleep -Milliseconds 250
        $label = if ($cmd -eq 'fork') { 'Fork' } else { 'Archive' }
        if (Invoke-Named ([System.Windows.Automation.ControlType]::MenuItem) $label) {
          Write-Output 'OK'
        } else { Write-Output "ERROR: '$label' not in the session menu" }
      }

      default { Write-Output "ERROR: unknown command '$cmd'" }
    }
  } catch {
    # Never die on one bad command — the deck would go silent with no clue why.
    Write-Output "ERROR: $($_.Exception.Message)"
    $script:Scroller = $null  # most failures mean a stale handle
    $script:Win = $null
  }
}
