import type { SaveStateMeta } from '@gba-kit/gba-browser';
import { useEffect, useRef, useState } from 'react';

function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface SaveSlotCardProps {
  meta: SaveStateMeta;
  onLoad: (id: number) => void;
  onDelete: (id: number) => void;
  onRename: (id: number, label: string) => void;
}

export function SaveSlotCard({ meta, onLoad, onDelete, onRename }: SaveSlotCardProps) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editLabel, setEditLabel] = useState(meta.label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const url = URL.createObjectURL(meta.thumbnail);
    setThumbUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [meta.thumbnail]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const handleCommitRename = () => {
    setEditing(false);
    if (editLabel.trim() && editLabel !== meta.label) {
      onRename(meta.id, editLabel.trim());
    } else {
      setEditLabel(meta.label);
    }
  };

  return (
    <div
      className="shrink-0 w-30 cursor-pointer group relative"
      onClick={() => {
        if (!editing) {
          onLoad(meta.id);
        }
      }}
    >
      {/* Thumbnail */}
      <div className="w-30 h-20 bg-black rounded overflow-hidden border border-zinc-700 group-hover:border-sky-500 transition-colors">
        {thumbUrl && (
          <img src={thumbUrl} alt={meta.label} className="w-full h-full" style={{ imageRendering: 'pixelated' }} />
        )}
      </div>

      {/* Label */}
      <div className="mt-1 px-0.5">
        {editing ? (
          <input
            ref={inputRef}
            className="w-full bg-zinc-800 text-xs text-zinc-200 border border-zinc-600 rounded px-1 py-0.5"
            value={editLabel}
            onChange={(e) => setEditLabel(e.target.value)}
            onBlur={handleCommitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleCommitRename();
              }
              if (e.key === 'Escape') {
                setEditing(false);
                setEditLabel(meta.label);
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div
            className="text-xs text-zinc-400 truncate"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            {meta.label}
          </div>
        )}
        <div className="text-[10px] text-zinc-600">{formatRelativeTime(meta.timestamp)}</div>
      </div>

      {/* Delete button */}
      <button
        className="absolute top-1 right-1 w-5 h-5 rounded bg-black/60 text-zinc-400 hover:text-red-400 text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(meta.id);
        }}
        title="Delete save"
      >
        x
      </button>
    </div>
  );
}
