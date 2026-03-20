import { Router } from 'express';
import { requireAuth } from '../utils/auth';
import { prisma } from '../prisma';
import { opentdfService } from '../services/opentdf.service';

const router = Router();

const sketchSelect = {
  id: true, name: true, color: true, positionX: true, positionY: true,
  zoom: true, public: true, createdAt: true, updatedAt: true, ownerId: true,
} as const;

router.get('/community', async (_req, res) => {
  try {
    const sketches = await prisma.sketch.findMany({
      where: { public: true },
      select: {
        id: true, name: true, color: true, public: true,
        createdAt: true, updatedAt: true, ownerId: true,
        owner: { select: { username: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(sketches.map(s => ({
      ...s,
      ownerName: s.owner.username,
      owner: undefined,
    })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET all sketches for the authenticated user (owned + collaborated)
router.get('/', requireAuth, async (req: any, res) => {
  try {
    const collaborations = await prisma.sketchCollaborator.findMany({
      where: { userId: req.userId },
      select: { sketchId: true, role: true },
    });
    const sketchIds = collaborations.map(c => c.sketchId);
    const roleMap = new Map(collaborations.map(c => [c.sketchId, c.role]));
    const sketches = await prisma.sketch.findMany({
      where: { id: { in: sketchIds } },
      select: { ...sketchSelect, owner: { select: { username: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(sketches.map(s => ({
      ...s,
      role: roleMap.get(s.id) || 'viewer',
      ownerName: s.owner.username,
      owner: undefined,
    })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST a new sketch
router.post('/', requireAuth, async (req: any, res) => {
  try {
    const { id, name } = req.body;
    const newSketch = await prisma.sketch.create({
      data: {
        id: id || undefined,
        name: name || 'Untitled Sketch',
        owner: { connect: { id: req.userId } },
        collaborators: {
          create: { userId: req.userId, role: 'owner' },
        },
      },
    });
    // Register sketch as an OpenTDF attribute value (non-blocking)
    opentdfService.ensureSketchAttributeValue(newSketch.id).catch(err =>
      console.warn(`[OpenTDF] Failed to register sketch ${newSketch.id}:`, err)
    );
    res.status(201).json(newSketch);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET a specific sketch's metadata
router.get('/:id', requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;
    const sketch = await prisma.sketch.findFirst({
      where: {
        id,
        OR: [
          { collaborators: { some: { userId: req.userId } } },
          { public: true },
        ],
      },
      select: {
        ...sketchSelect,
        owner: { select: { username: true } },
        collaborators: {
          select: { userId: true, role: true, user: { select: { username: true } } },
        },
      },
    });
    if (!sketch) {
      res.status(404).json({ error: 'Sketch not found' });
      return;
    }
    const collab = sketch.collaborators.find(c => c.userId === req.userId);
    res.json({
      ...sketch,
      role: collab?.role || 'viewer',
      ownerName: sketch.owner.username,
      owner: undefined,
      collaborators: sketch.collaborators.map(c => ({
        userId: c.userId,
        username: c.user.username,
        role: c.role,
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT (update) a sketch's metadata
router.put('/:id', requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;
    const { name, color } = req.body;
    const isPublic = req.body.public;
    const updatedSketch = await prisma.sketch.update({
      where: { id, ownerId: req.userId },
      data: {
        ...(name !== undefined && { name }),
        ...(color !== undefined && { color }),
        ...(isPublic !== undefined && { public: isPublic }),
        updatedAt: new Date(),
      },
    });
    res.json(updatedSketch);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE a sketch
router.delete('/:id', requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;
    await prisma.sketch.delete({
      where: { id, ownerId: req.userId },
    });
    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET all commands for a specific sketch
router.get('/:id/commands', requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;
    // Verify access: collaborator or public sketch
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
    const commands = await prisma.command.findMany({
      where: { sketchId: id },
      orderBy: { ts: 'asc' },
    });
    res.json(commands.map(cmd => ({
      ...cmd,
      ts: cmd.ts.getTime(),
      data: JSON.parse(cmd.data),
    })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST (save) commands for a specific sketch
router.post('/:id/commands', requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;
    // Verify write access: must be a collaborator (owner or collaborator role)
    const collab = await prisma.sketchCollaborator.findUnique({
      where: { sketchId_userId: { sketchId: id, userId: req.userId } },
    });
    if (!collab) {
      res.status(403).json({ error: 'Write access denied' });
      return;
    }
    const newCommands = req.body; // Array of commands
    const commandsToCreate = newCommands.map((cmd: any) => ({
      id: cmd.id,
      ts: new Date(cmd.ts),
      uid: req.userId,
      type: cmd.type,
      sid: cmd.sid,
      data: JSON.stringify(cmd.data),
      sketchId: id,
    }));
    await prisma.command.createMany({
      data: commandsToCreate,
    });
    res.status(201).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
