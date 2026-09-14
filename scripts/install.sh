#!/usr/bin/env sh
# bundlebox installer — curl -fsSL https://raw.githubusercontent.com/blackswanalpha/bundlebox/main/scripts/install.sh | sh
#
# Installs (or updates) the global `bb` command. Needs Node >= 20 and npm.
# Never sudo on its own: if the global prefix is not writable it says so and
# prints the two commands that fix it.
set -eu
PKG="${BB_PACKAGE:-bundlebox}"
VERSION="${BB_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
die() { say "install: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node not found. Install Node.js >= 20 from https://nodejs.org or via your package manager, then re-run."
command -v npm  >/dev/null 2>&1 || die "npm not found alongside node."
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 20 ] || die "node $(node -v) is too old; bundlebox needs >= 20."

prefix=$(npm prefix -g 2>/dev/null || echo "")
if [ -n "$prefix" ] && [ ! -w "$prefix/lib/node_modules" ] 2>/dev/null && [ ! -w "$prefix" ]; then
  say "npm's global prefix ($prefix) is not writable by $(id -un)."
  say "Fix once, without sudo:"
  say "  mkdir -p \"\$HOME/.npm-global\" && npm config set prefix \"\$HOME/.npm-global\""
  say "  echo 'export PATH=\"\$HOME/.npm-global/bin:\$PATH\"' >> ~/.profile && . ~/.profile"
  die "then re-run this installer."
fi

if command -v bb >/dev/null 2>&1 && bb --version >/dev/null 2>&1; then
  cur=$(bb --version 2>/dev/null | head -1)
  say "bundlebox $cur is installed; updating to $VERSION"
fi
npm install -g "$PKG@$VERSION" --no-fund --no-audit --loglevel=error
say ""
say "installed: $(bb --version 2>/dev/null || echo bundlebox)"
say "next:      cd <your repo> && bb init && bb doctor"
