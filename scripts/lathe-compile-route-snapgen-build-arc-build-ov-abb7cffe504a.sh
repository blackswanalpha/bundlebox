#!/usr/bin/env bash
# @lathe applied
# @lathe-id abb7cffe504a
# @lathe-applied 2026-09-20T11:01:24.023Z
# @tag lathe
# @title compile → route → snapgen build → arc build → oversight guidelines → pinpoint gaps → buckmaster recommend → tokens ledger → session list → buckmaster episodes → bench init → bench run → tokens calibrate
# @needs bb
# @turns 13
# @cost 0
# @safe false
#
# PROPOSED by LATHE-1 from 142 occurrence(s) across 142 session(s)
# lift 24.124 over the base rate of `tokens calibrate`; confidence 0.882 that the run continues this way once it has started.
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
