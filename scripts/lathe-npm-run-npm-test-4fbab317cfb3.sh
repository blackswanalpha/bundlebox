#!/usr/bin/env bash
# @lathe applied
# @lathe-id 4fbab317cfb3
# @lathe-applied 2026-09-20T11:01:24.243Z
# @tag lathe
# @title npm run → npm test
# @needs npm
# @turns 2
# @cost 0
# @safe false
#
# PROPOSED by LATHE-1 from 43 occurrence(s) across 14 session(s)
# lift 47.806 over the base rate of `npm test`; confidence 1 that the run continues this way once it has started.
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

npm run
npm test
