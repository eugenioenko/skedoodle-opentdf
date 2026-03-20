# Skedoodle + OpenTDF

This is the [OpenTDF](https://github.com/opentdf/platform) ABAC (Attribute-Based Access Control) integration of [Skedoodle](https://github.com/eugenioenko/skedoodle). It adds fine-grained authorization to Skedoodle using OpenTDF's policy engine, with Keycloak as the identity provider.

For the base Skedoodle project see the [main repository](https://github.com/eugenioenko/skedoodle).

## What this fork adds

- **Collaborator-based access control**: sketch owners can invite and remove collaborators by username
- **Role-aware WebSocket rooms**: owners and collaborators can draw, public viewers are read-only, unauthorized users are rejected
- **Real-time access revocation**: removing a collaborator kicks them from the active session instantly
- **OpenTDF ABAC enforcement**: sketches are registered as attribute values in OpenTDF, and access decisions are validated through the platform's `GetDecisions` API
- **Share dialog UI**: invite collaborators, manage access, and leave sketches from within the app

Read the full writeup: [Adding ABAC to a Real-Time Collaborative App with OpenTDF](https://codelog.yy-dev.top/posts/adding-abac-to-skedoodle-with-opentdf)

---

## What is Skedoodle

A real-time collaborative sketching app built with event sourcing and WebSockets.

**Try the base version live:** [skedoodle.top](https://skedoodle.top/local)

Multiple people draw on the same canvas at once. Every stroke, shape, and edit is captured as an immutable command in an append-only log. The log is the single source of truth, and the canvas is just a projection of it.

### Drawing tools

- Freehand brush with configurable stabilization and real-time path simplification (Douglas-Peucker, Visvalingam-Whyatt variants)
- Lines with optional arrowheads, rectangles, bezier curves, text with inline editing
- Pointer for selecting and dragging shapes, eraser, hand/pan, zoom
- Infinite canvas with pan and zoom up to 10,000%

### Collaboration

- Real-time sync via WebSocket rooms
- Remote cursor tracking with color-coded labels
- User presence indicators
- Offline-first: works locally with localStorage, reconciles on reconnect

### Performance

- 0% CPU at idle, event-driven rendering
- ~20% CPU max with throttling enabled
- Configurable frame rate: 120fps, 60fps, or 15fps battery-saver mode

## Tech stack

| Layer         | Stack                                                    |
| ------------- | -------------------------------------------------------- |
| Frontend      | React, Vite, TypeScript, Two.js, Zustand, Tailwind CSS   |
| Backend       | Express 5, TypeScript, WebSocket (`ws`), Prisma (SQLite) |
| Auth          | Keycloak OIDC (`oidc-client-ts` + `jose`)                |
| Authorization | OpenTDF ABAC (Connect RPC API)                           |

## Quick start

### Prerequisites

- Node.js 22+
- pnpm
- Docker and Docker Compose (for OpenTDF platform)

### 1. Install and run the OpenTDF platform

Follow the [OpenTDF platform quickstart](https://github.com/opentdf/platform/#quick-start) to get the platform running locally. This sets up:

- **Keycloak** with the `opentdf` realm, pre-seeded with default clients and configuration
- **OpenTDF platform** services (Policy, Authorization, KAS)
- **PostgreSQL** for the platform database

Once running, verify:

- Keycloak: `http://localhost:8888/auth`
- OpenTDF platform: `http://localhost:8080/healthz`

> If your OpenTDF setup uses different ports, update the `.env` files accordingly.

### 2. Install Skedoodle

```bash
git clone https://github.com/eugenioenko/skedoodle-opentdf.git
cd skedoodle-opentdf
make install
```

This installs client and server dependencies, generates the Prisma client, and applies database migrations. The `.env` files are committed with defaults for local development (Keycloak at `localhost:8888`, OpenTDF at `localhost:8080`). No configuration needed unless your ports differ.

### 3. Seed Keycloak

```bash
make seed
```

This creates the `skedoodle` public client in Keycloak's `opentdf` realm with the required audience mappers, and creates test users (user1 through user10, password: `testuser123`). It's idempotent and safe to run multiple times.

**What it configures:**

- A public OIDC client (`skedoodle`) with PKCE, correct redirect URIs, and web origins
- `skedoodle-audience` mapper: includes `skedoodle` in the access token's `aud` claim
- `opentdf-audience` mapper: includes `http://localhost:8080` in the access token's `aud` claim (required for OpenTDF platform access)

<details>
<summary>Manual Keycloak setup (if you prefer not to use the script)</summary>

Open the admin console at `http://localhost:8888/auth/admin/master/console/#/opentdf` (credentials: `admin` / `changeme`):

1. **Create client**: Clients > Create client
   - Client ID: `skedoodle`
   - Client authentication: OFF (public client)
   - Standard flow: ON
2. **Configure URLs**:
   - Valid redirect URIs: `http://localhost:5173/auth/callback`
   - Valid post-logout redirect URIs: `http://localhost:5173/auth/logout`
   - Web origins: `http://localhost:5173`
3. **Add audience mappers** (Client > Client scopes > skedoodle-dedicated > Add mapper > By configuration > Audience):
   - `skedoodle-audience`: Included Client Audience = `skedoodle`, Add to access token = ON
   - `opentdf-audience`: Included Custom Audience = `http://localhost:8080`, Add to access token = ON
4. **Create users** in the `opentdf` realm and set their passwords

</details>

### 4. Run

```bash
make start
```

This starts the server and client. Open `http://localhost:5173` and sign in with any test user (e.g., `user1` / `testuser123`).

On server startup, Skedoodle automatically registers its namespace and attribute definition in the OpenTDF platform. No manual policy seeding required.

## How authorization works

```
User creates sketch
  > SketchCollaborator row created (role: owner)
  > OpenTDF attribute value registered for sketch

User shares sketch with "user2"
  > SketchCollaborator row created (role: collaborator)

User2 joins sketch via WebSocket
  > Server checks SketchCollaborator table > role = collaborator > allowed
  > Server calls OpenTDF GetDecisions > PERMIT
  > User2 joins room with write access

User3 (not a collaborator) tries to join
  > Server checks SketchCollaborator > not found
  > Sketch not public > connection rejected with "Access denied"

Owner removes User2
  > SketchCollaborator row deleted
  > User2 kicked from WebSocket room immediately
  > Client shows "Access Revoked" dialog
```

## Project structure

```
skedoodle-opentdf/
├── client/                # React frontend (Vite)
│   └── src/
│       ├── canvas/        # Drawing tools, rendering, history/command system
│       ├── components/    # UI components (including share-dialog)
│       ├── services/      # API, storage, and collaborator clients
│       ├── stores/        # Zustand state stores
│       └── sync/          # WebSocket sync client (role-aware)
├── server/                # Express + WebSocket backend
│   └── src/
│       ├── routes/        # REST API (auth, sketches, collaborators)
│       ├── services/      # OpenTDF ABAC service
│       └── utils/         # OIDC token validation, auth middleware
│   └── prisma/            # Schema and migrations (includes SketchCollaborator)
├── scripts/
│   ├── setup-keycloak.sh  # Creates skedoodle client + audience mappers
│   └── create-test-users.sh # Creates user1-user10 for testing
└── Makefile               # install, seed, start commands
```

## License

MIT — see [LICENSE](LICENSE).
