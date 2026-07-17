# AKP03 Agent Deck

*[English](README.md) ｜ 繁體中文*

把 Ajazz AKP03 變成 Claude Code 的實體協作面板。

不是「按鈕跑巨集」。是把 **permission prompt 從螢幕搬到實體鍵上**：Claude 要跑 `Bash` 之前，工具名和指令會印在鍵面上，`✓` 和 `✗` 亮起來，agent 停在那裡等你按。你按的那一下，就是那個 hook 的回傳值。

```
Claude Code ──PreToolUse hook (http)──> Agent Deck ──setImage──> AKP03 亮起
                                             ▲                      │
                                             └────── 你按 ✓ ────────┘
                                             │
                    {"permissionDecision": "allow"}
                                             ▼
                                        Claude 繼續跑
```

## 前人的東西，以及這個有什麼不同

**這個點子不是獨創的。** 已經有好幾個專案把 Claude Code 搬到 deck 上，其中至少一個**獨立想到了一模一樣的架構**：

| 專案 | 硬體 | 平台 |
|---|---|---|
| [agentsd](https://github.com/paultyng/agentsd) | Stream Deck | **僅 macOS** |
| [cc-streamdeck](https://github.com/alt-core/cc-streamdeck) | Stream Deck Mini | — |
| [AgentDeck](https://github.com/puritysb/AgentDeck) | Stream Deck+、Android、iOS、ESP32、TUI | — |
| [terminaldeck](https://github.com/sidmohan0/terminaldeck) | Stream Deck | — |

**agentsd 的核心設計跟這個完全相同**：hook 撐住 HTTP 回應最多 120 秒，讓實體鍵決定。連 action 清單都幾乎重疊 —— Session、Status、Mode、Approve、Deny、Stop。兩個人各自想到同一個答案，通常代表那是對的答案。

那這個存在的理由：

- **Windows。** agentsd 只有 macOS，Windows 列在 future enhancement。
- **約 30 鎂的巨集鍵盤，不是 150 鎂的 Stream Deck。** AKP03 講的是 Mirabox N3 協定不是 Elgato 的，所以底下要墊 [opendeck-akp03](https://github.com/4ndv/opendeck-akp03) —— 而那個作者說 Windows 支援「未經測試」。實測是通的。
- **中文聽寫。** Claude Code 內建的聽寫直接拒絕 `zh-CN`，所以這裡用 ffmpeg 錄音 + whisper.cpp 本機轉寫。
- **它會操作桌面版的 UI。** 模型、權限模式、使用量、fork、archive、對話捲動 —— 全部透過無障礙樹讀取與操作，不只走 hook。

**你如果有 Stream Deck 又用 Mac，去用 agentsd。** 那個成熟得多。

## 為什麼這能成立

三個查證過的事實撐起整個設計：

1. **Claude Code 的 hook 支援 `type: "http"`** — hook 直接 POST 到我們的 daemon，不用包 shell script。
2. **`PreToolUse` hook 可以回 `permissionDecision`**（`allow` / `deny` / `ask` / `defer`）——所以實體鍵能真的決定工具跑不跑。
3. **command/http hook 預設 timeout 是 600 秒** — 阻塞著等人按實體鍵完全在預算內。

## 現況：實機驗證通過

2026-07-16 在 Windows 11 + Ajazz AKP03 (`0300:1001`) 上跑通。

| 項目 | 狀態 |
|---|---|
| AKP03 硬體辨識 | ✅ `kind: Akp03` — **Windows 這條路是通的** |
| SVG 鍵面渲染 | ✅ 驅動回報 `Setting image for button 0..8` |
| 工具名印在鍵上 | ✅ STATUS 鍵實測顯示 `Bash` |
| **實體按鍵 → allow** | ✅ **按下去，Claude Code 收到 `permissionDecision: allow`** |
| 三顆旋鈕綁定 | ✅ 全部掛上（UI 綁不上，寫 profile 可以）|
| 旋鈕 K2 切換模型 | ✅ **實機確認**：轉開選單、移動、按下選定 |
| 核心迴路合約測試 | ✅ 11 項全過（`npm test`）|
| 語音鍵（中文） | ✅ ffmpeg + whisper.cpp 全本機。實測轉出「一、二、三、三、三、四」並成功注入 |
| DISPATCH | ⚠️ 開新 headless run，非注入現有 session |
| 多 session | ❌ **一次只服務一個** — 見下方 |

實測回傳：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Approved on the AKP03 (physical key)"
  }
}
```

## 需要兩個 plugin，它們不重複

很容易誤以為裝了 `opendeck-akp03` 就夠了 —— 名字裡就有你的機型。不夠：

| Plugin | 角色 | Actions |
|---|---|---|
| `st.lynx.plugins.opendeck-akp03` | **裝置驅動** —— 讓 OpenDeck 看得到硬體 | **`[]` 空的** |
| `com.hovell.agentdeck` | **這個專案** —— APPROVE / DENY / STATUS / VOICE / SEND / 旋鈕 | 全部 |

驅動的 manifest 裡 `"Actions": []`、`"DeviceNamespace": "n3"` —— 它只負責 HID 通訊，**一顆按鍵功能都沒有**。

刪掉 `com.hovell.agentdeck` 的後果不只是鍵沒了：**OpenDeck 會把 profile 裡引用它的 9 顆鍵全部清成 `null`**，因為那些 action 已經無法解析。症狀看起來像「profile 莫名其妙被清空」，跟 plugin 完全無關。

## 安裝

### 先裝這兩個

1. **OpenDeck** —— https://github.com/nekename/OpenDeck/releases
2. **opendeck-akp03**（裝置驅動）—— https://github.com/4ndv/opendeck-akp03/releases
   解壓到 `%APPDATA%\OpenDeck\plugins\`，然後**先啟動 OpenDeck 一次**讓它建立 profiles 與 device id

### 然後跑安裝腳本

```powershell
.\install.ps1 -DetectOnly   # 先看它偵測到什麼，不會動任何東西
.\install.ps1               # 安裝
```

它會偵測：裝置 PID、空閒 port、麥克風的 dshow GUID、whisper.cpp 路徑與模型、Stream Dock 衝突 —— 然後產生 `config.json`、裝 plugin、產圖示、套用佈局、問你要不要裝 hooks。

**`config.json` 是唯一在每台機器上不同的檔案，而它的每一個值都是偵測出來的。** 換電腦就是重跑這一支。

改這個專案本身的話用 `.\install.ps1 -Dev` —— 它會建 junction 而不是複製，改程式碼重啟 OpenDeck 就生效。

> ⚠️ **官方的 Stream Dock AJAZZ 必須關掉，包含開機自動啟動。** 兩套軟體會搶同一台裝置：
> 旋鈕轉一格兩邊都反應，而它的 `switchAudio` 外掛預設就綁在旋鈕上。它裝在
> `Program Files (x86)`（不是 `Program Files`），自動啟動在 `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`。
> 移除前先備份那個登錄值。`install.ps1` 會偵測並警告，但不會替你動它。
> **代價**：官方軟體裡設好的按鍵配置就不會生效了，OpenDeck 會完全接管。

⚠️ opendeck-akp03 作者明講 Windows 端「未經測試，壞了自己修」。實測是通的，但這條風險不在我們的程式碼裡。

## 部署時踩到的坑

全都是真的踩過、修過的，寫下來省下次的命：

| 症狀 | 真正的原因 |
|---|---|
| plugin 啟動即死 | **WSL 的 `wslrelay` 佔著 8787**。預設值已改 9317 |
| 設定改了沒反應 | **PowerShell 5.1 `-Encoding utf8` 會加 BOM**，`JSON.parse` 直接爆。用 Node 寫檔 |
| 重啟後 EADDRINUSE | OpenDeck 被殺時**不回收子程序**，孤兒抓著 port。已修：斷線即自殺 |
| profile 寫了被清空 | `ActionContext` 序列化成 **`"Keypad.0.0"`**（三段），不是 `shared.rs` on main 寫的五段 |
| 鍵面空白 | `setImage` 的 SVG **必須 base64**。用 `charset=utf8,`+`encodeURIComponent` 會被原樣存成不合法 XML |
| 旋鈕綁不上 | OpenDeck UI 不給綁 encoder — **直接寫 profile 繞過** |
| 旋鈕行為衝突、轉一格兩邊都反應 | **官方 Stream Dock AJAZZ 在背景執行，跟 OpenDeck 搶同一台裝置**。它的 `switchAudio` 外掛預設把旋鈕綁音量。裝在 `Program Files (x86)`（不是 `Program Files`），且註冊在 `HKCU\...\Run` 開機自動啟動 |
| **所有 action 圖示變破圖** | **路徑裡有非 ASCII 字元**（例如這個專案原本就放在 `AKP03專案` 底下）。OpenDeck 的 webview 載不動 —— 但檔案是在的，Node 讀得到。咬了兩次：`-Dev` 的 junction 指向中文路徑、以及 profile 寫進了原始碼路徑而非安裝路徑。**plugin 放 `%APPDATA%` 底下**（那是純 ASCII）|
| 文件說 `Ctrl+Shift+I` 開 model 選單 | **實際開了無痕對話，還把視窗帶離 Code 分頁**。桌面版的快捷鍵只在 Code 分頁成立，焦點不對時同一個組合鍵是別的功能。所以選單一律走 UIA，不送快捷鍵 |

## 先跑跑看，不用硬體

```bash
npm run console
```

你的鍵盤就是 AKP03（`a` 批准 / `d` 拒絕 / `i` 中斷）。把 hooks 設好，然後在另一個終端機叫 Claude Code 跑個 `Bash`——請求會出現在 console。**這條通道能通，硬體那段才有意義。**

## 兩個必須守住的約束

**1. Timeout 有方向性。**

```
plugin config.json     approvalTimeoutMs: 90000  ← 必須比較小
.claude/settings.json  PreToolUse timeout: 120   ← 必須比較大
```

Plugin 一定要先放棄。它先放棄 → 回 `defer` → 你拿到正常的螢幕提示。Claude Code 先放棄 → 你拿到 hook 錯誤。

**2. 所有失敗路徑都回 `defer`。**

裝置沒插、plugin 崩了、body 壞了、逾時、被新的呼叫取代 —— 全部回 `defer`，交還給 Claude Code 原本的權限流程。這有測試守著。

> 一個沉默卡住 10 分鐘的 agent，比一個彈出螢幕提示的 agent 糟糕得多。

## 這台裝置一次只服務一個 session

狀態機只有**一個** pending 欄位。第二個 session 送來批准請求時，第一個會被擠成 `defer`。

這是刻意的 —— 不這樣做，舊的請求會永遠掛著。但代價很實際：**全域掛 hook 又同時開很多 session，它們會互相踩，結果是什麼都過不了**，而且畫面上完全看不出原因。

實務建議：**把 hooks 放在你真正需要它的那個專案的 `.claude/settings.json`**，而不是 `~/.claude/settings.json`。想全域也行，但要知道這個限制。

（DISPATCH 派出去的 run 帶 `--settings '{"hooks":{}}'`，所以不算在內 —— 否則它會卡在等一個沒人看得到的批准。）

## 語音鍵

**你不需要選。** Plugin 首次啟動時自己決定，並把答案寫進 `config.json`：

```
你的語言 ── Claude Code 聽得懂嗎？ ──會──> "gui"（什麼都不用裝）
  來自它的        │
`language` 設定，  不會
沒設就用系統語系    │
                   v
          ffmpeg + whisper.cpp 在嗎？ ──在──> "local"
                   │
                   不在 ──> "gui"，並在 log 說明缺什麼
```

語言來自 Claude Code 的 `language` 設定，沒設就用**系統語系** —— 這一步比看起來重要：**這個專案的作者從來沒設過 `language`，而他正是 `local` 存在的理由**。只讀那個設定的話，最需要中文的那個人會被靜默地丟去英文路徑。

不管它怎麼決定，`%LOCALAPPDATA%\agent-deck\agent-deck.log` 都會寫明**選了什麼、為什麼**。要覆寫就改 `config.json` 的 `voice.mode`。

### `local` 模式（唯一聽得懂中文的）

**Claude Code 的聽寫不支援中文。** 不是設定問題，是功能沒有：

> `/voice` 會顯示 **"zh-CN" is not a supported dictation language; using English.**

官方支援清單 20 種語言（英日韓法德…）**沒有中文**，已有 [feature request #42920](https://github.com/anthropics/claude-code/issues/42920) 開著。（諷刺的是 Claude 的一般語音模式 2026/6 就支援 18 語含中文了，就是 Claude Code 沒有。）

所以中文只能自己來。全程在本機，**音訊不離開你的電腦**：

```
按 VOICE → ffmpeg 錄音 → whisper.cpp 轉中文 → UIA 聚焦輸入框 → 貼上
```

需要 **ffmpeg** 和一個 **whisper.cpp build + 模型**。實測環境：`large-v3-turbo`（1.6GB），11 秒音檔約 3.7 秒轉完（含 1.4 秒載入模型）。

三個實作上的坑，都是踩過才知道的：

| 坑 | 解法 |
|---|---|
| 殺掉 ffmpeg 會讓 WAV 的表頭 size 欄位沒寫完，whisper 讀到空檔 | **往 stdin 寫 `q`** 讓它自己收尾。所以 ffmpeg 由 Node 直接 spawn（Node 才握著那個 pipe） |
| 麥克風的友善名稱是中文，穿過 shell 會被搞爛 | 用 `@device_cm_` **GUID**，純 ASCII |
| 輸入框是 contenteditable，UIA 只給 `TextPattern`（唯讀），**沒有 ValuePattern** | 只能剪貼簿 + `Ctrl+V`。用 UIA `SetFocus()` 先聚焦，貼完**還原剪貼簿**（純文字；圖片/檔案不保留）|

`autoSubmit` 預設 `false` —— 轉寫結果先留在輸入框給你看過再送。STT 對專有名詞和程式術語常出錯，直接送出會讓你花更多時間收拾。

鍵有三個狀態，**全部是真的，沒有一個是猜的**：`VOICE` → `REC`（紅）→ `HEARING`（whisper 工作中）。中間那個 `HEARING` 是必要的 —— whisper 要跑好幾秒，鍵如果在那段時間變暗，會讓人以為按壞了。

### `gui` 模式（Claude Code 桌面版內建聽寫 —— 多數人的情況）

**桌面版沒有麥克風的鍵盤快捷鍵。** `Ctrl+/` 的完整清單裡沒有 voice/mic 任何一項，文件也零次提及，而 CLI 的 `voice:pushToTalk` 綁定明確不適用於桌面版（"terminal-based interactive mode shortcuts do not apply in Desktop"）。所以沒有按鍵可以送。

改用 **Windows UI Automation** 直接操作那顆按鈕（`lib/mic.ps1`）—— 用**無障礙名稱**定位，不是座標。視窗移動、DPI 改變、版面調整都不會壞。

零設定，但**不是預設值** —— 預設是 `local`（中文）。要用這個把 `config.json` 改成 `"voice": { "mode": "gui" }`。

實測時挖出的三個行為（Claude v1.21459.3）：

| 行為 | 影響 |
|---|---|
| 按鈕雖標示 "Press and hold to record"，但暴露的是 **TogglePattern** | 切一次開始、切一次停止，**不用按住** |
| 按鈕**會隨狀態改名**：`Press and hold to record` ↔ `Stop dictation` | 只找一個名字，錄音一開始就失聯 |
| 改名後**舊的元素參照會靜默失效** —— `Toggle()` 不報錯也不生效 | 每次都必須重新用名字找 |

還有一個 Chromium 的坑：它**只有在 UIA client 來問的時候才建立無障礙樹**，第一次查詢一定是空的（那次查詢本身就是喚醒動作）。`mic.ps1` 會重試四次。

**這是整組鍵裡唯一有真實回饋的一顆**：`TogglePattern` 會回報 `ToggleState`，所以 REC 是真的讀數。plugin 在錄音時每 2 秒輪詢，抓 Claude 因靜音自己停止的時刻。

### `cli` 模式（終端機版）

```
/voice tap                                   # 必須 tap，hold 送不出去
"voice": { "mode": "cli", "key": "{SPACE}" } # 對上 voice:pushToTalk 綁定
```

`key` 是 SendKeys 語法。改綁 `ctrl+shift+v` 就填 `"^+v"`：

```json
{ "bindings": [ { "context": "Chat", "bindings": { "ctrl+shift+v": "voice:pushToTalk" } } ] }
```

### `gui` / `cli` 共同前提

- **需要 Claude.ai 帳號** —— API key / Bedrock / Vertex 沒有這功能
- **英文限定**。文件裡「Chinese transcripts count individual words」那句講的是**沒有空格的語言怎麼算字數**（自動送出的門檻），不是說聽得懂中文。我被這句誤導過，寫在這裡免得下次再上當。

## 結構

```
install.ps1            全自動偵測安裝 —— 換電腦跑這一支
plugin/com.hovell.agentdeck.sdPlugin/
  manifest.json        12 個 action（11 keypad + 1 encoder）
  plugin.js            接線：事件 → 狀態 → 重繪
  lib/state.js         狀態機。不認識 OpenDeck 也不認識 HTTP
  lib/hookserver.js    Claude Code hook 端點。defer 邏輯在這
  lib/opendeck.js      Elgato protocol WS client
  lib/icons.js         鍵面 SVG。狀態改變 = 換一個字串
  lib/keycaps.js       28 個可替換的 keycap 圖庫（picker 也 import 這支）
  lib/host.ps1         常駐 UIA host —— 一個程序處理所有 UI 操作
  lib/{mic,menu,paste,submit}.ps1   單次性的 UIA 動作
scripts/
  gen-icons.mjs        自幹的 PNG 編碼器 + 距離場光柵化（零依賴）
  apply-profile.mjs    把 LAYOUT.md 寫進 OpenDeck profile，含旋鈕
  dev-console.mjs      無硬體測試通道
  detect-device.ps1    PID 偵測 + 對照支援清單
  probe-controls.ps1   探測 Claude Code 的 UI 控制項（找不到東西時用）
tests/loop.test.mjs    合約測試，重點在失敗路徑
```

零 npm 依賴。Node 22+ 內建 `WebSocket`，`zlib` 產 PNG，`http` 收 hook。

## 佈局

見 [docs/LAYOUT.md](docs/LAYOUT.md) — 以及為什麼 `✓` 和 `✗` 中間隔了一整顆鍵。

## 授權

MIT
