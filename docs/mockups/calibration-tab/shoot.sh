#!/bin/sh
# Screenshots of the mockup with headless Chrome, 1440 × 900.
cd "$(dirname "$0")"
shot() { google-chrome --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1440,900 --virtual-time-budget=2000 --screenshot="$1" "file://$PWD/index.html?$2&shot=1" 2>/dev/null; }
for t in light dark; do
  shot "home-$t-fr.png" "v=home&theme=$t"
  shot "pid-1-choose-$t-fr.png" "v=pid-choose&theme=$t"
  shot "pid-3-run-$t-fr.png" "v=pid-run&theme=$t"
  shot "is-3-result-$t-fr.png" "v=is-result&theme=$t"
  shot "refused-printing-$t-fr.png" "v=refused&theme=$t"
done
shot "pid-2-prepare-light-fr.png" "v=pid-prepare&theme=light"
shot "pid-2-confirm-light-fr.png" "v=pid-confirm&theme=light"
shot "pid-4-result-light-fr.png" "v=pid-result&theme=light"
shot "is-1-prepare-light-fr.png" "v=is-prepare&theme=light"
shot "xyz-current-light-fr.png" "v=xyz&theme=light"
shot "home-light-en.png" "v=home&theme=light&lang=en"
shot "pid-4-result-dark-en.png" "v=pid-result&theme=dark&lang=en"
