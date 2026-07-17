#!/usr/bin/env bash
# Linux/macOS launcher. Same contract as run.cmd.
exec node "$(dirname "$0")/plugin.js" "$@"
