import { useState, useEffect } from 'react';
import { storageClient, Collaborator } from '@/services/storage.client';
import { useSyncStore } from '@/sync/sync.store';
import { useAuthStore } from '@/stores/auth.store';
import { IconUserPlus, IconTrash, IconCrown, IconX } from '@tabler/icons-react';
import { Dialog, DialogHeader, DialogBody } from './ui/dialog';

export const ShareDialog = ({
  sketchId,
  onClose,
}: {
  sketchId: string;
  onClose: () => void;
}) => {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const role = useSyncStore(s => s.role);
  const currentUserId = useAuthStore(s => s.user?.id);
  const isOwner = role === 'owner';

  useEffect(() => {
    loadCollaborators();
  }, [sketchId]);

  async function loadCollaborators() {
    const collabs = await storageClient.getCollaborators(sketchId);
    setCollaborators(collabs);
  }

  async function handleInvite() {
    if (!username.trim()) return;
    setError('');
    setLoading(true);
    try {
      await storageClient.addCollaborator(sketchId, username.trim());
      setUsername('');
      loadCollaborators();
    } catch (err: any) {
      setError(err.message || 'Failed to invite user');
    } finally {
      setLoading(false);
    }
  }

  async function handleRemove(userId: string) {
    try {
      await storageClient.removeCollaborator(sketchId, userId);
      loadCollaborators();
    } catch (err: any) {
      setError(err.message || 'Failed to remove collaborator');
    }
  }

  return (
    <Dialog open onClose={onClose}>
      <div className="flex items-center justify-between px-6 pt-6 pb-2">
        <h2 className="text-lg font-semibold">Share Sketch</h2>
        <button onClick={onClose} className="p-1 rounded hover:bg-default-3">
          <IconX size={18} stroke={2} />
        </button>
      </div>
      <DialogBody>
        {isOwner && (
          <div className="mb-4">
            <div className="flex gap-2">
              <input
                className="flex-grow bg-default-2 border border-default-3 rounded-lg px-3 py-2 text-sm outline-none focus:border-primary"
                placeholder="Enter username..."
                value={username}
                onChange={e => { setUsername(e.target.value); setError(''); }}
                onKeyDown={e => e.key === 'Enter' && handleInvite()}
                disabled={loading}
              />
              <button
                onClick={handleInvite}
                disabled={loading || !username.trim()}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-text-primary text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                <IconUserPlus size={16} stroke={2} />
                Invite
              </button>
            </div>
            {error && <p className="text-red-400 text-xs mt-1.5">{error}</p>}
          </div>
        )}

        <div className="space-y-2 max-h-60 overflow-y-auto pb-4">
          {collaborators.map(c => (
            <div key={c.userId} className="flex items-center justify-between px-3 py-2 rounded-lg bg-default-2">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center text-xs font-medium">
                  {c.username.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <span className="text-sm font-medium">{c.username}</span>
                  {c.userId === currentUserId && (
                    <span className="text-xs text-text-secondary ml-1">(you)</span>
                  )}
                </div>
                {c.role === 'owner' && (
                  <IconCrown size={14} stroke={1.5} className="text-yellow-500" />
                )}
              </div>
              {c.role !== 'owner' && (isOwner || c.userId === currentUserId) && (
                <button
                  onClick={() => handleRemove(c.userId)}
                  className="p-1 rounded text-text-secondary hover:bg-red-500/10 hover:text-red-400 transition-colors"
                  title={c.userId === currentUserId ? 'Leave sketch' : 'Remove collaborator'}
                >
                  <IconTrash size={14} stroke={1.5} />
                </button>
              )}
            </div>
          ))}
        </div>
      </DialogBody>
    </Dialog>
  );
};
