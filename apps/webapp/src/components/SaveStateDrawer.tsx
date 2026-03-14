import {
  type EmulatorBridge,
  type SaveStateMeta,
  computeRomHash,
  deleteState,
  listByRom,
  loadState,
  renameState,
  saveState,
} from '@gba-kit/gba-browser';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';

import { SaveSlotCard } from './SaveSlotCard';

interface SaveStateDrawerProps {
  emulator: EmulatorBridge;
  romData: ArrayBuffer | null;
}

export function SaveStateDrawer({ emulator, romData }: SaveStateDrawerProps) {
  const [expanded, setExpanded] = useState(false);
  const [saves, setSaves] = useState<SaveStateMeta[]>([]);
  const [romHash, setRomHash] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveCountRef = useRef(0);

  // Compute ROM hash when ROM changes
  useEffect(() => {
    if (!romData) {
      setRomHash(null);
      setSaves([]);
      return;
    }
    computeRomHash(romData).then(setRomHash);
  }, [romData]);

  // Load save list when hash changes or drawer expands
  const refreshList = useCallback(async () => {
    if (!romHash) {
      return;
    }
    const list = await listByRom(romHash);
    setSaves(list);
  }, [romHash]);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  const handleSave = useCallback(async () => {
    if (!romHash || saving) {
      return;
    }
    setSaving(true);
    try {
      saveCountRef.current++;
      const { snapshot, thumbnail } = await emulator.saveState();
      await saveState(romHash, snapshot, thumbnail, `Save #${saveCountRef.current}`);
      await refreshList();
      setExpanded(true);
    } finally {
      setSaving(false);
    }
  }, [emulator, romHash, refreshList, saving]);

  const handleLoad = useCallback(
    async (id: number) => {
      const record = await loadState(id);
      if (record) {
        emulator.loadState(record.snapshot);
      }
    },
    [emulator],
  );

  const handleDelete = useCallback(
    async (id: number) => {
      await deleteState(id);
      await refreshList();
    },
    [refreshList],
  );

  const handleRename = useCallback(
    async (id: number, label: string) => {
      await renameState(id, label);
      await refreshList();
    },
    [refreshList],
  );

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+S / Cmd+S -> quick save
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && !e.shiftKey) {
        e.preventDefault();
        handleSave();
        return;
      }
      // Ctrl+Shift+S -> save to new slot (same as quick save here)
      if ((e.ctrlKey || e.metaKey) && e.key === 'S' && e.shiftKey) {
        e.preventDefault();
        handleSave();
        return;
      }
      // F5 -> quick save
      if (e.key === 'F5') {
        e.preventDefault();
        handleSave();
        return;
      }
      // F9 -> quick load (most recent)
      if (e.key === 'F9') {
        e.preventDefault();
        if (saves.length > 0) {
          handleLoad(saves[0]!.id);
        }
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave, handleLoad, saves]);

  if (!romData) {
    return null;
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50">
      {/* Toggle bar */}
      <button
        className="w-full bg-zinc-900 border-t border-zinc-700 px-4 py-1.5 flex items-center justify-between text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span>Save States ({saves.length})</span>
        <span className={clsx('transition-transform', expanded && 'rotate-180')}>&#9650;</span>
      </button>

      {/* Expanded drawer */}
      {expanded && (
        <div className="bg-zinc-900 border-t border-zinc-700 px-4 py-3 h-50 overflow-hidden">
          <div className="flex gap-3 h-full overflow-x-auto items-start">
            {/* New Save button */}
            <button
              className="shrink-0 w-30 h-20 border-2 border-dashed border-zinc-600 rounded flex items-center justify-center text-zinc-500 hover:border-sky-500 hover:text-sky-400 transition-colors disabled:opacity-50"
              onClick={handleSave}
              disabled={saving}
              title="Create new save (Ctrl+S)"
            >
              <span className="text-2xl">+</span>
            </button>

            {/* Save slot cards */}
            {saves.map((meta) => (
              <SaveSlotCard
                key={meta.id}
                meta={meta}
                onLoad={handleLoad}
                onDelete={handleDelete}
                onRename={handleRename}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
