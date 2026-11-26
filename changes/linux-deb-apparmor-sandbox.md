---
type: fixed
---
The Linux `.deb` package now starts on Ubuntu 23.10 and later (24.04 included) without any manual setting: it installs an AppArmor profile that lets Timon's sandbox work. When the sandbox is still unusable, the built-in browser of a server stops with the cause and its repair instead of restarting in a loop.
