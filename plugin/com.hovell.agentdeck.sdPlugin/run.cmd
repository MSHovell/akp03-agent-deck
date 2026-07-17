@echo off
rem OpenDeck launches this with -port N -pluginUUID X -registerEvent E -info {...}
rem and expects the process to stay alive for the life of the plugin.
rem
rem Node is checked first because this plugin ships through a store: without it,
rem OpenDeck reports only that the plugin died, with no hint as to why. Unlike the
rem device driver next to it — a compiled binary with no runtime to install —
rem this one needs Node 22+ (it uses the built-in global WebSocket, which is what
rem keeps it at zero npm dependencies).

where node >nul 2>&1
if errorlevel 1 (
  if not exist "%LOCALAPPDATA%\agent-deck" mkdir "%LOCALAPPDATA%\agent-deck"
  >>"%LOCALAPPDATA%\agent-deck\agent-deck.log" echo FATAL: Node.js was not found on PATH.
  >>"%LOCALAPPDATA%\agent-deck\agent-deck.log" echo   AKP03 Agent Deck needs Node.js 22 or newer: https://nodejs.org
  >>"%LOCALAPPDATA%\agent-deck\agent-deck.log" echo   Install it, then restart OpenDeck.
  exit /b 1
)

node "%~dp0plugin.js" %*
