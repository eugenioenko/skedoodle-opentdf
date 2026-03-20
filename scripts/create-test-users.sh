#!/usr/bin/env bash
#
# Creates test users (user1-user10) in Keycloak's opentdf realm.
# All users get the same password.
#
# Usage: ./scripts/create-test-users.sh
#
# Environment variables (all optional):
#   KEYCLOAK_URL    - Keycloak base URL   (default: http://localhost:8888/auth)
#   KEYCLOAK_REALM  - Target realm        (default: opentdf)
#   KEYCLOAK_ADMIN  - Admin username      (default: admin)
#   KEYCLOAK_PASS   - Admin password      (default: changeme)
#   USER_PASSWORD   - Password for users  (default: testuser123)
#   USER_COUNT      - Number of users     (default: 10)

set -euo pipefail

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8888/auth}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-opentdf}"
KEYCLOAK_ADMIN="${KEYCLOAK_ADMIN:-admin}"
KEYCLOAK_PASS="${KEYCLOAK_PASS:-changeme}"
USER_PASSWORD="${USER_PASSWORD:-testuser123}"
USER_COUNT="${USER_COUNT:-10}"

# Get admin token
TOKEN=$(curl -sf -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=$KEYCLOAK_ADMIN&password=$KEYCLOAK_PASS&grant_type=password&client_id=admin-cli" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to get admin token."
  exit 1
fi

for i in $(seq 1 "$USER_COUNT"); do
  USERNAME="user${i}"

  # Create user
  HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" -X POST \
    "$KEYCLOAK_URL/admin/realms/$KEYCLOAK_REALM/users" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$USERNAME\",\"enabled\":true,\"emailVerified\":true}" 2>/dev/null || echo "000")

  # Get user ID
  USER_ID=$(curl -sf -H "Authorization: Bearer $TOKEN" \
    "$KEYCLOAK_URL/admin/realms/$KEYCLOAK_REALM/users?username=$USERNAME&exact=true" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")

  # Set password
  curl -sf -o /dev/null -X PUT \
    "$KEYCLOAK_URL/admin/realms/$KEYCLOAK_REALM/users/$USER_ID/reset-password" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"password\",\"value\":\"$USER_PASSWORD\",\"temporary\":false}"

  if [ "$HTTP_CODE" = "201" ]; then
    echo "Created $USERNAME (password: $USER_PASSWORD)"
  else
    echo "Updated $USERNAME (already existed, password reset)"
  fi
done

echo ""
echo "Done! $USER_COUNT users created in the '$KEYCLOAK_REALM' realm."
