# AKP03 Agent Deck

*English ｜ [繁體中文](README.zh-TW.md)*

Turn a cheap Ajazz AKP03 macro pad into a physical control surface for Claude Code.

Not "buttons that run macros". This moves the **permission prompt off the screen and under your thumb**: before Claude runs `Bash`, the tool name and the command appear on the key face, `✓` and `✗` light up, and the agent waits. The key you press *is* the hook's return value.

```
Claude Code ──PreToolUse hook (http)──> Agent Deck ──setImage──> key lights up
                                             ▲                         │
                                             └────── you press ✓ ──────┘
                                             │
                    {"permissionDecision": "allow"}
                                             ▼
                                     Claude carries on
```

## Prior art, and where this differs

This idea is not original. Several projects put Claude Code on a deck, and at
least one arrived at the identical architecture independently:

| Project | Hardware | Platform |
|---|---|---|
| [agentsd](https://github.com/paultyng/agentsd) | Stream Deck | **macOS only** |
| [cc-streamdeck](https://github.com/alt-core/cc-streamdeck) | Stream Deck Mini | — |
| [AgentDeck](https://github.com/puritysb/AgentDeck) | Stream Deck+, Android, iOS, ESP32, TUI | — |
| [terminaldeck](https://github.com/sidmohan0/terminaldeck) | Stream Deck | — |

**agentsd reached the same core design on its own**: a hook holds the HTTP
response open for up to 120 seconds while a physical key decides. Its action list
overlaps almost exactly — Session, Status, Mode, Approve, Deny, Stop. Two people
finding the same answer separately is usually a sign the answer is right.

So why this one:

- **Windows.** agentsd is macOS-only; Windows is listed as a future enhancement.
- **A ~$30 macro pad, not a ~$150 Stream Deck.** The AKP03 speaks the Mirabox N3
  protocol, not Elgato's, so it needs [opendeck-akp03](https://github.com/4ndv/opendeck-akp03)
  underneath — whose author calls Windows support "untested". It works.
- **Chinese dictation.** Claude Code's built-in dictation rejects `zh-CN`
  outright, so this records with ffmpeg and transcribes locally with whisper.cpp.
- **It drives the Desktop app's UI.** Model, permission mode, usage, fork,
  archive, transcript scrolling — read and operated through the accessibility
  tree, not just hooks.

If you have a Stream Deck on a Mac, use agentsd. It is further along.

## Why this works at all

Three verified facts hold the whole design up:

1. **Claude Code hooks support `type: "http"`** — a hook POSTs straight to our daemon; no shell script wrapper.
2. **`PreToolUse` hooks can return a `permissionDecision`** (`allow` / `deny` / `ask` / `defer`) — so a physical key really does decide whether a tool runs.
3. **command/http hooks default to a 600s timeout** — blocking on a human pressing a button fits comfortably inside that.

## Status: verified on real hardware

Working on Windows 11 + Ajazz AKP03 (`0300:1001`), 2026-07-16.

| Thing | Status |
|---|---|
| Device recognised | ✅ `kind: Akp03` — **the Windows path works** |
| SVG key rendering | ✅ driver reports `Setting image for button 0..8` |
| Tool name on the key | ✅ STATUS key shows `Bash` |
| **Physical key → allow** | ✅ **press it, Claude Code receives `permissionDecision: allow`** |
| All three knobs bound | ✅ (the UI can't bind encoders — writing the profile can) |
| Model switching on K1 | ✅ **confirmed on hardware**: turn to open, move, press to pick |
| Contract tests | ✅ 11/11 (`npm test`) |
| Chinese dictation | ✅ ffmpeg + whisper.cpp, entirely local |
| DISPATCH | ⚠️ spawns a headless run; doesn't inject into your session |
| Multiple sessions | ❌ **one at a time** — see below |

The actual response:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Approved on the AKP03 (physical key)"
  }
}
```

## You need two plugins, and they are not duplicates

It is easy to assume `opendeck-akp03` is enough — it has your exact model in the name. It isn't:

| Plugin | Role | Actions |
|---|---|---|
| `st.lynx.plugins.opendeck-akp03` | **device driver** — teaches OpenDeck to see the hardware | **`[]` — empty** |
| `com.hovell.agentdeck` | **this project** — APPROVE / DENY / STATUS / VOICE / knobs | all of them |

The driver's manifest literally says `"Actions": []` and `"DeviceNamespace": "n3"`. It does HID and nothing else.

Deleting `com.hovell.agentdeck` costs more than the keys: **OpenDeck nulls out all 9 keys in the profile**, because their actions no longer resolve. The symptom looks like "my profile mysteriously emptied itself" and gives no hint that a plugin was involved.

## Install

### Prerequisites

1. **OpenDeck** — https://github.com/nekename/OpenDeck/releases
2. **opendeck-akp03** (the device driver) — https://github.com/4ndv/opendeck-akp03/releases
   Unzip into `%APPDATA%\OpenDeck\plugins\`, then **launch OpenDeck once** so it creates the profiles and device id.
3. Node ≥ 22. Optional, for Chinese dictation: `ffmpeg` and a `whisper.cpp` build.

### Then

```powershell
.\install.ps1 -DetectOnly   # see what it finds; changes nothing
.\install.ps1               # install
```

It detects the device PID, a free port, your microphone's dshow GUID, whisper.cpp's binary and model, and any conflicting software — then writes `config.json`, installs the plugin, generates icons, applies the layout, and offers to install the Claude Code hooks.

**`config.json` is the only file that differs between machines, and every value in it is detected.** Moving to another PC is one command.

Working on the deck itself? `.\install.ps1 -Dev` links the plugin to the source tree instead of copying it.

> ⚠️ **Close the official Stream Dock AJAZZ software, autostart included.** Both drive the same HID device, so one knob turn does two things — its `switchAudio` plugin binds the knob to volume by default. It installs to `Program Files (x86)` (not `Program Files`) and registers under `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`. Back that registry value up before removing it. `install.ps1` detects and warns, but won't touch it for you.
> **The cost:** any key layout you configured in the official software stops working. OpenDeck takes the device over completely.

⚠️ opendeck-akp03's author states plainly that Windows is "untested, you're on your own". It works — but that risk isn't in this codebase.

## Things that cost me a day

Every one of these was hit, diagnosed, and fixed here. They share a shape: **the broken thing looked fine.**

| Symptom | Actual cause |
|---|---|
| Plugin dies on launch | **WSL's `wslrelay` squats on 8787.** Default is now 9317 |
| Config changes do nothing | **PowerShell 5.1's `-Encoding utf8` writes a BOM**; `JSON.parse` throws; the catch silently falls back to defaults. Write JSON with Node |
| EADDRINUSE after a restart | OpenDeck **doesn't reap its plugin processes**; the orphan still holds the port — and `/status` answers from the zombie, looking healthy. Fixed: exit when the host disconnects |
| Profile written, then emptied | `ActionContext` serialises as **`"Keypad.0.0"`** — three parts. `shared.rs` on main shows a five-part form that v2.13.1 does not accept |
| Blank key faces | `setImage` SVG **must be base64**. With `charset=utf8,` + `encodeURIComponent`, OpenDeck writes the percent-encoded text straight to a `.svg` file — not parseable XML |
| Can't bind the encoders | OpenDeck's UI won't assign actions to encoder events — **write the profile JSON directly** |
| Knobs do two things at once | The official Stream Dock software is running in the background, fighting for the device |
| Docs say `Ctrl+Shift+I` opens the model menu | **It opened an incognito Chat and navigated the window off the Code tab.** Desktop shortcuts only hold in the Code tab; the same chord means something else elsewhere. Hence: menus via UIA, never blind keystrokes |
| A knob "does nothing" | `Expand()` on an already-expanded menu throws `InvalidOperationException` — and a knob fires ticks faster than a script runs. Make it idempotent |
| Number keys don't reach dialogs | A CJK IME rewrites them: `2` arrives as `ㄉ` |
| **Every action icon is a broken image** | **A non-ASCII character anywhere in the path.** OpenDeck's webview can't load icons from it — though the files are demonstrably there, and Node reads them fine. Bit us twice: a `-Dev` junction pointing at such a source, and profile paths written from the source rather than the install. Keep the plugin under `%APPDATA%` (ASCII by construction) |

And the one that made all the others harder to find: **PowerShell wrote its errors in the OEM code page** while Node read them as UTF-8, so every localised .NET exception arrived as mojibake. I stared at `嚙瘡 "0" 嚙豬數呼嚙編 "Expand"` and guessed wrong. Fixing the encoding surfaced the real message immediately.

> When your debugging tools are broken, you're not debugging. You're guessing.

## Try it without the hardware

```bash
npm run console
```

Your keyboard becomes the deck (`a` approve / `d` deny / `i` interrupt). Point the hooks at it, run Claude Code in another terminal, trigger a `Bash` call — the request shows up in the console. **If that loop doesn't work, the hardware won't save you.**

## Two invariants

**1. The timeout has a direction.**

```
plugin config.json     approvalTimeoutMs: 90000  ← must be smaller
.claude/settings.json  PreToolUse timeout: 120   ← must be larger
```

The plugin has to give up first. It gives up → answers `defer` → you get the normal on-screen prompt. If Claude Code gives up first, you get a hook error instead.

**2. Every failure path answers `defer`.**

Device unplugged, plugin crashed, malformed body, timeout, superseded by a newer call — all `defer`, handing the decision back to Claude Code's own permission flow. Tests enforce this.

> An agent that hangs silently for ten minutes is far worse than an agent that shows a prompt.

## One session at a time

The state machine has **one** pending slot. When a second session asks for approval, the first is deferred.

That's deliberate — otherwise stale requests hang forever. But the cost is real: **install the hooks globally, run several sessions, and they defer each other with nothing on screen to explain why.**

Put the hooks in the `.claude/settings.json` of the project that needs them, not `~/.claude/settings.json`. Global works, as long as you know this.

(DISPATCH's headless runs pass `--settings '{"hooks":{}}'` so they're exempt — otherwise they'd block on an approval nobody can see.)

## Voice

**You shouldn't have to choose.** The plugin picks on first run and writes the answer to `config.json`:

```
your language ── Claude Code can dictate it? ──yes──> "gui"   (nothing to install)
   from its                 │
`language` setting,         no
 else the OS locale         │
                            v
                    ffmpeg + whisper.cpp present? ──yes──> "local"
                            │
                            no ──> "gui", and the log says what's missing
```

Your language comes from Claude Code's `language` setting, or the OS locale when that's unset — which matters more than it looks. This project's author had never set `language`, and he is the reason `local` exists; reading only the setting handed the one person who needed Chinese the English-only path, silently.

Whatever it decides, `%LOCALAPPDATA%\agent-deck\agent-deck.log` says what and why. Override by editing `voice.mode` in `config.json`.

### `local` (the only one that speaks Chinese)

**Claude Code's dictation does not support Chinese.** Not a setting — the feature isn't there:

> `/voice` prints **"zh-CN" is not a supported dictation language; using English.**

The supported list has 20 languages (English, Japanese, Korean, French, German…) and **no Chinese**. There's an open [feature request](https://github.com/anthropics/claude-code/issues/42920). (Claude's general voice mode has supported 18 languages including Chinese since June 2026. Claude Code just doesn't.)

So Chinese has to be done locally. **Audio never leaves the machine:**

```
press VOICE → ffmpeg records → whisper.cpp transcribes → UIA focuses the composer → paste
```

Needs **ffmpeg** and a **whisper.cpp build + model**. Tested with `large-v3-turbo` (1.6 GB): 11 seconds of audio in ~3.7s, including 1.4s of model load.

Three implementation traps:

| Trap | Fix |
|---|---|
| Killing ffmpeg leaves the WAV header's size fields unwritten; whisper reads an empty file | **Write `q` to its stdin** so it finalises. Which is why Node spawns ffmpeg directly — Node holds that pipe |
| The mic's friendly name is often non-ASCII and gets mangled crossing shells | Use the `@device_cm_` **GUID** — pure ASCII |
| The composer is a contenteditable: UIA exposes only `TextPattern` (read-only), **no ValuePattern** | Clipboard + `Ctrl+V`, with UIA `SetFocus()` first, and **restore the clipboard** afterwards (text only; images/files aren't preserved) |

`autoSubmit` defaults to `false` — the transcript lands in the composer for you to read first. STT mangles names and code terms; sending blind costs more time than it saves.

The key has three states, **all real, none guessed**: `VOICE` → `REC` (red) → `HEARING` (whisper working). That middle one matters: whisper takes seconds, and a key that goes dark reads as a dropped press.

### `gui` (Claude Code Desktop's own dictation — the common case)

**The desktop app has no keyboard shortcut for the microphone.** The `Ctrl+/` list has no voice entry, the docs never mention one, and the CLI's `voice:pushToTalk` binding explicitly doesn't apply ("terminal-based interactive mode shortcuts do not apply in Desktop"). There is no key to send.

So it drives the button itself via **UI Automation** (`lib/mic.ps1`), located by **accessible name**, not coordinates — surviving window moves, DPI changes and layout shifts.

Three behaviours found by probing (Claude v1.21459.3):

| Behaviour | Consequence |
|---|---|
| Labelled "Press and hold to record", but exposes a **TogglePattern** | Toggle to start, toggle to stop. **No holding needed** |
| The button **renames itself**: `Press and hold to record` ↔ `Stop dictation` | Match one name and you lose it the moment recording starts |
| After the rename, a stale reference's `Toggle()` **fails silently** — no error, no effect | Re-find it by name every single time |

Plus a Chromium quirk: it **builds its accessibility tree lazily, only once a UIA client asks**. The first query always comes back empty — that query is the wake-up. `mic.ps1` retries four times.

This is the one key with a real feedback source: `TogglePattern` reports `ToggleState`, so `REC` is a readout. The plugin polls it while recording to catch Claude stopping on its own.

### `cli` (terminal Claude Code, English)

```
/voice tap                                   # must be tap; hold can't be sent
"voice": { "mode": "cli", "key": "{SPACE}" } # match your voice:pushToTalk binding
```

`key` is SendKeys syntax. Rebound to `ctrl+shift+v`? Use `"^+v"`.

### `gui` / `cli` caveats

- **Requires a Claude.ai account** — not available with an API key, Bedrock or Vertex.
- **English only.** The docs' line about "Chinese transcripts count individual words" is about *word counting for languages without spaces* (the auto-submit threshold), not comprehension. It misled me; noting it here so it doesn't mislead you.

## Layout

See [docs/LAYOUT.md](docs/LAYOUT.md) (Chinese) — including why `✓` and `✗` are a full key apart.

## Structure

```
install.ps1            detect-everything installer — the one command per machine
plugin/com.hovell.agentdeck.sdPlugin/
  manifest.json        12 actions (11 keypad + 1 encoder)
  plugin.js            wiring: events → state → redraw
  lib/state.js         the state machine. Knows nothing of OpenDeck or HTTP
  lib/hookserver.js    Claude Code hook endpoints. The defer logic lives here
  lib/opendeck.js      Elgato-protocol WebSocket client
  lib/icons.js         key art as SVG. A state change is just a different string
  lib/keycaps.js       28 swappable keycap faces (the picker imports this too)
  lib/host.ps1         resident UIA host — one process for all UI automation
  lib/{mic,menu,paste,submit}.ps1   one-shot UIA actions
scripts/
  gen-icons.mjs        hand-rolled PNG encoder + distance-field rasteriser
  apply-profile.mjs    writes the layout into an OpenDeck profile, encoders too
  dev-console.mjs      the whole loop, no hardware
  detect-device.ps1    PID detection against the supported list
  probe-controls.ps1   probe Claude Code's UI tree when something can't be found
tests/loop.test.mjs    contract tests, aimed at the failure paths
```

**Zero npm dependencies.** Node 22+ gives `WebSocket` natively, `zlib` makes the PNGs, `http` receives the hooks.

## Credits

- [OpenDeck](https://github.com/nekename/OpenDeck) by nekename — the host this plugs into
- [opendeck-akp03](https://github.com/4ndv/opendeck-akp03) by Andrey Viktorov — the device driver that makes the AKP03 visible at all
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) by Georgi Gerganov — local transcription

## License

MIT
