import { useEffect } from 'react';

interface DialogProps {
  open: boolean;
  onClose?: () => void;
  children: React.ReactNode;
}

export const Dialog = ({ open, onClose, children }: DialogProps) => {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-default-1 rounded-xl border border-default-3 shadow-2xl w-full max-w-sm"
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};

export const DialogHeader = ({ children }: { children: React.ReactNode }) => (
  <div className="px-6 pt-6 pb-2">
    <h2 className="text-lg font-semibold">{children}</h2>
  </div>
);

export const DialogBody = ({ children }: { children: React.ReactNode }) => (
  <div className="px-6 py-2">{children}</div>
);

export const DialogFooter = ({ children }: { children: React.ReactNode }) => (
  <div className="px-6 pb-6 pt-4 flex gap-3 justify-end">{children}</div>
);
