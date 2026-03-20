import { WebSocketServer, WebSocket } from 'ws';
import { Room } from './room';
import type { ClientMessage, UserInfo, SketchRole } from './protocol';
import { verifyOidcToken } from './utils/auth';
import { prisma } from './prisma';
import { opentdfService } from './services/opentdf.service';

const WS_PORT = process.env.WS_PORT;

export const wss = new WebSocketServer({ port: Number(WS_PORT) });
const rooms = new Map<string, Room>();

export function getRooms() {
  return rooms;
}

wss.on('connection', (ws: WebSocket) => {
  let room: Room | undefined;
  let user: UserInfo | undefined;

  console.log('Client connected');

  async function handleJoin(message: Extract<ClientMessage, { type: 'join' }>) {
    try {
      const decodedToken = await verifyOidcToken(message.token);
      const { userId, username } = decodedToken;
      const { sketchId } = message;

      // ABAC gate: always verify access via OpenTDF GetDecisions
      const abacAllowed = await opentdfService.checkAccess(username, sketchId);
      if (!abacAllowed) {
        ws.send(JSON.stringify({ type: 'error', message: 'Access denied by policy' }));
        ws.close();
        return;
      }

      // Determine role from sketch ownership
      const sketch = await prisma.sketch.findUnique({
        where: { id: sketchId },
        select: { ownerId: true },
      });
      const role: SketchRole = sketch?.ownerId === userId ? 'owner' : 'collaborator';

      user = {
        uid: userId,
        userId: userId,
        name: username,
        color: message.user.color,
      };
      if (!rooms.has(sketchId)) {
        rooms.set(sketchId, new Room(sketchId, (id) => {
          console.log(`Cleaning up empty room: ${id}`);
          rooms.get(id)?.destroy();
          rooms.delete(id);
        }));
      }
      room = rooms.get(sketchId)!;
      await room.addClient(ws, user, role);
    } catch (error: any) {
      console.warn('Authentication failed for join request:', error.message);
      ws.send(JSON.stringify({ type: 'error', message: 'Authentication failed' }));
      ws.close();
    }
  }

  ws.on('message', async (rawMessage: Buffer) => {
    try {
      const message: ClientMessage = JSON.parse(rawMessage.toString());

      if (message.type === 'join') {
        await handleJoin(message);
        return;
      }

      if (!room || !user) {
        console.warn('Received message from unauthenticated client.');
        return;
      }

      switch (message.type) {
        case 'command':
          room.handleCommand(message.command, ws);
          break;
        case 'cursor':
          room.handleCursor(user.uid, message.x, message.y, ws);
          break;
        case 'meta':
          room.handleMeta(message.data);
          break;
        default:
          console.warn('Unknown message type received:', message.type);
      }
    } catch (error) {
      console.error('Failed to process message:', rawMessage.toString(), error);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    if (room && user) {
      room.removeClient(ws);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

export const startWsServer = () => {
  console.log(`WebSocket server started on ws://localhost:${WS_PORT}`);
};
