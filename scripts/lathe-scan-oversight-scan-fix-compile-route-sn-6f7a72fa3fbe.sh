#!/usr/bin/env bash
# @lathe applied
# @lathe-id 6f7a72fa3fbe
# @lathe-applied 2026-09-20T11:01:24.215Z
# @tag lathe
# @title scan → oversight scan → fix → compile → route → snapgen build → arc build → oversight guidelines → pinpoint gaps → buckmaster recommend → tokens ledger → session list → buckmaster episodes → bench init → bench run → tokens calibrate → triage calibrate → echos → buckmaster signals → buckmaster rules → buckmaster memory
# @needs bb
# @turns 21
# @cost 0
# @safe false
#
# PROPOSED by LATHE-1 from 55 occurrence(s) across 55 session(s)
# lift 8.451 over the base rate of `buckmaster memory`; confidence 0.3416 that the run continues this way once it has started.
#
# Not run by anything until a person sets @safe true: applying wrote the file,
# The model knows what ran and in what order. Whether running it unattended
# is safe is not in the data.
#
# Applied by `bb lathe apply`, not written by a person. It is @safe false, so
# `bb scripts run` will not run it unattended until somebody sets that.
# `bb lathe reach` re-judges it: if this habit stops recurring it is tombstoned.
# Remove the `@lathe applied` line above to adopt it permanently and stop both.
set -euo pipefail

bb scan --apply
bb oversight scan --apply
bb fix --apply
bb compile --apply
bb route --apply
bb snapgen build --apply
bb arc build --apply
bb oversight guidelines --apply
bb pinpoint gaps --apply
bb buckmaster recommend --apply
bb tokens ledger --apply
bb session list --apply
bb buckmaster episodes --apply
bb bench init --apply
bb bench run --apply
bb tokens calibrate --apply
bb triage calibrate --apply
bb echos --apply
bb buckmaster signals --apply
bb buckmaster rules --apply
bb buckmaster memory --apply
