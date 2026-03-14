import { useCallback, useRef } from 'react';

import { StartBalatroGBA } from './StartBalatroGBA';

interface LoadViewProps {
  loading: boolean;
  onRomLoad: (data: ArrayBuffer) => void;
}

export function LoadView({ loading, onRomLoad }: LoadViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) {
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          onRomLoad(reader.result);
        }
      };
      reader.readAsArrayBuffer(file);
    },
    [onRomLoad],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (!file) {
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          onRomLoad(reader.result);
        }
      };
      reader.readAsArrayBuffer(file);
    },
    [onRomLoad],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[70vh]">
        <div className="text-center">
          <div className="w-12 h-12 mx-auto mb-4 border-4 border-slate-600 border-t-sky-400 rounded-full animate-spin" />
          <h2 className="text-xl font-bold text-white mb-2">Loading ROM from server...</h2>
          <p className="text-slate-400">Configured via server</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] gap-8">
      <div
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        className="w-full max-w-lg p-12 text-center rounded-2xl border-2 border-dashed border-slate-600 bg-slate-800/50 hover:border-slate-500 hover:bg-slate-800/70 transition-all cursor-pointer"
        onClick={() => fileInputRef.current?.click()}
      >
        <svg className="w-16 h-16 mx-auto text-slate-500 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
          />
        </svg>
        <h2 className="text-xl font-bold text-white mb-2">Load GBA ROM</h2>
        <p className="text-slate-400 mb-4">Drop a .gba file here or click to browse</p>
        <button
          type="button"
          className="px-6 py-2 bg-linear-to-r from-sky-500 to-cyan-500 text-white font-medium rounded-lg hover:from-sky-600 hover:to-cyan-600 transition-all"
          onClick={(e) => {
            e.stopPropagation();
            fileInputRef.current?.click();
          }}
        >
          Choose File
        </button>
        <input ref={fileInputRef} type="file" accept=".gba,.bin" onChange={handleFileChange} className="hidden" />
      </div>

      <StartBalatroGBA onRomLoad={onRomLoad} />
    </div>
  );
}
