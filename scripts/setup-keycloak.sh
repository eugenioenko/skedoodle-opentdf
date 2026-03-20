#!/usr/bin/env bash
#
# Creates the "skedoodle" public client in Keycloak's opentdf realm
# with the required audience mappers for OpenTDF.
#
# Prerequisites: OpenTDF platform running (Keycloak at localhost:8888)
#
# Usage: ./scripts/setup-keycloak.sh
#
# Environment variables (all optional, defaults match OpenTDF quickstart):
#   KEYCLOAK_URL    - Keycloak base URL        (default: http://localhost:8888/auth)
#   KEYCLOAK_REALM  - Target realm             (default: opentdf)
#   KEYCLOAK_ADMIN  - Admin username           (default: admin)
#   KEYCLOAK_PASS   - Admin password           (default: changeme)
#   CLIENT_ID       - Client ID to create      (default: skedoodle)
#   PLATFORM_URL    - OpenTDF platform URL     (default: http://localhost:8080)
#   APP_URL         - Skedoodle client URL     (default: http://localhost:5173)

set -euo pipefail

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8888/auth}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-opentdf}"
KEYCLOAK_ADMIN="${KEYCLOAK_ADMIN:-admin}"
KEYCLOAK_PASS="${KEYCLOAK_PASS:-changeme}"
CLIENT_ID="${CLIENT_ID:-skedoodle}"
PLATFORM_URL="${PLATFORM_URL:-http://localhost:8080}"
APP_URL="${APP_URL:-http://localhost:5173}"

echo "Keycloak:  $KEYCLOAK_URL"
echo "Realm:     $KEYCLOAK_REALM"
echo "Client:    $CLIENT_ID"
echo "App URL:   $APP_URL"
echo "Platform:  $PLATFORM_URL"
echo ""

# Get admin token
echo "Getting admin token..."
TOKEN=$(curl -sf -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=$KEYCLOAK_ADMIN&password=$KEYCLOAK_PASS&grant_type=password&client_id=admin-cli" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to get admin token. Check Keycloak URL and credentials."
  exit 1
fi
echo "Got admin token."

# Check if client already exists
EXISTING=$(curl -sf -H "Authorization: Bearer $TOKEN" \
  "$KEYCLOAK_URL/admin/realms/$KEYCLOAK_REALM/clients?clientId=$CLIENT_ID" \
  | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")

if [ "$EXISTING" != "0" ]; then
  echo "Client '$CLIENT_ID' already exists in realm '$KEYCLOAK_REALM'. Skipping creation."
  CLIENT_UUID=$(curl -sf -H "Authorization: Bearer $TOKEN" \
    "$KEYCLOAK_URL/admin/realms/$KEYCLOAK_REALM/clients?clientId=$CLIENT_ID" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")
else
  # Create public client
  echo "Creating client '$CLIENT_ID'..."
  curl -sf -X POST "$KEYCLOAK_URL/admin/realms/$KEYCLOAK_REALM/clients" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"clientId\": \"$CLIENT_ID\",
      \"name\": \"Skedoodle\",
      \"enabled\": true,
      \"publicClient\": true,
      \"standardFlowEnabled\": true,
      \"directAccessGrantsEnabled\": false,
      \"redirectUris\": [\"$APP_URL/auth/callback\"],
      \"webOrigins\": [\"$APP_URL\"],
      \"attributes\": {
        \"pkce.code.challenge.method\": \"S256\",
        \"post.logout.redirect.uris\": \"$APP_URL/auth/logout\"
      },
      \"protocol\": \"openid-connect\",
      \"fullScopeAllowed\": true
    }"

  CLIENT_UUID=$(curl -sf -H "Authorization: Bearer $TOKEN" \
    "$KEYCLOAK_URL/admin/realms/$KEYCLOAK_REALM/clients?clientId=$CLIENT_ID" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")
  echo "Created client. UUID: $CLIENT_UUID"
fi

# Add skedoodle audience mapper
echo "Adding skedoodle audience mapper..."
curl -sf -o /dev/null -X POST \
  "$KEYCLOAK_URL/admin/realms/$KEYCLOAK_REALM/clients/$CLIENT_UUID/protocol-mappers/models" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"skedoodle-audience\",
    \"protocol\": \"openid-connect\",
    \"protocolMapper\": \"oidc-audience-mapper\",
    \"config\": {
      \"included.client.audience\": \"$CLIENT_ID\",
      \"id.token.claim\": \"false\",
      \"access.token.claim\": \"true\",
      \"lightweight.claim\": \"false\",
      \"introspection.token.claim\": \"true\"
    }
  }" 2>/dev/null || echo "  (may already exist, skipping)"

# Add opentdf audience mapper
echo "Adding opentdf audience mapper..."
curl -sf -o /dev/null -X POST \
  "$KEYCLOAK_URL/admin/realms/$KEYCLOAK_REALM/clients/$CLIENT_UUID/protocol-mappers/models" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"opentdf-audience\",
    \"protocol\": \"openid-connect\",
    \"protocolMapper\": \"oidc-audience-mapper\",
    \"config\": {
      \"included.custom.audience\": \"$PLATFORM_URL\",
      \"id.token.claim\": \"false\",
      \"access.token.claim\": \"true\",
      \"lightweight.claim\": \"false\",
      \"introspection.token.claim\": \"true\"
    }
  }" 2>/dev/null || echo "  (may already exist, skipping)"

echo ""
echo "Done! Client '$CLIENT_ID' is ready in the '$KEYCLOAK_REALM' realm."
echo ""
echo "To create test users, run:"
echo "  ./scripts/create-test-users.sh"
