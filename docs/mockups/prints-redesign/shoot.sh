#!/bin/sh
# Screenshots of the mockup with headless Chrome, 1440 × 900.
cd "$(dirname "$0")"
for p in a b c; do for v in overview detail; do for t in light dark; do
  google-chrome --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1440,900 --virtual-time-budget=2000 \
    --screenshot="proposal-$p-$v-$t-fr.png" "file://$PWD/index.html?p=$p&v=$v&theme=$t&shot=1" 2>/dev/null
done; done; done
