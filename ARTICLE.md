I built [Skedoodle](https://github.com/eugenioenko/skedoodle), an open-source real-time collaborative sketching app. Think a lightweight Figma for doodling: multiple users connect over WebSocket, draw on a shared infinite canvas, and see each other's cursors move in real time. It's built with React, TypeScript, Two.js for vector graphics, and Zustand for state management, with an Express backend handling persistence and real-time sync.

Building the interactive parts was the fun challenge. Throttled rendering at 60fps, path simplification algorithms to keep stroke data lean, touch support, pan and zoom on an infinite canvas, undo/redo that works across multiple collaborators. Skedoodle is a proper interactive app, not a toy demo.

But it had a glaring gap: **no authorization**. Authentication? Sure, users logged in via OIDC. But once you were in, you could access any sketch if you knew the ID. Think YouTube: every video is technically accessible if you have the link, even "unlisted" ones. Skedoodle had the same problem. There was no way to control who could see or edit what.

I needed to fix this. And rather than hand-roll role checks and a collaborators table, I wanted to use a proper policy engine — one that could handle the simple case today and scale to more complex scenarios without rewriting everything.

## How This Project Started

This whole project started because I was working with an AI agent to generate an [`llms.txt`](https://opentdf.io/llms.txt) for OpenTDF — a structured documentation file designed to give AI agents enough context to work with a platform. Once we had it, the obvious next step was to test it: take a real project with no authorization at all, point an agent at the `llms.txt`, and see if it could build a correct ABAC integration from scratch.

Skedoodle was the perfect candidate. A real collaborative app, with authentication but zero authorization. The experiment: could an AI agent, armed only with OpenTDF's `llms.txt` and a description of the access model I wanted, deliver a working integration?

## Why OpenTDF

[OpenTDF](https://opentdf.io/) is an open-source platform maintained by [Virtru](https://www.virtru.com/) that provides attribute-based access control (ABAC) alongside end-to-end encryption via the [Trusted Data Format](https://github.com/opentdf/spec) specification.

What drew me in was how **lightweight the authorization integration is**. OpenTDF is known for its encryption capabilities, but the ABAC engine stands entirely on its own. You don't need to encrypt anything to use it. You define policies, and the platform makes access decisions. That's exactly what I needed: a centralized policy engine that could answer "does this user have access to this sketch?" based on attributes rather than hardcoded role checks.

The ABAC model is straightforward:

1. You define **namespaces** and **attributes** (e.g., `https://skedoodle.com/attr/sketch-access`)
2. Each attribute has **values** and a **rule** (AnyOf, AllOf, or Hierarchy)
3. **Subject mappings** connect identity provider claims to attribute entitlements
4. When someone requests access, the platform evaluates their entitlements against the resource's required attributes and returns **permit or deny**

No SDKs to embed, no agents to deploy. It's a JSON API you call. Your app manages the data, OpenTDF manages the policy.

## The Access Model

What I wanted was straightforward:

- **Owner** creates a sketch and always has full access
- **Owner can invite** other users by username
- **Owner can remove** any collaborator
- **Collaborators** can draw on the sketch and can leave voluntarily
- **Collaborators cannot** remove other collaborators or the owner
- **No public access** — every sketch requires an explicit ABAC grant. Read-only public sharing could be layered on later as a separate attribute.

Simple enough for users to understand, but it needs proper enforcement at every layer: REST API, WebSocket connections, and the real-time command stream.

## Building It with an AI Agent

I used Claude Code as my coding agent. The agent fetched OpenTDF's `llms.txt` at runtime, which gave it the architectural overview, API reference, Connect RPC URL patterns, protobuf enum values, and curl examples it needed to understand the platform.

The agent:

- Read the docs and **correctly chose ABAC authorization over full TDF encryption**, understanding that per-command encryption would be impractical for real-time collaboration
- Designed an attribute scheme (one attribute value per sketch, AnyOf rule) that maps cleanly to the sharing model
- Built the entire integration: REST API, WebSocket authorization, OpenTDF service with subject mapping lifecycle, and client UI

The `llms.txt` gave the agent enough context to use the right API patterns without guessing — the correct RPC URL format, the exact enum values for condition operators and boolean types, the entity identifier structure for `GetDecisions`. I described the access model I wanted, and it delivered a working integration.

The ongoing iteration — refining the architecture, debugging access issues, removing redundant layers — was also done collaboratively with the agent, with `llms.txt` as the shared reference for how OpenTDF's APIs work. When we hit an issue where ABAC returned PERMIT but the app still denied access, the agent was able to trace the problem because it understood the full authorization flow from the docs.

## How the Integration Works

### ABAC as the Single Source of Truth

There's no `collaborators` table in the database. OpenTDF is the **sole authority** for access control. The database stores sketches, commands, and users. Who has access to what is entirely managed through OpenTDF subject mappings.

This is a deliberate design choice. Instead of maintaining a local access control table and keeping it in sync with a policy engine, the application delegates all authorization to OpenTDF. The only local concept of "role" is ownership: the `Sketch` table has an `ownerId` field. Everything else — who can access which sketch, whether a given user is permitted — comes from ABAC.

### Policy Structure

On server startup, the service registers Skedoodle's policy structure with OpenTDF:

```yaml
Namespace: https://skedoodle.com
Attribute: sketch-access (rule: AnyOf)
```

Each sketch gets its own attribute value. Subject mappings are actively managed as part of the application lifecycle:

- **Sketch created** → register an attribute value, create a subject mapping for the owner
- **Collaborator invited** → create a subject mapping linking the user's username to the sketch's attribute value
- **Collaborator removed** → delete the subject mapping
- **Access check** → call `GetDecisions` to verify the user has a valid entitlement

### The Sharing Workflow

Three endpoints handle collaboration:

```plaintext
POST   /api/sketches/:id/collaborators           Owner invites by username
DELETE /api/sketches/:id/collaborators/:username  Owner removes, or user leaves
GET    /api/sketches/:id/collaborators            List who has access
```

When an owner invites a collaborator, the app creates a subject mapping in OpenTDF:

```typescript
const result = await rpc(
  "policy.subjectmapping.SubjectMappingService",
  "CreateSubjectMapping",
  {
    attributeValueId: valueId,
    actions: [{ name: "read" }],
    newSubjectConditionSet: {
      subjectSets: [
        {
          conditionGroups: [
            {
              booleanOperator: "CONDITION_BOOLEAN_TYPE_ENUM_OR",
              conditions: [
                {
                  subjectExternalSelectorValue: ".username",
                  operator: "SUBJECT_MAPPING_OPERATOR_ENUM_IN",
                  subjectExternalValues: [username],
                },
              ],
            },
          ],
        },
      ],
    },
  }
);
```

This tells the platform: when a user's Keycloak `.username` matches, grant them the sketch's attribute value entitlement.

Listing collaborators queries `ListSubjectMappings` and filters for mappings that match the sketch's attribute value. Removing a collaborator deletes the mapping. There's no local state to keep in sync.

### Access Checks

Every protected operation — loading a sketch, fetching commands, joining a WebSocket room, saving commands — calls `GetDecisions`:

```typescript
const result = await rpc("authorization.AuthorizationService", "GetDecisions", {
  decisionRequests: [
    {
      actions: [{ name: "read" }],
      entityChains: [
        {
          id: "user",
          entities: [{ userName: username }],
        },
      ],
      resourceAttributes: [
        {
          attributeValueFqns: [
            `https://skedoodle.com/attr/sketch-access/value/${sketchId}`,
          ],
        },
      ],
    },
  ],
});
const allowed = result.decisionResponses?.[0]?.decision === "DECISION_PERMIT";
```

If the platform denies access or is unreachable, the request is rejected. This is a deliberate choice — ABAC is the single source of truth, so there's no stale local copy to fall back to. In a production deployment where availability is critical, you'd want to run OpenTDF with redundancy, or introduce a short-lived decision cache as a buffer. For Skedoodle, fail-closed is the right tradeoff: denying access temporarily is better than granting it incorrectly.

### WebSocket Enforcement

Real-time collaboration adds a wrinkle. You can't call a policy service on every brush stroke. The approach:

1. **Authorize on join**: call `GetDecisions` when a user connects
2. **Enforce at the room level**: owners and collaborators can draw, the role is set once at join time
3. **Kick on revocation**: when access is removed via the API, immediately disconnect the user

```typescript
// When an owner removes a collaborator
const mappingId = await opentdfService.findSubjectMappingId(targetUsername, sketchId);
if (mappingId) {
  await opentdfService.deleteSubjectMapping(mappingId);
}

const room = rooms.get(sketchId);
if (room) {
  room.kickClientByUsername(targetUsername);
}
```

The client handles revocation gracefully with a dialog explaining what happened and options to go back.

### Listing Sketches from ABAC

To show a user their sketches, the app queries both the database and OpenTDF in parallel:

```typescript
const [ownedSketches, abacSketchIds] = await Promise.all([
  prisma.sketch.findMany({ where: { ownerId: req.userId } }),
  opentdfService.listSketchIdsForUser(req.username),
]);
```

Owned sketches come from the database. Shared sketches come from OpenTDF by iterating subject mappings and extracting sketch IDs from attribute value FQNs. The two lists are merged, deduped, and returned with roles.

## What This Shows About ABAC

This integration replaced what would typically be a `collaborators` join table, a set of role-checking queries, and manual sync logic — with a handful of API calls to a policy engine.

Where ABAC gets interesting is what happens next. Today Skedoodle's access model is simple: per-sketch, per-user grants. But the same infrastructure supports:

- Mapping team membership to sketch access (subject mappings based on group claims instead of individual usernames)
- Classification-based access (new attributes with AllOf or Hierarchy rules)
- Cross-organization sharing (attribute values scoped to external identity providers)

These would be **policy changes** — new attributes, new subject mappings — not application code changes. The `checkAccess()` call stays the same.

## The Timeline

The entire integration took **one afternoon**:

| Phase                                                | Time   |
| ---------------------------------------------------- | ------ |
| Switch identity provider to Keycloak                 | 15 min |
| Create Keycloak client + test users                  | 10 min |
| Collaborator API + OpenTDF subject mapping lifecycle  | 15 min |
| WebSocket authorization + kick-on-revoke             | 15 min |
| Client UI (share dialog, access denied, role badges) | 20 min |
| OpenTDF ABAC service integration                     | 15 min |
| Debugging and polish                                 | 20 min |

The OpenTDF integration itself was the smallest piece. Most of the work was building the sharing UX and enforcing access at the WebSocket layer. OpenTDF slotted in cleanly because it's designed to be an authorization service you call, not a framework you restructure your app around.

## Key Takeaways

**ABAC can be your single source of truth for access control.** Instead of maintaining a collaborators table and keeping it in sync with a policy engine, Skedoodle delegates all authorization to OpenTDF. The application code doesn't contain access control logic beyond "ask OpenTDF and respect the answer."

**The integration surface is small.** Six API operations cover the entire authorization model, callable from any language with plain `fetch`.

**Real-time apps need smart enforcement points.** You can't call a policy service on every WebSocket message. Authorize on connect, enforce roles at the room level, and handle revocation proactively by kicking disconnected users.

**`llms.txt` makes AI-assisted integration practical.** The agent built a working ABAC integration from documentation alone. Structured, machine-readable docs lower the barrier to adoption — not just for AI agents, but for any developer exploring a new platform.

**ABAC scales where RBAC doesn't.** Roles are fine until you need to express "users in department X with clearance level Y can access resources tagged with classification Z." That sentence maps directly to ABAC attributes. Trying to model it with roles leads to an explosion of role combinations.

## Try It

The [OpenTDF](https://opentdf.io/) integration lives in a dedicated fork: [skedoodle-opentdf](https://github.com/eugenioenko/skedoodle-opentdf). It includes everything you need to run the full stack locally.

If you're building an app that needs access control beyond basic ownership — especially if you want centralized policy management or the flexibility to evolve your authorization model over time — ABAC with [OpenTDF](https://opentdf.io/) is worth a look.
