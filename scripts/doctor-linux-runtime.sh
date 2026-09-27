#!/usr/bin/env bash
set -uo pipefail

failures=0

report() {
  printf '%s %s\n' "$1" "$2"
  if [[ "$1" == FAIL ]]; then
    failures=$((failures + 1))
  fi
}

if [[ "$(uname -s)" != Linux ]]; then
  report FAIL 'Linux host required'
  exit 1
fi

case "$(pwd -P)" in
  /mnt/*) report FAIL 'Run from a Linux filesystem checkout' ;;
  *) report PASS 'Linux filesystem checkout' ;;
esac

for tool in git node npm rg fd herdr agent-browser docker docker-compose; do
  executable="$(command -v "$tool" 2>/dev/null || true)"
  case "$executable" in
    '') report FAIL "$tool is missing" ;;
    /mnt/*) report FAIL "$tool resolves to a Windows path" ;;
    *) report PASS "$tool is Linux native" ;;
  esac
done

if command -v node >/dev/null 2>&1; then
  [[ "$(node --version 2>/dev/null)" == v24.21.0 ]] &&
    report PASS 'Node 24.21.0' || report FAIL 'Node version differs from 24.21.0'
fi
if command -v npm >/dev/null 2>&1; then
  [[ "$(npm --version 2>/dev/null)" == 12.0.2 ]] &&
    report PASS 'npm 12.0.2' || report FAIL 'npm version differs from 12.0.2'
fi

kit_pin="$(sed -nE 's/^export const PINNED_KIT_COMMIT = "([0-9a-f]{40})";$/\1/p' apps/server/src/runtime/pi/kit-loader.ts)"
if [[ -z "$kit_pin" ]]; then
  report FAIL 'Glassbox Kit pin could not be read'
elif [[ -z "${LORA_PI_KIT_PATH:-}" ]]; then
  report FAIL 'LORA_PI_KIT_PATH is unset'
elif [[ ! -f "${LORA_PI_KIT_PATH}/package.json" ]]; then
  report FAIL 'LORA_PI_KIT_PATH has no package manifest'
elif [[ "$(git -C "$LORA_PI_KIT_PATH" rev-parse HEAD 2>/dev/null)" != "$kit_pin" ]]; then
  report FAIL 'Lora PI Kit commit differs from the Glassbox pin'
else
  report PASS 'Lora PI Kit commit matches the Glassbox pin'
  if [[ -n "$(git -C "$LORA_PI_KIT_PATH" status --porcelain --untracked-files=all 2>/dev/null)" ]]; then
    report FAIL 'Lora PI Kit working tree has uncommitted files'
  else
    report PASS 'Lora PI Kit working tree is clean'
  fi
fi

if command -v docker >/dev/null 2>&1 && docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
  report PASS 'Linux Docker API is reachable'
else
  report FAIL 'Linux Docker API is unavailable'
fi

printf 'Doctor failures: %s\n' "$failures"
((failures == 0))
