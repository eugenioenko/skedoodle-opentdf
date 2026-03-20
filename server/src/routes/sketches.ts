import { Router } from 'express';
import { requireAuth } from '../utils/auth';
import { prisma } from '../prisma';
import { opentdfService } from '../services/opentdf.service';

const router = Router();

const sketchSelect = {
  id: true, name: true, color: true, positionX: true, positionY: true,
  zoom: true, createdAt: true, updatedAt: true, ownerId: true,
} as const;

// GET all sketches for the authenticated user (owned + ABAC-granted)
router.get('/', requireAuth, async (req: any, res) => {
  try {
    const [ownedSketches, abacSketchIds] = await Promise.all([
      prisma.sketch.findMany({
        where: { ownerId: req.userId },
        select: { ...sketchSelect, owner: { select: { username: true } } },
        orderBy: { updatedAt: 'desc' },
      }),
      opentdfService.listSketchIdsForUser(req.username),
    ]);

    const ownedIds = new Set(ownedSketches.map(s => s.id));
    const sharedIds = abacSketchIds.filter(id => !ownedIds.has(id));

    let sharedSketches: typeof ownedSketches = [];
    if (sharedIds.length > 0) {
      sharedSketches = await prisma.sketch.findMany({
        where: { id: { in: sharedIds } },
        select: { ...sketchSelect, owner: { select: { username: true } } },
        orderBy: { updatedAt: 'desc' },
      });
    }

    const result = [
      ...ownedSketches.map(s => ({
        ...s,
        role: 'owner' as const,
        ownerName: s.owner.username,
        owner: undefined,
      })),
      ...sharedSketches.map(s => ({
        ...s,
        role: 'collaborator' as const,
        ownerName: s.owner.username,
        owner: undefined,
      })),
    ].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    res.json(result);
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
      },
    });
    // Register sketch attribute value + create owner subject mapping
    try {
      await opentdfService.ensureSketchAttributeValue(newSketch.id);
      await opentdfService.createSubjectMapping(req.username, newSketch.id);
    } catch (err) {
      console.warn(`[OpenTDF] Failed to set up ABAC for sketch ${newSketch.id}:`, err);
    }
    res.status(201).json(newSketch);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET a specific sketch's metadata
router.get('/:id', requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;

    // ABAC gate
    const abacAllowed = await opentdfService.checkAccess(req.username, id);
    if (!abacAllowed) {
      res.status(403).json({ error: 'Access denied by policy' });
      return;
    }

    const sketch = await prisma.sketch.findFirst({
      where: { id },
      select: {
        ...sketchSelect,
        owner: { select: { username: true } },
      },
    });
    if (!sketch) {
      res.status(404).json({ error: 'Sketch not found' });
      return;
    }

    // Get collaborators from OpenTDF
    const mappings = await opentdfService.listSubjectMappingsForSketch(id);
    const collaborators = mappings.map(m => ({
      username: m.username,
      role: m.username === sketch.owner.username ? 'owner' : 'collaborator',
    }));

    const isOwner = sketch.ownerId === req.userId;
    res.json({
      ...sketch,
      role: isOwner ? 'owner' : 'collaborator',
      ownerName: sketch.owner.username,
      owner: undefined,
      collaborators,
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
    const updatedSketch = await prisma.sketch.update({
      where: { id, ownerId: req.userId },
      data: {
        ...(name !== undefined && { name }),
        ...(color !== undefined && { color }),
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
    // ABAC gate
    const abacAllowed = await opentdfService.checkAccess(req.username, id);
    if (!abacAllowed) {
      res.status(403).json({ error: 'Access denied by policy' });
      return;
    }
    const sketch = await prisma.sketch.findFirst({
      where: { id },
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
    // ABAC gate — all ABAC-permitted users can write (owner or collaborator)
    const abacAllowed = await opentdfService.checkAccess(req.username, id);
    if (!abacAllowed) {
      res.status(403).json({ error: 'Write access denied' });
      return;
    }
    const newCommands = req.body;
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
