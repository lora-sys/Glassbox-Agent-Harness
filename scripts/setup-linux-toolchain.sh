#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  echo 'This setup requires Linux.' >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64) node_arch=arm64 ;;
  *) echo 'Unsupported Linux architecture.' >&2; exit 1 ;;
esac

node_version=24.21.0
npm_version=12.0.2
archive="node-v${node_version}-linux-${node_arch}.tar.xz"
install_root="${GLASSBOX_LINUX_TOOLCHAIN_DIR:-$HOME/.local/opt}"
node_root="${install_root}/node-v${node_version}-linux-${node_arch}"

if [[ ! -x "${node_root}/bin/node" || ! -x "${node_root}/bin/npm" ]] || \
  ! PATH="${node_root}/bin:${PATH}" "${node_root}/bin/npm" --version >/dev/null 2>&1; then
  for tool in curl sha256sum tar xz grep mktemp; do
    command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }
  done

  download_dir="$(mktemp -d)"
  trap 'rm -rf -- "$download_dir"' EXIT
  curl --fail --location --retry 3 --silent --show-error \
    "https://nodejs.org/dist/v${node_version}/${archive}" -o "${download_dir}/${archive}"
  curl --fail --location --retry 3 --silent --show-error \
    "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o "${download_dir}/SHASUMS256.txt"
  (
    cd "$download_dir"
    grep " ${archive}\$" SHASUMS256.txt | sha256sum -c -
  )
  mkdir -p "$install_root"
  tar -xJf "${download_dir}/${archive}" -C "$install_root"
fi

export PATH="${node_root}/bin:${PATH}"
if [[ "$(node --version)" != "v${node_version}" ]]; then
  echo "Installed Node does not match ${node_version}." >&2
  exit 1
fi

if [[ "$(npm --version)" != "$npm_version" ]]; then
  npm install --global --prefix "$node_root" "npm@${npm_version}"
fi
if [[ "$(npm --version)" != "$npm_version" ]]; then
  echo "Installed npm does not match ${npm_version}." >&2
  exit 1
fi

printf 'Node %s and npm %s ready in %s\n' "$node_version" "$npm_version" "$node_root"
printf 'Use %s/bin at the start of PATH for Linux service and build commands.\n' "$node_root"
