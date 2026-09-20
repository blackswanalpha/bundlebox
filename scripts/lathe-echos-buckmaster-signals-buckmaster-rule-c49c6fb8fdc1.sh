#!/usr/bin/env bash
# @lathe applied
# @lathe-id c49c6fb8fdc1
# @lathe-applied 2026-09-20T11:01:24.054Z
# @tag lathe
# @title echos → buckmaster signals → buckmaster rules → buckmaster memory → lathe learn → lathe build → tokens ledger → monitor status
# @needs bb
# @turns 8
# @cost 0
# @safe false
#
# PROPOSED by LATHE-1 from 141 occurrence(s) across 141 session(s)
# lift 24.722 over the base rate of `monitor status`; confidence 0.993 that the run continues this way once it has started.
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

bb echos --apply
bb buckmaster signals --apply
bb buckmaster rules --apply
bb buckmaster memory --apply
bb lathe learn --apply
bb lathe build --apply
bb tokens ledger --apply
bb monitor status --apply
