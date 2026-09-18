#!/usr/bin/env bash
# bb — the whole loop, as recorded for docs/demo/.
#
# Regenerate both the cast and the GIF:
#   asciinema rec --command docs/demo/demo.sh --window-size 132x21 \
#       --overwrite docs/demo/demo.cast
#   agg --font-size 18 --theme dracula docs/demo/demo.cast docs/demo/bb-demo.gif
#
# 132 columns because the widest line bb prints here — the findings table — is
# 128. Narrower and it wraps mid-word.
cd "$(git rev-parse --show-toplevel)" || exit 1
export PATH="$PWD/bin:$PATH"

type_out() {
  printf '\033[32m$\033[0m '
  local s="$1" i
  for (( i=0; i<${#s}; i++ )); do
    printf '%s' "${s:i:1}"
    sleep 0.032
  done
  printf '\n'
  sleep 0.6
}

# beat <shown> <executed> <dwell>
beat() {
  type_out "$1"
  eval "$2"
  echo
  sleep "$3"
}

clear
sleep 1.2

beat "bb pinpoint 'the quiet-degrade and silent-fallback detectors share a 50-line window scan'" \
     "bb pinpoint 'the quiet-degrade and silent-fallback detectors share a 50-line window scan'" \
     4.5

beat "bb context src/detectors/quiet-degrade.js src/detectors/silent-fallback.js" \
     "bb context src/detectors/quiet-degrade.js src/detectors/silent-fallback.js" \
     4.5

clear
sleep 0.8

BRIEF=$(ls -t .bundlebox/out/pinpoint/*.md | head -1)
beat "grep '^## ' \$BRIEF" \
     "grep -E '^## ' \"$BRIEF\"" \
     5.5

clear
sleep 0.8

beat "bb findings --detector duplicate-blocks --limit 4" \
     "bb findings --detector duplicate-blocks --limit 4" \
     5.5
