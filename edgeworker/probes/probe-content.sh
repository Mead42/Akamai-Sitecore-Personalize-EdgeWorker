#!/usr/bin/env bash
# Queries Sitecore Experience Edge for the personalization content the
# EdgeWorker config must mirror: per-language friendlyId (personalizedData),
# variant item names (activePageVariants -> allowedVariants), and the
# personalized flag. Also lists the site definitions.
#
# Run whenever Sitecore content changes, and copy the results into config.js
# (friendlyId + allowedVariants). Defaults target nonprod; override for other
# environments:
#   EDGE_ENDPOINT=https://<cm-host>/sitecore/api/graph/edge \
#   EDGE_API_KEY='{...}' SITE=ccl-home ./probe-content.sh
set -euo pipefail

EDGE_ENDPOINT="${EDGE_ENDPOINT:-https://www4.nonprod.carnivalcloud.net/sitecore/api/graph/edge}"
EDGE_API_KEY="${EDGE_API_KEY:-{FFA18363-D286-485F-BC4C-16DF2411B457}}"
SITE="${SITE:-ccl-home}"
# IMPORTANT: query the path the property FORWARDS to origin (the route's
# originPath), not the client-facing path — '/home' and '/' resolve to
# different Sitecore items (item 'home' vs item 'homepage'), and the
# personalization fields must be read from the item that is actually served.
ITEM_PATH="${ITEM_PATH:-/home}"
LANGUAGES="${LANGUAGES:-en-US en-AU en-NZ en}"

# URL-encode the braces in the API key for query-string auth (header auth is
# rejected by this endpoint).
KEY_ENC=$(printf '%s' "$EDGE_API_KEY" | sed 's/{/%7B/; s/}/%7D/')

echo "== Site definitions (hostname -> site name)"
curl -sk "$EDGE_ENDPOINT?sc_apikey=$KEY_ENC" -H "Content-Type: application/json" \
  -d '{"query":"{ site { siteInfoCollection { name hostname } } }"}'
echo; echo

QUERY='query($siteName:String!,$language:String!,$itemPath:String!){layout(site:$siteName,routePath:$itemPath,language:$language){item{id name personalized:field(name:\"personalized\"){...on CheckboxField{boolValue}} personalizedData:field(name:\"PersonalizedData\"){...on TextField{value}} activePageVariants:field(name:\"activePageVariants\"){...on MultilistField{targetItems{id name}}}}}}'

for LANG in $LANGUAGES; do
  echo "== $SITE $ITEM_PATH [$LANG]"
  curl -sk "$EDGE_ENDPOINT?sc_apikey=$KEY_ENC" -H "Content-Type: application/json" \
    -d "{\"query\":\"$QUERY\",\"variables\":{\"siteName\":\"$SITE\",\"language\":\"$LANG\",\"itemPath\":\"$ITEM_PATH\"}}"
  echo
done

echo
echo "Checklist against config.js:"
echo " - personalizedData value == route friendlyId (must be lowercase [a-z0-9_] — the Engage API 400s otherwise)"
echo " - activePageVariants item names == route allowedVariants (exact spelling)"
echo " - personalized should be true for the page once content is live"
