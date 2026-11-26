#!/bin/bash

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Chromium's sandbox needs a user namespace, or a setuid-root chrome-sandbox.
#
# Ubuntu 23.10 and later (kernel.apparmor_restrict_unprivileged_userns=1, the
# default of 24.04, desktop and server images alike) refuse user namespaces to
# any unprivileged program AppArmor does not name. This profile names our
# executable and grants it that one right, nothing else, as Chrome and other
# Electron apps do. Installed only when AppArmor runs and this version of it
# reads the profile: a file it cannot parse would fail AppArmor at every boot.
# Plain variables only below: the package builder expands every brace form.
apparmor_profile='/etc/apparmor.d/${executable}'
apparmor_marker='# Written by the ${sanitizedProductName} package: removed with it.'
if [ -d /etc/apparmor.d ] && [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = 'Y' ] && hash apparmor_parser 2>/dev/null; then
    if [ -e "$apparmor_profile" ] && ! grep -qxF "$apparmor_marker" "$apparmor_profile"; then
        echo "AppArmor profile not written: $apparmor_profile belongs to someone else." >&2
    else
        apparmor_candidate="$(mktemp)"
        cat > "$apparmor_candidate" <<APPARMOR
$apparmor_marker
abi <abi/4.0>,
include <tunables/global>

profile ${executable} /opt/${sanitizedProductName}/${executable} flags=(unconfined) {
  userns,

  include if exists <local/${executable}>
}
APPARMOR
        if apparmor_parser --skip-kernel-load --skip-cache "$apparmor_candidate" >/dev/null 2>&1; then
            cp -f "$apparmor_candidate" "$apparmor_profile" && chmod 0644 "$apparmor_profile"
            # A chroot (an image being built) has no kernel to load it into:
            # AppArmor reads the file at the next boot.
            if ! { hash ischroot 2>/dev/null && ischroot; }; then
                apparmor_parser --replace --write-cache --skip-read-cache "$apparmor_profile" >/dev/null 2>&1 \
                    || echo "AppArmor profile $apparmor_profile written; it loads at the next boot (sudo apparmor_parser -r $apparmor_profile loads it now)." >&2
            fi
        else
            echo 'AppArmor profile not installed: this AppArmor version does not read it (it does not restrict user namespaces either).' >&2
        fi
        rm -f "$apparmor_candidate"
    fi
fi

# The helper loses its setuid bit only when an ordinary user can create a user
# namespace and write its maps, as Chromium does. Not tested as root: root
# holds CAP_SYS_ADMIN, which AppArmor's restriction exempts, so the test always
# passed and left the helper unusable. `unshare` is not the executable the
# profile names, so under the restriction the test fails even once the profile
# lets Chromium in: the helper stays setuid, as Chrome's own package always
# leaves it. Chromium uses it only when it cannot create a namespace, which is
# exactly when the profile could not be loaded.
if [[ -L /proc/self/ns/user ]] && hash setpriv 2>/dev/null \
    && setpriv --reuid=65534 --regid=65534 --clear-groups -- unshare --user --map-root-user true >/dev/null 2>&1; then
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Do not replace a command owned by a source checkout or another package.
if [ ! -e /usr/bin/timon ] && [ ! -L /usr/bin/timon ]; then
    ln -s '/opt/${sanitizedProductName}/cli/timon' /usr/bin/timon
elif [ "$(readlink /usr/bin/timon)" != '/opt/${sanitizedProductName}/cli/timon' ]; then
    echo 'Timon CLI was not installed: /usr/bin/timon already belongs to another installation.' >&2
fi

echo 'Timon is installed. Open it from your applications.'
echo 'On a server, as the account that will own Timon (not root): timon service install, then timon init.'
