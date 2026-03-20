import { Router } from 'express';
import { requireAuth } from '../utils/auth';
import { prisma } from '../prisma';
import { getRooms } from '../ws-server';

const router = Router();

// GET collaborators for a sketch
router.get('/:id/collaborators', requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;
    // Verify access: must be a collaborator or sketch is public
    const sketch = await prisma.sketch.findFirst({
      where: {
        id,
        OR: [
          { collaborators: { some: { userId: req.userId } } },
          { public: true },
        ],
      },
      select: { id: true },
    });
    if (!sketch) {
      res.status(404).json({ error: 'Sketch not found' });
      return;
    }
    const collaborators = await prisma.sketchCollaborator.findMany({
      where: { sketchId: id },
      select: {
        userId: true,
        role: true,
        createdAt: true,
        user: { select: { username: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(collaborators.map(c => ({
      userId: c.userId,
      username: c.user.username,
      role: c.role,
      createdAt: c.createdAt,
    })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST invite a collaborator
router.post('/:id/collaborators', requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;
    const { username } = req.body;
    if (!username) {
      res.status(400).json({ error: 'username is required' });
      return;
    }
    // Verify requester is the owner
    const ownerCollab = await prisma.sketchCollaborator.findFirst({
      where: { sketchId: id, userId: req.userId, role: 'owner' },
    });
    if (!ownerCollab) {
      res.status(403).json({ error: 'Only the owner can invite collaborators' });
      return;
    }
    // Find the user to invite
    const invitee = await prisma.user.findUnique({ where: { username } });
    if (!invitee) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (invitee.id === req.userId) {
      res.status(400).json({ error: 'Cannot invite yourself' });
      return;
    }
    // Create collaborator (upsert to handle duplicates)
    const collab = await prisma.sketchCollaborator.upsert({
      where: { sketchId_userId: { sketchId: id, userId: invitee.id } },
      update: {},
      create: { sketchId: id, userId: invitee.id, role: 'collaborator' },
      select: {
        userId: true,
        role: true,
        createdAt: true,
        user: { select: { username: true } },
      },
    });
    res.status(201).json({
      userId: collab.userId,
      username: collab.user.username,
      role: collab.role,
      createdAt: collab.createdAt,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE remove a collaborator or leave
router.delete('/:id/collaborators/:userId', requireAuth, async (req: any, res) => {
  try {
    const { id, userId: targetUserId } = req.params;
    const requesterId = req.userId;

    // Get requester's role
    const requesterCollab = await prisma.sketchCollaborator.findUnique({
      where: { sketchId_userId: { sketchId: id, userId: requesterId } },
    });

    // Get target's role
    const targetCollab = await prisma.sketchCollaborator.findUnique({
      where: { sketchId_userId: { sketchId: id, userId: targetUserId } },
    });

    if (!targetCollab) {
      res.status(404).json({ error: 'Collaborator not found' });
      return;
    }

    // Cannot remove the owner
    if (targetCollab.role === 'owner') {
      res.status(403).json({ error: 'Cannot remove the sketch owner' });
      return;
    }

    if (requesterId === targetUserId) {
      // Self-removal (leaving) — any collaborator can leave
      if (!requesterCollab || requesterCollab.role === 'owner') {
        res.status(403).json({ error: 'Owner cannot leave their own sketch' });
        return;
      }
    } else {
      // Removing someone else — must be owner
      if (!requesterCollab || requesterCollab.role !== 'owner') {
        res.status(403).json({ error: 'Only the owner can remove collaborators' });
        return;
      }
    }

    await prisma.sketchCollaborator.delete({
      where: { sketchId_userId: { sketchId: id, userId: targetUserId } },
    });

    // Kick from active WebSocket room if connected
    const rooms = getRooms();
    const room = rooms.get(id);
    if (room) {
      room.kickClient(targetUserId);
    }

    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
