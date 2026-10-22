#!/usr/bin/env bash
# Observability smoke test — verifies the stack is up and collecting data.
# Usage: ./scripts/observability-smoke.sh [PROMETHEUS_URL]
# Default: http://localhost:9090

set -euo pipefail

PROMETHEUS_URL="${1:-http://localhost:9090}"
GRAFANA_URL="http://localhost:3300"
LOKI_URL="http://localhost:3100"
TEMPO_URL="http://localhost:3200"
ALERTMANAGER_URL="http://localhost:9093"

PASS=0
FAIL=0

check() {
    local name="$1"
    local url="$2"
    local expected="${3:-200}"
    local response_code
    response_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$url" || echo "000")
    if [ "$response_code" = "$expected" ]; then
        echo "  PASS: $name ($url → $response_code)"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $name ($url → $response_code, expected $expected)"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== Observability Smoke Test ==="
echo ""

echo "1. Service health checks:"
check "Prometheus" "$PROMETHEUS_URL/-/healthy" "200"
check "Grafana" "$GRAFANA_URL/api/health" "200"
check "Loki" "$LOKI_URL/ready" "200"
check "Tempo" "$TEMPO_URL/ready" "200"
check "Alertmanager" "$ALERTMANAGER_URL/-/healthy" "200"
echo ""

echo "2. Prometheus targets:"
TARGETS=$(curl -s --max-time 5 "$PROMETHEUS_URL/api/v1/targets" 2>/dev/null || echo '{"data":{"activeTargets":[]}}')
TOTAL=$(echo "$TARGETS" | jq '.data.activeTargets | length' 2>/dev/null || echo "0")
UP=$(echo "$TARGETS" | jq '[.data.activeTargets[] | select(.health == "up")] | length' 2>/dev/null || echo "0")
DOWN=$(echo "$TARGETS" | jq '[.data.activeTargets[] | select(.health != "up")] | length' 2>/dev/null || echo "0")
echo "  Total targets: $TOTAL"
echo "  Up: $UP"
echo "  Down: $DOWN"
if [ "$DOWN" = "0" ]; then
    echo "  PASS: All targets up"
    PASS=$((PASS + 1))
else
    echo "  FAIL: $DOWN targets are down"
    FAIL=$((FAIL + 1))
    echo "$TARGETS" | jq -r '.data.activeTargets[] | select(.health != "up") | "    - " + .labels.job + " (" + .health + ")"' 2>/dev/null
fi
echo ""

echo "3. Prometheus alert rules:"
RULES=$(curl -s --max-time 5 "$PROMETHEUS_URL/api/v1/rules" 2>/dev/null || echo '{"data":{"groups":[]}}')
RULE_COUNT=$(echo "$RULES" | jq '[.data.groups[].rules[]] | length' 2>/dev/null || echo "0")
echo "  Total rules: $RULE_COUNT"
if [ "$RULE_COUNT" -gt 0 ]; then
    echo "  PASS: Alert rules loaded"
    PASS=$((PASS + 1))
else
    echo "  FAIL: No alert rules loaded"
    FAIL=$((FAIL + 1))
fi
echo ""

echo "4. Grafana datasources:"
DATASOURCES=$(curl -s --max-time 5 "$GRAFANA_URL/api/datasources" 2>/dev/null || echo "[]")
DS_COUNT=$(echo "$DATASOURCES" | jq 'length' 2>/dev/null || echo "0")
echo "  Datasources: $DS_COUNT"
if [ "$DS_COUNT" -ge 4 ]; then
    echo "  PASS: All 4 datasources provisioned"
    PASS=$((PASS + 1))
else
    echo "  FAIL: Expected 4 datasources, got $DS_COUNT"
    FAIL=$((FAIL + 1))
fi
echo ""

echo "5. Grafana dashboards:"
DASHBOARDS=$(curl -s --max-time 5 "$GRAFANA_URL/api/search?type=dash-db" 2>/dev/null || echo "[]")
DASH_COUNT=$(echo "$DASHBOARDS" | jq 'length' 2>/dev/null || echo "0")
echo "  Dashboards: $DASH_COUNT"
if [ "$DASH_COUNT" -ge 8 ]; then
    echo "  PASS: All 8 dashboards provisioned"
    PASS=$((PASS + 1))
else
    echo "  FAIL: Expected 8 dashboards, got $DASH_COUNT"
    FAIL=$((FAIL + 1))
fi
echo ""

echo "6. Metrics collection (http_requests_total):"
METRICS=$(curl -s --max-time 5 "$PROMETHEUS_URL/api/v1/query?query=http_requests_total" 2>/dev/null || echo '{"data":{"result":[]}}')
METRIC_COUNT=$(echo "$METRICS" | jq '.data.result | length' 2>/dev/null || echo "0")
echo "  Series count: $METRIC_COUNT"
if [ "$METRIC_COUNT" -gt 0 ]; then
    echo "  PASS: Application metrics are being collected"
    PASS=$((PASS + 1))
else
    echo "  WARN: No http_requests_total metrics yet (services may not have received traffic)"
fi
echo ""

echo "7. Container metrics (cAdvisor):"
CADVISOR=$(curl -s --max-time 5 "$PROMETHEUS_URL/api/v1/query?query=container_memory_working_set_bytes" 2>/dev/null || echo '{"data":{"result":[]}}')
CONTAINER_COUNT=$(echo "$CADVISOR" | jq '.data.result | length' 2>/dev/null || echo "0")
echo "  Container series: $CONTAINER_COUNT"
if [ "$CONTAINER_COUNT" -gt 0 ]; then
    echo "  PASS: Container metrics are being collected"
    PASS=$((PASS + 1))
else
    echo "  FAIL: No container metrics found"
    FAIL=$((FAIL + 1))
fi
echo ""

echo "=== Summary ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo ""

if [ "$FAIL" -gt 0 ]; then
    echo "❌ Smoke test FAILED — $FAIL check(s) failed"
    exit 1
else
    echo "✅ Smoke test PASSED — all checks passed"
    exit 0
fi
