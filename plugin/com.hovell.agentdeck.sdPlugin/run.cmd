@echo off
rem OpenDeck launches this with -port N -pluginUUID X -registerEvent E -info {...}
rem and expects the process to stay alive for the life of the plugin.
node "%~dp0plugin.js" %*
