#!/usr/bin/env bash
# @lathe applied
# @lathe-id 83948a39b648
# @lathe-applied 2026-09-20T11:01:24.089Z
# @tag lathe
# @title tokens ledger → monitor status → commandcenter build
# @needs bb
# @turns 3
# @cost 0
# @safe false
#
# PROPOSED by LATHE-1 from 99 occurrence(s) across 99 session(s)
# lift 24.897 over the base rate of `commandcenter build`; confidence 0.6346 that the run continues this way once it has started.
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

bb tokens ledger --apply
bb monitor status --apply
bb commandcenter build --apply
