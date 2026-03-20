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
 *   Subject mappings: one per user-sketch pair, matching .username
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
const knownValueIds = new Map<string, string>(); // sketchId -> attributeValueId

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
      // Cache existing values with their IDs
      for (const v of existingAttr.values || []) {
        knownValueIds.set(v.value, v.id);
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

    console.log(`[OpenTDF] Ready. Namespace=${namespaceId}, Attribute=${attributeId}, ${knownValueIds.size} existing values.`);
  } catch (err) {
    console.error('[OpenTDF] Setup failed (non-fatal):', err);
  }
}

// --- Create attribute value for a sketch ---
export async function ensureSketchAttributeValue(sketchId: string): Promise<string | null> {
  const key = sketchId.toLowerCase();
  if (knownValueIds.has(key)) return knownValueIds.get(key)!;
  if (!attributeId) {
    console.warn('[OpenTDF] Attribute not initialized, skipping value creation.');
    return null;
  }
  try {
    const result = await rpc('policy.attributes.AttributesService', 'CreateAttributeValue', {
      attributeId,
      value: sketchId,
    });
    const valueId = result.value?.id;
    if (valueId) {
      knownValueIds.set(key, valueId);
      console.log(`[OpenTDF] Created attribute value for sketch: ${sketchId} (${valueId})`);
    }
    return valueId ?? null;
  } catch (err: any) {
    // May already exist (409 / ALREADY_EXISTS)
    if (err.message?.includes('ALREADY_EXISTS') || err.message?.includes('409')) {
      try {
        const attrResult = await rpc('policy.attributes.AttributesService', 'ListAttributeValues', {
          attributeId,
        });
        const found = attrResult.values?.find((v: any) => v.value.toLowerCase() === key);
        if (found) {
          knownValueIds.set(key, found.id);
          return found.id;
        }
      } catch {
        // Fall through
      }
      return null;
    }
    console.error(`[OpenTDF] Failed to create attribute value for sketch ${sketchId}:`, err);
    return null;
  }
}

// --- Create subject mapping for a user-sketch pair ---
export async function createSubjectMapping(
  username: string,
  sketchId: string,
): Promise<string | null> {
  let valueId = knownValueIds.get(sketchId.toLowerCase());
  if (!valueId) {
    valueId = await ensureSketchAttributeValue(sketchId) ?? undefined;
    if (!valueId) {
      console.warn(`[OpenTDF] No attribute value ID for sketch ${sketchId}, skipping subject mapping.`);
      return null;
    }
  }
  try {
    const result = await rpc(
      'policy.subjectmapping.SubjectMappingService',
      'CreateSubjectMapping',
      {
        attributeValueId: valueId,
        actions: [{ name: 'read' }],
        newSubjectConditionSet: {
          subjectSets: [{
            conditionGroups: [{
              booleanOperator: 'CONDITION_BOOLEAN_TYPE_ENUM_OR',
              conditions: [{
                subjectExternalSelectorValue: '.username',
                operator: 'SUBJECT_MAPPING_OPERATOR_ENUM_IN',
                subjectExternalValues: [username],
              }],
            }],
          }],
        },
      },
    );
    const mappingId = result.subjectMapping?.id ?? null;
    if (mappingId) {
      console.log(`[OpenTDF] Created subject mapping for ${username} -> sketch ${sketchId} (${mappingId})`);
    }
    return mappingId;
  } catch (err) {
    console.error(`[OpenTDF] Failed to create subject mapping for ${username} -> sketch ${sketchId}:`, err);
    return null;
  }
}

// --- Delete a subject mapping ---
export async function deleteSubjectMapping(mappingId: string): Promise<void> {
  try {
    await rpc(
      'policy.subjectmapping.SubjectMappingService',
      'DeleteSubjectMapping',
      { id: mappingId },
    );
    console.log(`[OpenTDF] Deleted subject mapping: ${mappingId}`);
  } catch (err) {
    console.error(`[OpenTDF] Failed to delete subject mapping ${mappingId}:`, err);
  }
}

// --- Fetch all skedoodle subject mappings (filtered client-side by namespace) ---
async function listSkedoodleSubjectMappings(): Promise<any[]> {
  const result = await rpc(
    'policy.subjectmapping.SubjectMappingService',
    'ListSubjectMappings',
  );
  const all = result.subjectMappings || [];
  return all.filter((m: any) => (m.attributeValue?.fqn || '').startsWith(NAMESPACE_FQN));
}

// --- Extract username from a subject mapping's condition set ---
function extractUsername(mapping: any): string | null {
  const conditionGroups = mapping.subjectConditionSet?.subjectSets?.[0]?.conditionGroups || [];
  for (const group of conditionGroups) {
    for (const cond of group.conditions || []) {
      if (cond.subjectExternalSelectorValue === '.username' && cond.subjectExternalValues?.length) {
        return cond.subjectExternalValues[0];
      }
    }
  }
  return null;
}

// --- List subject mappings for a sketch (collaborators) ---
export async function listSubjectMappingsForSketch(
  sketchId: string,
): Promise<{ username: string; mappingId: string }[]> {
  try {
    const mappings = await listSkedoodleSubjectMappings();
    const suffix = `/value/${sketchId.toLowerCase()}`;
    const matches: { username: string; mappingId: string }[] = [];

    for (const m of mappings) {
      if (!(m.attributeValue?.fqn || '').endsWith(suffix)) continue;
      const username = extractUsername(m);
      if (username) {
        matches.push({ username, mappingId: m.id });
      }
    }
    return matches;
  } catch (err) {
    console.error(`[OpenTDF] Failed to list subject mappings for sketch ${sketchId}:`, err);
    return [];
  }
}

// --- List sketch IDs a user has access to (via subject mappings) ---
export async function listSketchIdsForUser(username: string): Promise<string[]> {
  try {
    const mappings = await listSkedoodleSubjectMappings();
    const fqnPrefix = `${NAMESPACE_FQN}/attr/${ATTRIBUTE_NAME}/value/`;
    const sketchIds: string[] = [];

    for (const m of mappings) {
      const fqn: string = m.attributeValue?.fqn || '';
      if (!fqn.startsWith(fqnPrefix)) continue;
      const extractedUsername = extractUsername(m);
      if (extractedUsername === username) {
        sketchIds.push(fqn.slice(fqnPrefix.length).toUpperCase());
      }
    }
    return sketchIds;
  } catch (err) {
    console.error(`[OpenTDF] Failed to list sketch IDs for user ${username}:`, err);
    return [];
  }
}

// --- Find subject mapping ID for a user-sketch pair ---
export async function findSubjectMappingId(
  username: string,
  sketchId: string,
): Promise<string | null> {
  const mappings = await listSubjectMappingsForSketch(sketchId);
  const match = mappings.find(m => m.username === username);
  return match?.mappingId ?? null;
}

// --- Check access via GetDecisions (no cache, fail-closed) ---
export async function checkAccess(username: string, sketchId: string): Promise<boolean> {
  try {
    const fqn = `${NAMESPACE_FQN}/attr/${ATTRIBUTE_NAME}/value/${sketchId}`;
    const decisionRequest = {
      decisionRequests: [{
        actions: [{ name: 'read' }],
        entityChains: [{
          id: 'user',
          entities: [{ userName: username }],
        }],
        resourceAttributes: [{
          attributeValueFqns: [fqn],
        }],
      }],
    };
    const result = await rpc('authorization.AuthorizationService', 'GetDecisions', decisionRequest);
    const decision = result.decisionResponses?.[0]?.decision;
    const allowed = decision === 'DECISION_PERMIT';

    console.log(`[OpenTDF] GetDecisions for ${username} on sketch ${sketchId}: ${decision}`);
    return allowed;
  } catch (err) {
    console.error(`[OpenTDF] GetDecisions failed for ${username}:${sketchId}:`, err);
    return false;
  }
}

export const opentdfService = {
  ensureNamespaceAndAttribute,
  ensureSketchAttributeValue,
  createSubjectMapping,
  deleteSubjectMapping,
  listSubjectMappingsForSketch,
  listSketchIdsForUser,
  findSubjectMappingId,
  checkAccess,
};
