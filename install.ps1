<#
.SYNOPSIS
  Set up Agent Deck on this machine. Detects everything; hardcodes nothing.

.DESCRIPTION
  Everything machine-specific — the device PID, a free port, the microphone's
  dshow GUID, whisper.cpp's location — is discovered here and written into
  config.json. That is the whole reason this file exists: config.json is the
  only thing that differs between machines, and none of it should be typed by
  hand.

  Detection runs first and changes nothing. You see the full picture, then decide.

  Idempotent: safe to re-run after plugging in a different mic, moving whisper,
  or upgrading OpenDeck.

.PARAMETER Dev
  Link the plugin to this source tree (a junction) instead of copying it, so
  edits take effect on the next OpenDeck restart. For working ON the deck.

.PARAMETER DetectOnly
  Report what would be configured and stop. Touches nothing.

.PARAMETER Port
  Force a port instead of picking a free one.

.PARAMETER NoHooks
  Skip the Claude Code hook step entirely.

.EXAMPLE
  .\install.ps1 -DetectOnly     # look before you leap
  .\install.ps1                 # install
  .\install.ps1 -Dev            # install for development
#>
param(
  [switch]$Dev,
  [switch]$DetectOnly,
  [int]$Port = 0,
  [switch]$NoHooks
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ROOT = $PSScriptRoot
$PLUGIN_ID = 'com.hovell.agentdeck'
$SRC = Join-Path $ROOT "plugin\$PLUGIN_ID.sdPlugin"

function Say($msg, $colour = 'Gray') { Write-Host $msg -ForegroundColor $colour }
function Ok($msg)   { Write-Host "  [ ok ] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [warn] $msg" -ForegroundColor Yellow }
function Bad($msg)  { Write-Host "  [fail] $msg" -ForegroundColor Red }
function Head($msg) { Write-Host ""; Write-Host $msg -ForegroundColor Cyan }

$findings = [ordered]@{}
$blockers = @()

# ── detect ──────────────────────────────────────────────────────────────────

Head '1. Prerequisites'

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $v = (& node -v) -replace '^v', ''
  $major = [int]($v -split '\.')[0]
  # Node 22 is the floor: the plugin uses the built-in global WebSocket, which is
  # what keeps this project at zero npm dependencies.
  if ($major -ge 22) { Ok "Node $v" } else { Bad "Node $v — need >= 22"; $blockers += 'node' }
} else { Bad 'Node not found — https://nodejs.org'; $blockers += 'node' }

$odExe = Join-Path $env:LOCALAPPDATA 'OpenDeck\opendeck.exe'
$odPlugins = Join-Path $env:APPDATA 'OpenDeck\plugins'
if (Test-Path $odExe) { Ok "OpenDeck at $odExe" }
else { Bad 'OpenDeck not found — https://github.com/nekename/OpenDeck/releases'; $blockers += 'opendeck' }

$akp03Driver = Join-Path $odPlugins 'st.lynx.plugins.opendeck-akp03.sdPlugin'
if (Test-Path $akp03Driver) {
  Ok 'AKP03 device driver plugin installed'
} else {
  # This trips people up: the driver and this project are different layers. The
  # driver's manifest declares "Actions": [] — it only teaches OpenDeck to see
  # the hardware. Without it there is no device to put keys on.
  Bad 'opendeck-akp03 device driver NOT installed'
  Say '         That plugin makes OpenDeck see the hardware; this one supplies the keys.' DarkGray
  Say '         Get it: https://github.com/4ndv/opendeck-akp03/releases' DarkGray
  $blockers += 'akp03-driver'
}

Head '2. Hardware'

$detect = Join-Path $ROOT 'scripts\detect-device.ps1'
if (Test-Path $detect) {
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $detect 2>&1 | Out-String
  if ($out -match '\[OK\]\s+(\S+)\s+(.+)') {
    Ok "$($Matches[1])  $($Matches[2].Trim())"
    $findings['device'] = $Matches[1]
  } elseif ($out -match '\[\?\?\]\s+(\S+)') {
    Warn "found $($Matches[1]) but it is not in opendeck-akp03's supported list"
    $findings['device'] = $Matches[1]
  } else {
    Warn 'No AKP03 detected — plug it in (a DATA cable, not charge-only)'
    $findings['device'] = $null
  }
}

Head '3. Port'

# 8787 is excluded on purpose: WSL's port relay squats on it, and the collision
# is invisible from the device — the keys simply never light up.
$listening = @()
try { $listening = (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue).LocalPort } catch {}

# A port held by OUR OWN running plugin is not a conflict — it is this deck,
# already working. Treating it as taken would hand out a new port on every
# re-run and silently break the hook URLs that point at the old one.
function Held-ByUs($p) {
  try {
    $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return $false }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)" -ErrorAction SilentlyContinue
    return ($proc -and $proc.CommandLine -like '*agentdeck*')
  } catch { return $false }
}

# Whatever the current install already uses wins, so re-running is a no-op.
$currentPort = $null
$cfgExisting = Join-Path $SRC 'config.json'
if (Test-Path $cfgExisting) {
  try { $currentPort = (Get-Content $cfgExisting -Raw | ConvertFrom-Json).port } catch {}
}

if ($Port -gt 0) {
  if (($listening -contains $Port) -and -not (Held-ByUs $Port)) { Bad "port $Port is in use by something else"; $blockers += 'port' }
  else { Ok "port $Port (forced)"; $findings['port'] = $Port }
} else {
  $candidates = @()
  if ($currentPort) { $candidates += $currentPort }
  $candidates += @(9317, 8791, 8823, 8842, 9421) | Where-Object { $_ -ne $currentPort }
  $chosen = $null
  foreach ($p in $candidates) {
    if (($listening -notcontains $p) -or (Held-ByUs $p)) { $chosen = $p; break }
  }
  if ($chosen) {
    if (Held-ByUs $chosen) { Ok "port $chosen (already in use by this deck — keeping it)" }
    else { Ok "port $chosen" }
    if ($chosen -ne 9317 -and -not $currentPort) { Warn '9317 was taken; hook URLs will use this port instead' }
    $findings['port'] = $chosen
  } else { Bad 'no free port found'; $blockers += 'port' }
}

Head '4. Voice (optional — Chinese dictation)'

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
$findings['device_str'] = $null
if ($ffmpeg) {
  Ok "ffmpeg at $($ffmpeg.Source)"
  # Parse the dshow listing for the GUID form. The friendly name is often
  # non-ASCII (e.g. "麥克風排列") and gets mangled crossing shell boundaries;
  # the @device_cm_ GUID is pure ASCII and stable.
  #
  # Redirect to a file rather than `2>&1`: ffmpeg prints the device list to
  # STDERR, and under $ErrorActionPreference='Stop' PowerShell wraps every
  # stderr line in an ErrorRecord and aborts the script. This step used to kill
  # the installer on any machine that had ffmpeg.
  $errFile = Join-Path $env:TEMP "agent-deck-ffmpeg-$PID.txt"
  Start-Process -FilePath $ffmpeg.Source `
    -ArgumentList '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy' `
    -NoNewWindow -Wait -RedirectStandardError $errFile -ErrorAction SilentlyContinue
  $devs = if (Test-Path $errFile) { Get-Content $errFile -Raw -Encoding UTF8 } else { '' }
  Remove-Item $errFile -Force -ErrorAction SilentlyContinue
  $lines = $devs -split "`r?`n"
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '"([^"]+)"\s+\(audio\)') {
      $friendly = $Matches[1]
      if ($i + 1 -lt $lines.Count -and $lines[$i + 1] -match 'Alternative name "([^"]+)"') {
        $findings['device_str'] = "audio=$($Matches[1])"
        Ok "microphone: $friendly"
        Say "         using GUID, not the name (names get mangled through shells)" DarkGray
        break
      }
    }
  }
  if (-not $findings['device_str']) { Warn 'no audio capture device found' }
} else {
  Warn 'ffmpeg not found — voice will be disabled (winget install Gyan.FFmpeg)'
}

$findings['whisperBin'] = $null
$findings['whisperModel'] = $null
$whisperGuesses = @(
  (Join-Path $env:USERPROFILE 'whisper.cpp\build\bin\Release\whisper-cli.exe'),
  (Join-Path $env:USERPROFILE 'whisper.cpp\build\bin\whisper-cli.exe'),
  (Join-Path $env:USERPROFILE 'whisper.cpp\whisper-cli.exe')
)
foreach ($g in $whisperGuesses) {
  if (Test-Path $g) { $findings['whisperBin'] = ($g -replace '\\', '/'); break }
}
if (-not $findings['whisperBin']) {
  $cli = Get-Command whisper-cli -ErrorAction SilentlyContinue
  if ($cli) { $findings['whisperBin'] = ($cli.Source -replace '\\', '/') }
}
if ($findings['whisperBin']) {
  Ok "whisper: $($findings['whisperBin'])"
  $modelDir = Join-Path $env:USERPROFILE 'whisper.cpp\models'
  if (Test-Path $modelDir) {
    # Prefer larger models: they are markedly better at Chinese.
    $m = Get-ChildItem $modelDir -Filter 'ggml-*.bin' -ErrorAction SilentlyContinue |
      Sort-Object Length -Descending | Select-Object -First 1
    if ($m) {
      $findings['whisperModel'] = ($m.FullName -replace '\\', '/')
      Ok "model: $($m.Name)  ($([math]::Round($m.Length / 1GB, 2)) GB)"
    } else { Warn "no ggml-*.bin model in $modelDir" }
  }
} else {
  Warn 'whisper.cpp not found — Chinese dictation will be off'
  Say '         Claude Code cannot dictate Chinese at all, so this is the only way' DarkGray
  Say '         to get it: https://github.com/ggerganov/whisper.cpp' DarkGray
}

Head '5. Conflicts'

$sd = Get-Process -Name 'Stream Dock AJAZZ' -ErrorAction SilentlyContinue
$sdRun = (Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).'Stream Dock AJAZZ'
if ($sd -or $sdRun) {
  # Both pieces of software drive the same HID device. Its switchAudio plugin
  # binds the knob to volume, so a knob turn does two things at once.
  Warn 'Ajazz Stream Dock is present — it fights OpenDeck for the same device'
  if ($sd)    { Say "         running now (pid $($sd.Id))" DarkGray }
  if ($sdRun) { Say '         and starts with Windows (HKCU\...\Run)' DarkGray }
  Say '         Close it and remove its autostart, or the knobs will misbehave.' DarkGray
} else { Ok 'no Stream Dock conflict' }

# ── report ──────────────────────────────────────────────────────────────────

Head 'Summary'
Say ("  port          : {0}" -f $findings['port'])
Say ("  microphone    : {0}" -f $(if ($findings['device_str']) { 'detected' } else { 'not found' }))
Say ("  whisper       : {0}" -f $(if ($findings['whisperBin']) { 'detected' } else { 'not found' }))
Say ("  plugin install: {0}" -f $(if ($Dev) { 'junction (dev)' } else { 'copy' }))
Say ''
Say '  Voice mode is decided by the plugin on first run, not here — it has to' DarkGray
Say '  work for store installs that never run this script. The two findings above' DarkGray
Say '  are shown so you know what it will find. Check agent-deck.log afterwards.' DarkGray

if ($blockers.Count) {
  Write-Host ''
  Bad ("Cannot continue: " + ($blockers -join ', '))
  exit 1
}
if ($DetectOnly) {
  Write-Host ''
  Say 'Detect-only: nothing was changed. Re-run without -DetectOnly to install.' Yellow
  exit 0
}

# ── install ─────────────────────────────────────────────────────────────────

Head '6. Writing config.json'

# Written by Node, NOT PowerShell. Set-Content -Encoding utf8 emits a BOM on
# Windows PowerShell 5.1, JSON.parse chokes on it, and loadConfig's catch then
# silently falls back to defaults — a config that looks applied but isn't.
#
# Only `port` is settled here. Everything about voice is left as "auto" for the
# plugin to work out on first run (lib/detect.js), because it must do that anyway
# for anyone who installs from the OpenDeck store and never sees this script.
# Detecting it in both places would just let the two drift apart — and they did:
# this file used to hardcode mode="local", language="zh".
$cfgPath = Join-Path $SRC 'config.json'
$payload = @{
  port = $findings['port']
  approvalTimeoutMs = 90000
  gateTools = @('Bash', 'Write', 'Edit', 'NotebookEdit')
  claudeBin = 'claude'
  voice = @{
    mode = 'auto'
    autoSubmit = $false
    key = '{SPACE}'
  }
} | ConvertTo-Json -Depth 5 -Compress

$writer = @'
const fs = require('fs');
const [, , dest, json] = process.argv;
fs.writeFileSync(dest, JSON.stringify(JSON.parse(json), null, 2) + '\n', 'utf8');
'@
$tmpJs = Join-Path $env:TEMP "agent-deck-write-config-$PID.js"
Set-Content -Path $tmpJs -Value $writer -Encoding ASCII
& node $tmpJs $cfgPath $payload
Remove-Item $tmpJs -Force -ErrorAction SilentlyContinue

# Prove it round-trips, rather than trusting that it did.
$check = & node -e "const c=require('$($cfgPath -replace '\\','/')');console.log(c.port)" 2>&1
if ($check -eq $findings['port']) { Ok "config.json written and parses (port $check)" }
else { Bad "config.json did not round-trip: $check"; exit 1 }

Head '7. Stopping OpenDeck'

# OpenDeck defaults to background:true, so closing its window only hides it in
# the tray — CloseMainWindow() returns happily while the process lives on. A
# force stop is the only way out from a script, which means unsaved edits in its
# UI are lost. Hence the warning rather than a silent kill.
$od = Get-Process opendeck -ErrorAction SilentlyContinue
if ($od) {
  Warn 'OpenDeck must be stopped to write the profile.'
  Say '         It runs in the tray, so this is a force stop: anything unsaved in' DarkGray
  Say '         its UI will be lost. Quit it from the tray icon first if that matters.' DarkGray
  $ans = Read-Host '         Stop OpenDeck now? [y/N]'
  if ($ans -notmatch '^[Yy]') { Say '  Aborted. Nothing else was changed.' Yellow; exit 1 }
  $od | Stop-Process -Force
  Start-Sleep -Seconds 2
  Ok 'stopped'
}
# Reap orphaned plugin processes: OpenDeck does not reap them, and a survivor
# still holds the hook port, so the next launch dies with EADDRINUSE.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*agentdeck*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Head '8. Installing the plugin'

$dest = Join-Path $odPlugins "$PLUGIN_ID.sdPlugin"
if (Test-Path $dest) {
  # Remove-Item on a junction removes the link, not the target — but be explicit.
  $item = Get-Item $dest -Force
  if ($item.LinkType) { $item.Delete() } else { Remove-Item $dest -Recurse -Force }
}
if ($Dev) {
  # A junction resolves to the source path, and OpenDeck's webview cannot load
  # icons from a path with non-ASCII characters in it — the whole action list
  # renders as broken images, while the files are demonstrably there. Copying
  # into %APPDATA% sidesteps it because that path is ASCII by construction.
  if ($SRC -notmatch '^[\x00-\x7F]*$') {
    Warn 'This source path contains non-ASCII characters.'
    Say "         $SRC" DarkGray
    Say '         A -Dev junction points OpenDeck at that path, and its webview' DarkGray
    Say '         cannot load icons from it — every action icon goes blank.' DarkGray
    Say '         Move the repo to an ASCII path, or install without -Dev.' DarkGray
    $ans = Read-Host '         Link anyway? [y/N]'
    if ($ans -notmatch '^[Yy]') { Say '  Aborted.' Yellow; exit 1 }
  }
  New-Item -ItemType Junction -Path $dest -Target $SRC | Out-Null
  Ok "junction -> $SRC"
} else {
  Copy-Item -Recurse -Force $SRC $odPlugins
  Ok "copied to $dest"
}

Head '9. Icons and layout'
& node (Join-Path $ROOT 'scripts\gen-icons.mjs') | Out-Null
Ok 'icons generated'
$profileOut = & node (Join-Path $ROOT 'scripts\apply-profile.mjs') '--write' 2>&1 | Out-String
if ($profileOut -match 'wrote') { Ok 'profile applied (6 keys, 3 knobs)' }
else { Warn 'profile not written — plug the deck in and run: node scripts/apply-profile.mjs --write' }

Head '10. Claude Code hooks'

if ($NoHooks) {
  Say '  skipped (-NoHooks)' DarkGray
} else {
  Say '  The hooks are what make the physical keys mean anything:' DarkGray
  Say '    - status only  : the deck shows idle/thinking/done. Nothing is gated.' DarkGray
  Say '    - full         : Bash/Write/Edit STOP and wait for you to press a key.' DarkGray
  Write-Host ''
  Say '  Scope matters: the deck serves ONE session at a time. Install globally and' DarkGray
  Say '  several sessions will defer each other, with nothing on screen to explain why.' DarkGray
  Write-Host ''
  $scope = Read-Host '  Install hooks? [p]roject / [g]lobal / [n]one (default: n)'
  if ($scope -match '^[pg]') {
    $target = if ($scope -match '^p') { Join-Path $ROOT '.claude\settings.json' } else { Join-Path $env:USERPROFILE '.claude\settings.json' }
    $gate = Read-Host '  Gate tool calls too, or status only? [s]tatus / [f]ull (default: s)'
    $full = $scope -and ($gate -match '^[Ff]')

    $hookJs = @'
const fs = require('fs'), path = require('path');
const [, , target, port, full] = process.argv;
const url = (p) => `http://127.0.0.1:${port}/hook/${p}`;
const hooks = {
  UserPromptSubmit: [{ hooks: [{ type: 'http', url: url('userpromptsubmit'), timeout: 5 }] }],
  Notification:     [{ hooks: [{ type: 'http', url: url('notification'), timeout: 5 }] }],
  Stop:             [{ hooks: [{ type: 'http', url: url('stop'), timeout: 5 }] }],
};
if (full === 'true') {
  // 120s must stay ABOVE approvalTimeoutMs (90s): the plugin has to give up
  // first so it can answer "defer" and you still get the on-screen prompt.
  hooks.PreToolUse = [{
    matcher: 'Bash|Write|Edit|NotebookEdit',
    hooks: [{ type: 'http', url: url('pretooluse'), timeout: 120, statusMessage: 'Waiting for the AKP03…' }],
  }];
}
fs.mkdirSync(path.dirname(target), { recursive: true });
let existing = {};
if (fs.existsSync(target)) existing = JSON.parse(fs.readFileSync(target, 'utf8').replace(/^﻿/, ''));
if (existing.hooks) { console.log('EXISTING'); process.exit(2); }
fs.writeFileSync(target, JSON.stringify({ ...existing, hooks }, null, 2) + '\n', 'utf8');
console.log('OK');
'@
    $tmpHook = Join-Path $env:TEMP "agent-deck-hooks-$PID.js"
    Set-Content -Path $tmpHook -Value $hookJs -Encoding ASCII
    $r = & node $tmpHook $target $findings['port'] $full.ToString().ToLower() 2>&1 | Out-String
    Remove-Item $tmpHook -Force -ErrorAction SilentlyContinue
    if ($r -match 'OK') { Ok "hooks -> $target  ($(if ($full) { 'full: keys gate tools' } else { 'status only' }))" }
    elseif ($r -match 'EXISTING') { Warn "$target already has hooks — merge by hand (see claude/settings.hooks.json)" }
    else { Warn "hook write failed: $r" }
  } else { Say '  skipped' DarkGray }
}

Head 'Done'
Say '  Start OpenDeck. The deck should light up.' Green
Write-Host ''
Say '  Check it:' DarkGray
Say ("    curl http://127.0.0.1:{0}/status     -> deviceReady: true" -f $findings['port']) DarkGray
Say '    npm run console                       -> drive the loop with no hardware' DarkGray
Say ("  Logs: {0}\agent-deck\agent-deck.log" -f $env:LOCALAPPDATA) DarkGray
Write-Host ''
