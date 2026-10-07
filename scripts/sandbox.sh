#!/usr/bin/env bash
set -euo pipefail

# Expose only application inputs and writable runtime state to the bot.
# Install bubblewrap first. Hosts enforcing AppArmor user-namespace policy can
# select a dedicated, administrator-created profile with SANDBOX_APPARMOR_PROFILE.
bot_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
node_binary=${NODE_BINARY:-$(command -v node)}
launcher=(bwrap)
if [[ -n ${SANDBOX_APPARMOR_PROFILE:-} ]]; then
  launcher=(aa-exec -p "$SANDBOX_APPARMOR_PROFILE" -- bwrap)
fi

for directory in cache logs tools; do
  mkdir -p -- "$bot_root/$directory"
done
if [[ $# == 0 ]]; then set -- dist/main.js; fi

exec "${launcher[@]}" \
  --unshare-all --share-net --die-with-parent --new-session --cap-drop ALL \
  --clearenv --setenv PATH /runtime:/usr/bin:/bin --setenv NODE_ENV production \
  --ro-bind /usr /usr \
  --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --ro-bind /etc/resolv.conf /etc/resolv.conf \
  --ro-bind /etc/hosts /etc/hosts \
  --ro-bind /etc/nsswitch.conf /etc/nsswitch.conf \
  --ro-bind /etc/ssl/certs /etc/ssl/certs \
  --ro-bind /etc/ld.so.cache /etc/ld.so.cache \
  --ro-bind "$node_binary" /runtime/node \
  --ro-bind "$bot_root/dist" /app/dist \
  --ro-bind "$bot_root/node_modules" /app/node_modules \
  --ro-bind "$bot_root/package.json" /app/package.json \
  --ro-bind "$bot_root/config" /app/config \
  --ro-bind "$bot_root/.env" /app/.env \
  --bind "$bot_root/cache" /app/cache \
  --bind "$bot_root/logs" /app/logs \
  --bind "$bot_root/tools" /app/tools \
  --proc /proc --dev /dev --tmpfs /tmp --chdir /app \
  /runtime/node --env-file=.env "$@"
