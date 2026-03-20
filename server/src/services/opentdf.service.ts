/**
 * OpenTDF ABAC integration service.
 *
 * Uses Connect RPC (HTTP/JSON) to communicate with the OpenTDF platform
 * for attribute-based access control on sketches.
 *
 * ABAC model:
 *   Namespace: https://skedoodle.com
 *   Attribute: sketch-access (rule: AnyOf)
 *   Values: one per sketch ID
 */

const PLATFORM_URL = process.env.OPENTDF_PLATFORM_URL || 'http://localhost:8080';
const OIDC_URL = process.env.OIDC_ISSUER_URL!;
const CLIENT_ID = process.env.OPENTDF_CLIENT_ID || 'opentdf';
const CLIENT_SECRET = process.env.OPENTDF_CLIENT_SECRET || 'secret';

const NAMESPACE_NAME = 'skedoodle.com';
const NAMESPACE_FQN = `https://${NAMESPACE_NAME}`;
const ATTRIBUTE_NAME = 'sketch-access';
const ATTRIBUTE_RULE = 'ATTRIBUTE_RULE_TYPE_ENUM_ANY_OF';

// --- Token cache ---
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getServiceToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 30_000) {
    return cachedToken;
  }
  const res = await fetch(`${OIDC_URL}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`,
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in ?? 300) * 1000;
  return cachedToken!;
}

// --- Connect RPC helper ---
async function rpc(service: string, method: string, body: Record<string, unknown> = {}) {
  const token = await getServiceToken();
  const res = await fetch(`${PLATFORM_URL}/${service}/${method}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC ${service}/${method} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// --- Cached IDs ---
let namespaceId: string | null = null;
let attributeId: string | null = null;
const knownValues = new Set<string>(); // sketchIds with existing attribute values

// --- Setup: ensure namespace + attribute definition exist ---
export async function ensureNamespaceAndAttribute(): Promise<void> {
  try {
    // Find or create namespace
    const nsResult = await rpc('policy.namespaces.NamespaceService', 'ListNamespaces');
    const existing = nsResult.namespaces?.find((ns: any) => ns.name === NAMESPACE_NAME);
    if (existing) {
      namespaceId = existing.id;
    } else {
      const created = await rpc('policy.namespaces.NamespaceService', 'CreateNamespace', {
        name: NAMESPACE_NAME,
      });
      namespaceId = created.namespace.id;
      console.log(`[OpenTDF] Created namespace: ${NAMESPACE_FQN} (${namespaceId})`);
    }

    // Find or create attribute definition
    const attrResult = await rpc('policy.attributes.AttributesService', 'ListAttributes');
    const existingAttr = attrResult.attributes?.find(
      (a: any) => a.namespace?.id === namespaceId && a.name === ATTRIBUTE_NAME
    );
    if (existingAttr) {
      attributeId = existingAttr.id;
      // Cache existing values
      for (const v of existingAttr.values || []) {
        knownValues.add(v.value);
      }
    } else {
      const created = await rpc('policy.attributes.AttributesService', 'CreateAttribute', {
        namespaceId,
        name: ATTRIBUTE_NAME,
        rule: ATTRIBUTE_RULE,
        values: [],
      });
      attributeId = created.attribute.id;
      console.log(`[OpenTDF] Created attribute: ${ATTRIBUTE_NAME} (${attributeId})`);
    }

    console.log(`[OpenTDF] Ready. Namespace=${namespaceId}, Attribute=${attributeId}, ${knownValues.size} existing values.`);
  } catch (err) {
    console.error('[OpenTDF] Setup failed (non-fatal):', err);
  }
}

// --- Create attribute value for a sketch ---
export async function ensureSketchAttributeValue(sketchId: string): Promise<void> {
  if (knownValues.has(sketchId)) return;
  if (!attributeId) {
    console.warn('[OpenTDF] Attribute not initialized, skipping value creation.');
    return;
  }
  try {
    await rpc('policy.attributes.AttributesService', 'CreateAttributeValue', {
      attributeId,
      value: sketchId,
    });
    knownValues.add(sketchId);
    console.log(`[OpenTDF] Created attribute value for sketch: ${sketchId}`);
  } catch (err: any) {
    // May already exist (409 / ALREADY_EXISTS)
    if (err.message?.includes('ALREADY_EXISTS') || err.message?.includes('409')) {
      knownValues.add(sketchId);
    } else {
      console.error(`[OpenTDF] Failed to create attribute value for sketch ${sketchId}:`, err);
    }
  }
}

// --- Authorization decision cache ---
const decisionCache = new Map<string, { result: boolean; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

export function invalidateAccessCache(userId: string, sketchId: string) {
  decisionCache.delete(`${userId}:${sketchId}`);
}

// --- Check access via GetDecisions ---
export async function checkAccess(userOidcSub: string, sketchId: string): Promise<boolean> {
  const cacheKey = `${userOidcSub}:${sketchId}`;
  const cached = decisionCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.result;
  }

  try {
    const fqn = `${NAMESPACE_FQN}/attr/${ATTRIBUTE_NAME}/value/${sketchId}`;
    const result = await rpc('authorization.AuthorizationService', 'GetDecisions', {
      decisionRequests: [{
        actions: [{ standard: 'STANDARD_ACTION_TRANSMIT' }],
        entityChains: [{
          id: 'user',
          entities: [{ emailAddress: userOidcSub }],
        }],
        resourceAttributes: [{
          attributeValueFqns: [fqn],
        }],
      }],
    });

    const decision = result.decisionResponses?.[0]?.decision;
    const allowed = decision === 'DECISION_PERMIT';

    decisionCache.set(cacheKey, { result: allowed, expiresAt: Date.now() + CACHE_TTL_MS });
    return allowed;
  } catch (err) {
    console.error(`[OpenTDF] GetDecisions failed for ${userOidcSub}:${sketchId}:`, err);
    // Fail open — fall back to DB-based check
    return true;
  }
}

export const opentdfService = {
  ensureNamespaceAndAttribute,
  ensureSketchAttributeValue,
  checkAccess,
  invalidateAccessCache,
};
