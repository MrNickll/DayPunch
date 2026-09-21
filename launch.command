#!/usr/bin/env bash
# DayPunch - Copyright 2026 Nicolas Lapointe Lafortune. Licensed under the Apache License 2.0.
#
# macOS launcher: Finder opens .command files in Terminal on double-click.
# Finder starts them from the home folder, so move next to the app first.
cd "$(dirname "$0")" && exec ./launch.sh
