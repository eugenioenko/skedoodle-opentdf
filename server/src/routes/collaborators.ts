import { Router } from 'express';
import { requireAuth } from '../utils/auth';
import { prisma } from '../prisma';
import { getRooms } from '../ws-server';
import { opentdfService } from '../services/opentdf.service';

const router = Router();

// GET collaborators for a sketch
router.get('/:id/collaborators', requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;
    // ABAC gate
    const abacAllowed = await opentdfService.checkAccess(req.username, id);
    if (!abacAllowed) {
      res.status(403).json({ error: 'Access denied by policy' });
      return;
    }

    // Get collaborators from OpenTDF subject mappings
    const mappings = await opentdfService.listSubjectMappingsForSketch(id);

    // Get owner username from DB
    const sketch = await prisma.sketch.findUnique({
      where: { id },
      select: { owner: { select: { username: true } } },
    });
    const ownerUsername = sketch?.owner.username;

    const collaborators = mappings.map(m => ({
      username: m.username,
      role: m.username === ownerUsername ? 'owner' : 'collaborator',
    }));

    res.json(collaborators);
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
    const sketch = await prisma.sketch.findUnique({
      where: { id },
      select: { ownerId: true },
    });
    if (!sketch || sketch.ownerId !== req.userId) {
      res.status(403).json({ error: 'Only the owner can invite collaborators' });
      return;
    }
    if (username === req.username) {
      res.status(400).json({ error: 'Cannot invite yourself' });
      return;
    }
    // Ensure attribute value exists + create subject mapping
    await opentdfService.ensureSketchAttributeValue(id);
    const mappingId = await opentdfService.createSubjectMapping(username, id);
    if (!mappingId) {
      res.status(500).json({ error: 'Failed to create access grant' });
      return;
    }

    res.status(201).json({
      username,
      role: 'collaborator',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE remove a collaborator or leave (by username)
router.delete('/:id/collaborators/:username', requireAuth, async (req: any, res) => {
  try {
    const { id, username: targetUsername } = req.params;

    // Get sketch owner
    const sketch = await prisma.sketch.findUnique({
      where: { id },
      select: { ownerId: true, owner: { select: { username: true } } },
    });
    if (!sketch) {
      res.status(404).json({ error: 'Sketch not found' });
      return;
    }

    // Cannot remove the owner
    if (targetUsername === sketch.owner.username) {
      res.status(403).json({ error: 'Cannot remove the sketch owner' });
      return;
    }

    const isSelf = targetUsername === req.username;
    const isOwner = sketch.ownerId === req.userId;

    if (!isSelf && !isOwner) {
      res.status(403).json({ error: 'Only the owner can remove collaborators' });
      return;
    }

    // Find and delete the subject mapping
    const mappingId = await opentdfService.findSubjectMappingId(targetUsername, id);
    if (mappingId) {
      await opentdfService.deleteSubjectMapping(mappingId);
    }

    // Kick from active WebSocket room if connected
    const rooms = getRooms();
    const room = rooms.get(id);
    if (room) {
      room.kickClientByUsername(targetUsername);
    }

    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
