#!/usr/bin/env bash
# @lathe applied
# @lathe-id 0e37435e9c04
# @lathe-applied 2026-09-20T11:01:23.981Z
# @tag lathe
# @title buckmaster recommend → tokens ledger → session list → buckmaster episodes → bench init → bench run
# @needs bb
# @turns 6
# @cost 0
# @safe false
#
# PROPOSED by LATHE-1 from 153 occurrence(s) across 153 session(s)
# lift 25.386 over the base rate of `bench run`; confidence 1 that the run continues this way once it has started.
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

bb buckmaster recommend --apply
bb tokens ledger --apply
bb session list --apply
bb buckmaster episodes --apply
bb bench init --apply
bb bench run --apply
