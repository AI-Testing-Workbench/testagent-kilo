#!/bin/bash
# Setup ES component templates for OpenTelemetry trace search
# Usage: ./init-es.sh [http://localhost:9200] [-u user:password]
#        ./init-es.sh http://10.0.0.1:9200 -u elastic:yourpassword
set -euo pipefail

ES_URL="${1:-http://localhost:9200}"
AUTH=""
if [ "${2:-}" = "-u" ] && [ -n "${3:-}" ]; then
  AUTH="-u $3"
fi

echo "==> Creating traces-otel@custom component template..."

curl -s $AUTH -X PUT "$ES_URL/_component_template/traces-otel%40custom" \
  -H 'Content-Type: application/json' \
  -d '{
  "template": {
    "mappings": {
      "properties": {
        "attributes": {
          "type": "passthrough",
          "priority": 25,
          "dynamic": true,
          "time_series_dimension": true,
          "properties": {
            "ai.prompt.messages":   { "type": "text" },
            "ai.response.text":     { "type": "text" },
            "ai.response.reasoning": { "type": "text" },
            "ai.prompt.tools":      { "type": "text" },
            "ai.toolCall.args":     { "type": "text" },
            "ai.toolCall.result":   { "type": "text" }
          }
        }
      }
    }
  }
}' | grep -q '"acknowledged":true' && echo "   OK" || echo "   FAIL (check ES logs)"

echo ""
echo "==> Rolling over trace data stream to apply mapping to new backing index..."

curl -s $AUTH -X POST "$ES_URL/traces-generic.otel-default/_rollover" | \
  grep -o '"new_index":"[^"]*"' | head -1

echo ""
echo "==> Done. You may now delete old backing indices if desired."
