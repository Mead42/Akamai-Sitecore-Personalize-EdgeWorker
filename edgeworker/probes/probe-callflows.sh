#!/usr/bin/env bash
# Executes one real Personalize decision the same way the EdgeWorker does:
# browser/create then callFlows. Answers, empirically:
#  - the flow's raw response shape (what extractVariantId must parse; once the
#    template is stable, main.js's tolerant parsing can be collapsed)
#  - the exact variant id/name the flow returns (must normalize-match an
#    allowedVariants entry, or the EdgeWorker serves default)
#  - what an unassigned visitor gets (e.g. {"message":"No flow executed"})
#
# Defaults target the nonprod tenant. Simulate a logged-in visitor by passing
# the relevant cookie params, e.g.:
#   FRIENDLY_ID=<real_flow_id> EXTRA_PARAMS='"cookies_cclUser":"1"' ./probe-callflows.sh
# For AU: POS=carnivalAU CURRENCY=AUD (or NZD to mimic SelectedCurrency=NZD).
set -euo pipefail

TARGET_URL="${TARGET_URL:-https://api-engage-us.sitecorecloud.io}"
CLIENT_KEY="${CLIENT_KEY:-6ae337932da5ccc2e2336b4b6d33ec69}"
FRIENDLY_ID="${FRIENDLY_ID:?set FRIENDLY_ID to the page's personalizedData value}"
POS="${POS:-carnivalUS}"
CURRENCY="${CURRENCY:-USD}"
LANGUAGE="${LANGUAGE:-en}"
CHANNEL="${CHANNEL:-WEB}"
EXTRA_PARAMS="${EXTRA_PARAMS:-}"   # e.g. '"cookies_cclUser":"1","qs_foo":"bar"'
BROWSER_ID="${BROWSER_ID:-}"       # reuse a ref to test a returning visitor

if [ -z "$BROWSER_ID" ]; then
  echo "== browser/create"
  CREATE=$(curl -sk "$TARGET_URL/v1.2/browser/create.json?client_key=$CLIENT_KEY&message=%7B%7D")
  echo "$CREATE"
  BROWSER_ID=$(printf '%s' "$CREATE" | grep -oE '"ref":\s*"[^"]*"' | head -1 | sed 's/.*"ref":\s*"//;s/"//')
  [ -n "$BROWSER_ID" ] || { echo "no ref returned"; exit 1; }
fi

PARAMS='"referrer":"about:client"'
[ -n "$EXTRA_PARAMS" ] && PARAMS="$PARAMS,$EXTRA_PARAMS"

echo
echo "== callFlows (browserId $BROWSER_ID)"
curl -sk "$TARGET_URL/v2/callFlows" -H "Content-Type: application/json" -d "{
  \"channel\":\"$CHANNEL\",
  \"clientKey\":\"$CLIENT_KEY\",
  \"currencyCode\":\"$CURRENCY\",
  \"friendlyId\":\"$FRIENDLY_ID\",
  \"language\":\"$LANGUAGE\",
  \"params\":{$PARAMS},
  \"pointOfSale\":\"$POS\",
  \"browserId\":\"$BROWSER_ID\"
}"
echo
