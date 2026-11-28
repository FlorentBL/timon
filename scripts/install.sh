#!/bin/sh
# Timon installer for Linux and macOS.
#
#   curl -fsSL https://timon-ai.com/install.sh | sh
#   curl -fsSL https://timon-ai.com/install.sh | sh -s -- --dry-run
#
# What it does, in order:
#   1. reads the signed installers' manifest of timon-ai.com and checks its
#      signatures: P-256, always, with any openssl (LibreSSL on macOS
#      included), and Ed25519 too with OpenSSL 3; a manifest that cannot be
#      checked stops here;
#   2. picks the package of this machine: the deb on Debian and Ubuntu, the
#      AppImage on other Linux distributions, the pkg on macOS;
#   3. downloads it and compares its size and SHA-256 with the manifest
#      BEFORE installing anything;
#   4. installs it (sudo is asked for the deb and the pkg only);
#   5. on a machine with a screen, opens Timon; on a server (no display),
#      installs the background service, keeps it running after logout
#      (lingering), checks that the built-in browser answers, and prints the
#      next step. A server with no font gets the
#      fonts the built-in browser needs in the same apt-get install.
#
# The whole script is one function called on its last line: a download cut
# halfway runs nothing.
#
# Source of truth: scripts/install.sh in the Timon repository, published as
# is at https://timon-ai.com/install.sh (docs/RELEASE-RC.md).

set -eu

# The installers' manifest: the release manifest plus a P-256 signature
# (scripts/release-manifest.mjs). Trust anchor: no fallback to the release
# manifest the daemons read, which has no P-256 signature, so a network
# attacker cannot downgrade the check by serving that file instead.
INSTALL_MANIFEST_URL='https://timon-ai.com/.well-known/timon-releases-install.json'
SIGNATURE_DOMAIN='timon-releases-v1'
# The release key of docs/internal/scripts (keyId release-4253f18d5854243a),
# the one orchestrator/src/plugins-bundled/updates/keyring.ts pins.
RELEASE_KEY_ID='release-4253f18d5854243a'
RELEASE_PUBLIC_KEY='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA/exKqVlkcdYZ9xhlreEUFmnjlu/7VfHpfPXfdbIyeAk=
-----END PUBLIC KEY-----'
# The installers' P-256 key (docs/internal/scripts/release-p256-keygen.mjs
# --pin writes both lines). Required: the installer refuses to run without it.
RELEASE_P256_KEY_ID='release-701bbfb6d1c1eed1'
RELEASE_P256_PUBLIC_KEY='-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyUUvXZE0kGYqgsXTRslQyKnF1Y5M
K2wjSflgy5lGkUbEUzJK9zRP1Iv88aOPoObrkPVSyJWVW4fGJE2Q7N5C6w==
-----END PUBLIC KEY-----'
DOCS_URL='https://docs.timon-ai.com/installation/overview'
# A server image often ships no font: the built-in browser then renders pages
# with no text at all. The Chinese, Japanese and Korean set is heavy:
# `timon doctor` names it instead.
SERVER_FONTS='fonts-liberation fonts-noto-core fonts-noto-color-emoji'
# How long the built-in browser may take to answer after the service starts.
BROWSER_WAIT=60

say() { printf '%s\n' "$*"; }
warn() { printf 'timon-install: %s\n' "$*" >&2; }
die() { printf 'timon-install: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Timon installer for Linux and macOS.

  curl -fsSL https://timon-ai.com/install.sh | sh
  curl -fsSL https://timon-ai.com/install.sh | sh -s -- [options]

Options:
  --dry-run          check the manifest and print what would be installed; change nothing
  --download-only    download and verify the package, print its path, install nothing
  --channel NAME     stable or beta (default: stable when published, else beta)
  --format NAME      deb, appimage or pkg (default: the one for this machine)
  --server           act as on a server: install the background service, open no window
  --no-service       on a server, do not install the background service
  --no-launch        do not open Timon once installed
  -h, --help         this help

Documentation: https://docs.timon-ai.com/installation/overview
EOF
}

has() { command -v "$1" >/dev/null 2>&1; }

# Test hooks: a test serves its own manifest, signed with its own key, from
# file:// URLs, and names the system to install for. Read only when
# TIMON_INSTALL_TESTING=1.
apply_test_hooks() {
  if [ "${TIMON_INSTALL_TESTING:-}" = 1 ]; then
    INSTALL_MANIFEST_URL="${TIMON_INSTALL_MANIFEST_URL:-$INSTALL_MANIFEST_URL}"
    if [ -n "${TIMON_INSTALL_PUBLIC_KEY_FILE:-}" ]; then
      RELEASE_PUBLIC_KEY=$(cat "$TIMON_INSTALL_PUBLIC_KEY_FILE")
      RELEASE_KEY_ID="${TIMON_INSTALL_KEY_ID:-$RELEASE_KEY_ID}"
    fi
    if [ -n "${TIMON_INSTALL_P256_KEY_FILE:-}" ]; then
      RELEASE_P256_PUBLIC_KEY=$(cat "$TIMON_INSTALL_P256_KEY_FILE")
      RELEASE_P256_KEY_ID="${TIMON_INSTALL_P256_KEY_ID:-}"
    fi
    TIMON_BIN_OVERRIDE="${TIMON_INSTALL_TIMON_BIN:-}"
    FONT_DIRS_OVERRIDE="${TIMON_INSTALL_FONT_DIRS:-}"
    TESTING=1
  else
    TESTING=0
  fi
}

# fetch URL FILE [progress]
fetch() {
  if [ "$TESTING" != 1 ]; then
    case "$1" in
      https://*) ;;
      *) die "refusing a non-HTTPS address: $1" ;;
    esac
  fi
  if has curl; then
    if [ "$TESTING" = 1 ]; then
      curl -fsSL -o "$2" "$1"
    elif [ "${3:-}" = progress ] && [ -t 2 ]; then
      curl -fL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --progress-bar -o "$2" "$1"
    else
      curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 -o "$2" "$1"
    fi
  elif has wget; then
    wget -q -O "$2" "$1"
  else
    die 'neither curl nor wget is installed'
  fi
}

base64_decode() {
  if has openssl; then
    openssl base64 -d -A -in "$1" -out "$2"
  elif base64 -d <"$1" >"$2" 2>/dev/null; then
    :
  else
    base64 -D <"$1" >"$2"
  fi
}

sha256_of() {
  if has sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif has shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif has openssl; then
    openssl dgst -sha256 -r "$1" | awk '{print $1}'
  else
    die 'no SHA-256 tool found (sha256sum, shasum or openssl)'
  fi
}

file_size() { wc -c <"$1" | tr -d ' '; }

# A string field of the manifest envelope, which may be pretty-printed.
# The nested p256 object is cut first: its keyId and sig are not the
# envelope's.
envelope_field() {
  tr -d '\n\r' <"$1" | sed 's/"p256"[[:space:]]*:[[:space:]]*{[^}]*}//' |
    sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

# A string field of the envelope's p256 object; empty when there is none.
p256_field() {
  tr -d '\n\r' <"$1" | sed -n 's/.*"p256"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p' |
    sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

has_openssl3() {
  has openssl && openssl version 2>/dev/null | grep -Eq '^OpenSSL ([3-9]|[1-9][0-9])\.'
}

# The P-256 signature is mandatory: any openssl verifies it, LibreSSL (the
# macOS one) and OpenSSL 1.1 included. Ed25519 needs OpenSSL 3 and is checked
# on top when it is there. A signature that is missing or fails stops here.
verify_manifest() {
  envelope="$1"
  key_id=$(envelope_field "$envelope" keyId)
  envelope_field "$envelope" payload >"$WORK/payload.b64"
  envelope_field "$envelope" sig >"$WORK/sig.b64"
  [ -s "$WORK/payload.b64" ] && [ -s "$WORK/sig.b64" ] || die 'the release manifest is malformed'
  base64_decode "$WORK/payload.b64" "$WORK/payload.json" || die 'the release manifest is malformed'
  base64_decode "$WORK/sig.b64" "$WORK/sig.bin" || die 'the release manifest is malformed'
  [ "$key_id" = "$RELEASE_KEY_ID" ] || die "the release manifest is signed with an unknown key ($key_id)"
  { printf '%s\000' "$SIGNATURE_DOMAIN"; cat "$WORK/payload.json"; } >"$WORK/signed.bin"

  [ -n "$RELEASE_P256_PUBLIC_KEY" ] || die 'this installer pins no P-256 key: nothing was installed'
  p256_key_id=$(p256_field "$envelope" keyId)
  p256_field "$envelope" sig >"$WORK/p256.b64"
  [ -s "$WORK/p256.b64" ] || die 'the release manifest has no P-256 signature: nothing was installed. Report it at https://timon-ai.com'
  has openssl || die 'checking the release manifest signature needs openssl: install it (for example sudo apt-get install openssl), then run this command again'
  [ "$p256_key_id" = "$RELEASE_P256_KEY_ID" ] || die "the release manifest is signed with an unknown P-256 key ($p256_key_id)"
  base64_decode "$WORK/p256.b64" "$WORK/p256.der" || die 'the release manifest is malformed'
  printf '%s\n' "$RELEASE_P256_PUBLIC_KEY" >"$WORK/p256-key.pem"
  openssl dgst -sha256 -verify "$WORK/p256-key.pem" -signature "$WORK/p256.der" "$WORK/signed.bin" >/dev/null 2>&1 ||
    die 'the release manifest signature is INVALID: nothing was installed. Report it at https://timon-ai.com'
  SIGNATURE=verified

  if has_openssl3; then
    printf '%s\n' "$RELEASE_PUBLIC_KEY" >"$WORK/release-key.pem"
    openssl pkeyutl -verify -pubin -inkey "$WORK/release-key.pem" -rawin \
      -in "$WORK/signed.bin" -sigfile "$WORK/sig.bin" >/dev/null 2>&1 ||
      die 'the release manifest signature is INVALID: nothing was installed. Report it at https://timon-ai.com'
  fi
}

# Reads the payload (one JSON line, written by scripts/release-manifest.mjs)
# without jq or python. A quote inside a JSON string is always escaped, so the
# unescaped markers below only ever match the structure, never the notes.
# Prints: version, expiresAt, then name, url, size and sha256 of the artifact.
read_artifact() {
  awk -v ch="$2" -v key="$3" '
    function str(obj, f,   m) {
      if (!match(obj, "\"" f "\":\"[^\"]*\"")) return ""
      m = substr(obj, RSTART + length(f) + 4, RLENGTH - length(f) - 5)
      return m
    }
    function num(obj, f,   m) {
      if (!match(obj, "\"" f "\":[0-9]+")) return ""
      return substr(obj, RSTART + length(f) + 3, RLENGTH - length(f) - 3)
    }
    { text = text $0 }
    END {
      c = index(text, "\"channels\":{")
      if (!c) exit 2
      rest = substr(text, c + 12)
      s = index(rest, "\"" ch "\":{")
      if (!s) exit 3
      sec = substr(rest, s + length(ch) + 4)
      other = (ch == "beta") ? "stable" : "beta"
      o = index(sec, "\"" other "\":{")
      if (o) sec = substr(sec, 1, o - 1)
      a = index(sec, "\"" key "\":{")
      if (!a) exit 4
      obj = substr(sec, a + length(key) + 4)
      e = index(obj, "}")
      if (e) obj = substr(obj, 1, e - 1)
      print str(sec, "version")
      print str(text, "expiresAt")
      print str(obj, "name")
      print str(obj, "url")
      print num(obj, "size")
      print str(obj, "sha256")
    }
  ' "$1"
}

detect_platform() {
  uname_s=$(uname -s)
  uname_m=$(uname -m)
  if [ "$TESTING" = 1 ]; then
    uname_s="${TIMON_INSTALL_UNAME_S:-$uname_s}"
    uname_m="${TIMON_INSTALL_UNAME_M:-$uname_m}"
  fi
  case "$uname_s" in
    Linux) OS=linux ;;
    Darwin) OS=mac ;;
    *) die "this installer is for Linux and macOS; on Windows run: irm https://timon-ai.com/install.ps1 | iex" ;;
  esac
  case "$uname_m" in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) die "unsupported processor: $uname_m" ;;
  esac
  if [ -z "$FORMAT" ]; then
    if [ "$OS" = mac ]; then
      FORMAT=pkg
    elif has dpkg && has apt-get; then
      FORMAT=deb
    else
      FORMAT=appimage
    fi
  fi
  case "$OS:$FORMAT" in
    linux:deb | linux:appimage | mac:pkg) ;;
    *) die "the $FORMAT package does not exist for this system" ;;
  esac
  if [ "$OS" = linux ] && [ "$SERVER" = auto ]; then
    if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then SERVER=yes; else SERVER=no; fi
  elif [ "$SERVER" = auto ]; then
    SERVER=no
  fi
}

as_root() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  elif has sudo; then
    sudo "$@"
  else
    die "this step needs administrator rights and sudo is missing: $*"
  fi
}

# True when the deb needs root and this account cannot get it: not root, and
# no sudo at all. A sudo that asks for a password is left to ask: only its
# absence is known for sure before the download.
lacks_admin() {
  [ "$FORMAT" = deb ] && [ "$(id -u)" != 0 ] && ! has sudo
}

# Root installs the package, then the owner installs the service from its own
# account: the same split as a run as root (after_install).
refuse_without_admin() {
  warn 'installing the deb package needs administrator rights, and this account has no sudo.'
  {
    say 'Become root, then run the same command again:'
    say '  su -'
    say "  $RERUN"
    if [ "$SERVER" = yes ] && [ "$NO_SERVICE" = 0 ]; then
      say 'Then, back on this account (not root), install the background service:'
      say '  timon service install'
      say '  timon service session-mode always'
    fi
  } >&2
  exit 1
}

print_plan() {
  size_mb=$(awk -v s="$A_SIZE" 'BEGIN { printf "%.0f", s / 1048576 }')
  say "Timon $VERSION ($CHANNEL channel) for $OS-$ARCH"
  say "  package:   $A_NAME ($size_mb MB)"
  say "  from:      $A_URL"
  say "  sha256:    $A_SHA"
  say "  signature: $SIGNATURE"
  case "$FORMAT" in
    deb)
      if lacks_admin; then
        say "  install:   apt-get install (needs root, and this account has no sudo)"
      else
        say "  install:   apt-get install (sudo)"
      fi
      ;;
    appimage) say "  install:   $APPIMAGE_PATH (no sudo; no timon command)" ;;
    pkg) say "  install:   installer -pkg -target / (sudo)" ;;
  esac
  if [ -n "$FONT_PACKAGES" ]; then
    say "  fonts:     $FONT_PACKAGES (this server has none; the built-in browser needs them)"
  fi
  if [ "$SERVER" = yes ] && [ "$NO_SERVICE" = 0 ] && [ "$(id -u)" = 0 ]; then
    say "  then:      how to install the background service from the account that owns Timon (never root)"
  elif [ "$SERVER" = yes ] && [ "$NO_SERVICE" = 0 ]; then
    say "  then:      timon service install (background service and built-in browser)"
    say "  and:       timon service session-mode always (keeps running after you log out)"
  elif [ "$NO_LAUNCH" = 0 ]; then
    say "  then:      open Timon"
  fi
}

install_package() {
  case "$FORMAT" in
    deb)
      # apt reads the file as its _apt user: a private temporary folder
      # earns a warning, so the folder and the file are made readable.
      chmod 755 "$WORK"
      chmod 644 "$PACKAGE"
      # FONT_PACKAGES is a list of package names: split on purpose.
      # shellcheck disable=SC2086
      as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "$PACKAGE" $FONT_PACKAGES </dev/null
      ;;
    appimage)
      mkdir -p "$(dirname "$APPIMAGE_PATH")"
      cp "$PACKAGE" "$APPIMAGE_PATH.part"
      chmod 755 "$APPIMAGE_PATH.part"
      mv -f "$APPIMAGE_PATH.part" "$APPIMAGE_PATH"
      ;;
    pkg)
      as_root installer -pkg "$PACKAGE" -target / </dev/null
      ;;
  esac
}

# True when a font file is installed where fontconfig looks for one.
has_fonts() {
  if [ "$TESTING" = 1 ] && [ -n "$FONT_DIRS_OVERRIDE" ]; then
    dirs=$(printf '%s' "$FONT_DIRS_OVERRIDE" | tr ':' ' ')
  else
    dirs="/usr/share/fonts /usr/local/share/fonts ${XDG_DATA_HOME:-$HOME/.local/share}/fonts $HOME/.fonts"
  fi
  for dir in $dirs; do
    [ -d "$dir" ] || continue
    found=$(find "$dir" -type f \( -name '*.ttf' -o -name '*.otf' -o -name '*.ttc' -o -name '*.pfb' -o -name '*.woff' -o -name '*.woff2' \) 2>/dev/null | head -n 1)
    [ -n "$found" ] && return 0
  done
  return 1
}

# The fonts to add to the deb's apt-get install: on a server with none, the
# ones this distribution knows (an older release lacks fonts-noto-core, and an
# unknown name would fail the whole install).
pick_fonts() {
  FONT_PACKAGES=''
  [ "$OS" = linux ] && [ "$FORMAT" = deb ] && [ "$SERVER" = yes ] || return 0
  has_fonts && return 0
  has apt-cache || return 0
  for font in $SERVER_FONTS; do
    if apt-cache show "$font" >/dev/null 2>&1; then
      FONT_PACKAGES="${FONT_PACKAGES:+$FONT_PACKAGES }$font"
    fi
  done
}

timon_command() {
  if [ "$TESTING" = 1 ] && [ -n "$TIMON_BIN_OVERRIDE" ]; then
    say "$TIMON_BIN_OVERRIDE"
  elif [ -x /opt/Timon/cli/timon ] && [ "$OS" = linux ]; then
    say /opt/Timon/cli/timon
  elif has timon; then
    command -v timon
  fi
}

# The step that creates the first account. `timon init` arrived after 0.1.7:
# an older package only has the web form, reached through an SSH tunnel.
account_step() {
  if [ -n "${1:-}" ] && "$1" help 2>/dev/null | grep -q 'timon init'; then
    say '  timon init'
  else
    say '  open the web interface through an SSH tunnel and create it there:'
    say '  https://docs.timon-ai.com/installation/remote-access#step-0-finish-the-first-run-through-an-ssh-tunnel'
  fi
}

# A server's service is a systemd user service: without lingering it stops
# when the last SSH session ends. Asked through timon, which records the
# answer as the onboarding would; enabling lingering for one's own account
# needs no root where polkit allows it (Debian, Ubuntu). A machine with a
# screen never gets here: its session is the user's choice. A refusal does
# not fail the install: the command is printed.
linger_step() {
  if ! "$1" help 2>/dev/null | grep -q 'service session-mode'; then
    warn 'to keep Timon running after you log out, run: loginctl enable-linger'
    return 0
  fi
  if "$1" service session-mode always </dev/null >"$WORK/linger.txt" 2>&1; then
    say 'Timon keeps running after you log out.'
  else
    warn 'Timon could not be kept running after you log out:'
    sed 's/^/  /' "$WORK/linger.txt" >&2
    warn 'run it again with: timon service session-mode always'
  fi
}

# Whether the browser host the service install started answers, asked through
# timon: it knows the provider's file and the unit. An older package has no
# such check, and says nothing.
browser_step() {
  "$1" help 2>/dev/null | grep -q 'doctor --browser' || return 0
  say 'Checking the built-in browser...'
  if "$1" doctor --browser --wait "$BROWSER_WAIT" </dev/null >"$WORK/browser.txt" 2>&1; then
    say 'The built-in browser is ready: agents can browse with no screen.'
  else
    warn 'the built-in browser does not answer:'
    sed 's/^/  /' "$WORK/browser.txt" >&2
    warn 'check it again with: timon doctor --browser'
  fi
}

after_install() {
  say ''
  say "Timon $VERSION is installed."
  if [ "$FORMAT" = appimage ]; then
    say "  $APPIMAGE_PATH"
    if [ "$SERVER" = yes ]; then
      say 'The AppImage has no timon command and no background service. On a server, use Debian or Ubuntu with the deb package:'
      say "  $DOCS_URL"
    elif [ "$NO_LAUNCH" = 0 ]; then
      nohup "$APPIMAGE_PATH" >/dev/null 2>&1 &
      say 'Timon is opening: follow the welcome screen.'
    fi
    return 0
  fi

  if [ "$SERVER" = yes ]; then
    timon_bin=$(timon_command)
    [ -n "$timon_bin" ] || die 'the timon command was not installed; see the package output above'
    if [ "$NO_SERVICE" = 1 ]; then
      say 'Next steps, as the account that will own Timon (not root): install the background service,'
      say '  timon service install'
      say '  timon service session-mode always   # keeps it running after you log out'
      say 'then create your account:'
      account_step "$timon_bin"
    elif [ "$(id -u)" = 0 ]; then
      say 'The background service runs as the account that owns Timon, never as root.'
      say 'Log in as that account, then install the background service:'
      say '  timon service install'
      say '  timon service session-mode always   # keeps it running after you log out'
      say 'and create your account:'
      account_step "$timon_bin"
    else
      say 'Installing the background service...'
      if "$timon_bin" service install </dev/null; then
        linger_step "$timon_bin"
        browser_step "$timon_bin"
        say ''
        say 'Timon runs in the background. Next step, create your account:'
        account_step "$timon_bin"
      else
        warn 'the background service was not installed. Run it again to see why:'
        warn '  timon service install'
        exit 1
      fi
    fi
    return 0
  fi

  if [ "$NO_LAUNCH" = 1 ]; then
    say 'Open Timon from your applications to finish the setup.'
  elif [ "$OS" = mac ]; then
    if [ -n "${SSH_CONNECTION:-}" ]; then
      say 'Open Timon on this Mac to finish the setup.'
    else
      open -a Timon || say 'Open Timon from your applications to finish the setup.'
    fi
  elif [ -x /opt/Timon/timon-desktop ]; then
    nohup /opt/Timon/timon-desktop >/dev/null 2>&1 &
    say 'Timon is opening: follow the welcome screen.'
  else
    say 'Open Timon from your applications to finish the setup.'
  fi
}

# Sets status: 0 found, 3 no such channel, 4 no package for this system.
pick_artifact() {
  status=0
  read_artifact "$WORK/payload.json" "$CHANNEL" "$1" >"$WORK/artifact.txt" || status=$?
  if [ "$status" = 4 ] && [ "$OS" = mac ]; then
    status=0
    read_artifact "$WORK/payload.json" "$CHANNEL" "mac-universal-$FORMAT" >"$WORK/artifact.txt" || status=$?
  fi
}

main() {
  DRY_RUN=0
  DOWNLOAD_ONLY=0
  CHANNEL=''
  FORMAT=''
  SERVER=auto
  NO_SERVICE=0
  NO_LAUNCH=0
  # The command to run again, as root, when this account cannot install.
  RERUN_ARGS=''
  for arg in "$@"; do
    case "$arg" in
      --dry-run | --download-only) ;;
      *) RERUN_ARGS="${RERUN_ARGS:+$RERUN_ARGS }$arg" ;;
    esac
  done
  RERUN='curl -fsSL https://timon-ai.com/install.sh | sh'
  [ -z "$RERUN_ARGS" ] || RERUN="$RERUN -s -- $RERUN_ARGS"
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --download-only) DOWNLOAD_ONLY=1 ;;
      --channel)
        [ $# -ge 2 ] || die '--channel needs a value: beta or stable'
        CHANNEL="$2"
        shift
        ;;
      --channel=*) CHANNEL="${1#--channel=}" ;;
      --format)
        [ $# -ge 2 ] || die '--format needs a value: deb, appimage or pkg'
        FORMAT="$2"
        shift
        ;;
      --format=*) FORMAT="${1#--format=}" ;;
      --server) SERVER=yes ;;
      --no-service) NO_SERVICE=1 ;;
      --no-launch) NO_LAUNCH=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "unknown option: $1"
        ;;
    esac
    shift
  done
  case "$CHANNEL" in
    '' | beta | stable) ;;
    *) die "unknown channel: $CHANNEL (beta or stable)" ;;
  esac
  case "$FORMAT" in
    '' | deb | appimage | pkg) ;;
    *) die "unknown format: $FORMAT (deb, appimage or pkg)" ;;
  esac

  apply_test_hooks
  detect_platform
  # Before any download: the package alone weighs hundreds of megabytes.
  if [ "$DRY_RUN" = 0 ] && [ "$DOWNLOAD_ONLY" = 0 ] && lacks_admin; then refuse_without_admin; fi
  APPIMAGE_PATH="${TIMON_APPIMAGE_PATH:-$HOME/Applications/Timon.AppImage}"

  WORK=$(mktemp -d 2>/dev/null || mktemp -d -t timon-install)
  [ -n "$WORK" ] && [ -d "$WORK" ] || die 'could not create a temporary folder'
  # Kept with --download-only: the package is what was asked for.
  if [ "$DOWNLOAD_ONLY" = 0 ]; then trap 'rm -rf "$WORK"' EXIT; fi
  trap 'exit 130' INT TERM

  fetch "$INSTALL_MANIFEST_URL" "$WORK/releases.json" || die "could not download the release manifest ($INSTALL_MANIFEST_URL)"
  verify_manifest "$WORK/releases.json"

  key="$OS-$ARCH-$FORMAT"
  if [ -z "$CHANNEL" ]; then
    CHANNEL=stable
    pick_artifact "$key"
    if [ "$status" = 3 ]; then
      CHANNEL=beta
      pick_artifact "$key"
    fi
  else
    pick_artifact "$key"
  fi
  case "$status" in
    0) ;;
    3) die "no Timon release is published on the $CHANNEL channel" ;;
    4) die "no Timon package for $OS-$ARCH ($FORMAT) on the $CHANNEL channel yet; see $DOCS_URL" ;;
    *) die 'the release manifest is malformed' ;;
  esac
  {
    read -r VERSION
    read -r EXPIRES
    read -r A_NAME
    read -r A_URL
    read -r A_SIZE
    read -r A_SHA
  } <"$WORK/artifact.txt"

  # ISO 8601 UTC dates compare as strings: an expired manifest may be a
  # replayed one, pinning an old version.
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  awk -v expires="$EXPIRES" -v now="$now" 'BEGIN { exit !(expires != "" && expires "" > now "") }' ||
    die "the release manifest has expired ($EXPIRES); try again later"
  case "$A_NAME" in
    '' | .* | *[!A-Za-z0-9._-]*) die 'the release manifest names an invalid file' ;;
  esac
  case "$A_SIZE" in
    '' | *[!0-9]*) die 'the release manifest gives an invalid size' ;;
  esac
  A_SHA=$(printf '%s' "$A_SHA" | tr 'A-F' 'a-f')
  case "$A_SHA" in
    *[!0-9a-f]*) die 'the release manifest gives an invalid checksum' ;;
  esac
  [ "${#A_SHA}" -eq 64 ] || die 'the release manifest gives an invalid checksum'

  pick_fonts
  print_plan
  if [ "$DRY_RUN" = 1 ] && lacks_admin; then
    say ''
    refuse_without_admin
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say ''
    say 'Dry run: nothing was downloaded or installed.'
    return 0
  fi

  PACKAGE="$WORK/$A_NAME"
  say ''
  say "Downloading $A_NAME..."
  fetch "$A_URL" "$PACKAGE" progress || die "could not download $A_URL"
  got_size=$(file_size "$PACKAGE")
  got_sha=$(sha256_of "$PACKAGE")
  if [ "$got_size" != "$A_SIZE" ] || [ "$got_sha" != "$A_SHA" ]; then
    rm -f "$PACKAGE"
    die "the downloaded package does not match the manifest (size $got_size, sha256 $got_sha): nothing was installed"
  fi
  say 'Package verified.'

  if [ "$DOWNLOAD_ONLY" = 1 ]; then
    say "$PACKAGE"
    return 0
  fi

  install_package
  after_install
}

main "$@"
