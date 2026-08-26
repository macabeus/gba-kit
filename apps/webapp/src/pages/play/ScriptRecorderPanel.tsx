import type { EmulatorBridge } from '@gba-kit/gba-browser';
import { computeRomHash } from '@gba-kit/gba-browser';
import type { GbaSnapshot } from '@gba-kit/gba-emulator/savestate';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type InputRecorder,
  type InputSegment,
  type ReplayDebugState,
  type ReplayMode,
  type ScriptMeta,
  type ScriptParseError,
  type ScriptWithMapping,
  deleteScript,
  listScriptsByRom,
  loadScriptRecord,
  parseScript,
  replayVisual,
  saveScript,
  serializeToScript,
  serializeToScriptWithMapping,
} from '../../scripting';
import { ScriptEditorView } from './ScriptEditorView';

interface ScriptRecorderPanelProps {
  recorder: InputRecorder;
  emulator: EmulatorBridge;
  romData: ArrayBuffer | null;
  onStartRecording: () => void;
  onStopRecording: () => void;
}

function formatTime(frames: number): string {
  const seconds = frames / 59.7275;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(1).padStart(4, '0')}`;
}

export function ScriptRecorderPanel({
  recorder,
  emulator,
  romData,
  onStartRecording,
  onStopRecording,
}: ScriptRecorderPanelProps) {
  const [, forceRender] = useState(0);
  const [scriptMapping, setScriptMapping] = useState<ScriptWithMapping | null>(null);
  const [segments, setSegments] = useState<InputSegment[] | null>(null);
  const [snapshot, setSnapshot] = useState<GbaSnapshot | null>(null);
  const [romHash, setRomHash] = useState<string | null>(null);
  const [savedScripts, setSavedScripts] = useState<ScriptMeta[]>([]);
  const [replayMode, setReplayMode] = useState<ReplayMode>('from-start');
  const [replayDebug, setReplayDebug] = useState<ReplayDebugState | null>(null);
  const [copied, setCopied] = useState(false);
  const [loadedFileName, setLoadedFileName] = useState<string | null>(null);
  const [parseErrors, setParseErrors] = useState<ScriptParseError[] | null>(null);
  const replayCancelRef = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const saveCountRef = useRef(0);

  // Compute ROM hash
  useEffect(() => {
    if (!romData) {
      setRomHash(null);
      return;
    }
    computeRomHash(romData).then(setRomHash);
  }, [romData]);

  // Load saved scripts list
  const refreshScripts = useCallback(async () => {
    if (!romHash) {
      return;
    }
    const list = await listScriptsByRom(romHash);
    setSavedScripts(list);
  }, [romHash]);

  useEffect(() => {
    refreshScripts();
  }, [refreshScripts]);

  // Poll recorder state during recording for live updates
  useEffect(() => {
    if (recorder.state !== 'recording') {
      return;
    }
    const id = setInterval(() => forceRender((n) => n + 1), 200);
    return () => clearInterval(id);
  }, [recorder.state]);

  const handleStartRecording = useCallback(async () => {
    const { snapshot: snap } = await emulator.saveState();
    setSnapshot(snap);
    setScriptMapping(null);
    setSegments(null);
    setLoadedFileName(null);
    setParseErrors(null);
    onStartRecording();
  }, [emulator, onStartRecording]);

  /**
   * Load a script from disk and make it replayable. The file's own text is
   * what gets shown — parseScript reports the line each segment came from, so
   * replay can still highlight it without normalising the user's formatting.
   *
   * A loaded script carries no snapshot, so it replays from the current state.
   */
  const handleLoadFile = useCallback(async (file: File) => {
    const text = await file.text();
    const result = parseScript(text);

    if (!result.ok) {
      setParseErrors(result.errors);
      setScriptMapping(null);
      setSegments(null);
      setLoadedFileName(file.name);
      return;
    }

    setParseErrors(null);
    setLoadedFileName(file.name);
    setSnapshot(null);
    setReplayMode('from-current');
    setReplayDebug(null);
    setSegments(result.segments);
    setScriptMapping({
      text,
      lines: text.split('\n'),
      segmentToLine: result.segmentLines,
    });
  }, []);

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        handleLoadFile(file);
      }
      // Reset so picking the same file again still fires a change event.
      event.target.value = '';
    },
    [handleLoadFile],
  );

  const handleStopRecording = useCallback(() => {
    onStopRecording();
    const segs = recorder.segments;
    setSegments(segs);
    setScriptMapping(serializeToScriptWithMapping(segs));
  }, [recorder, onStopRecording]);

  const handleReset = useCallback(() => {
    setScriptMapping(null);
    setSegments(null);
    setSnapshot(null);
    setReplayDebug(null);
    setLoadedFileName(null);
    setParseErrors(null);
  }, []);

  const handleCopy = useCallback(() => {
    if (!scriptMapping) {
      return;
    }
    navigator.clipboard.writeText(scriptMapping.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [scriptMapping]);

  const handleDownload = useCallback(() => {
    if (!scriptMapping) {
      return;
    }
    const blob = new Blob([scriptMapping.text], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recording.mjs';
    a.click();
    URL.revokeObjectURL(url);
  }, [scriptMapping]);

  const handleSave = useCallback(async () => {
    if (!scriptMapping || !romHash || !snapshot) {
      return;
    }
    saveCountRef.current++;
    await saveScript(romHash, scriptMapping.text, snapshot, `Recording #${saveCountRef.current}`);
    await refreshScripts();
  }, [scriptMapping, romHash, snapshot, refreshScripts]);

  const handleDeleteScript = useCallback(
    async (id: number) => {
      await deleteScript(id);
      await refreshScripts();
    },
    [refreshScripts],
  );

  const isReplaying = replayDebug?.running ?? false;

  const handleReplay = useCallback(() => {
    if (!segments || isReplaying) {
      return;
    }

    const replaySnapshot = replayMode === 'from-start' ? snapshot : null;
    const { cancel } = replayVisual(emulator, segments, replaySnapshot, replayMode, setReplayDebug, () =>
      setReplayDebug((prev) => (prev ? { ...prev, running: false } : null)),
    );
    replayCancelRef.current = cancel;
  }, [segments, snapshot, replayMode, emulator, isReplaying]);

  const handleReplaySaved = useCallback(
    async (id: number) => {
      if (isReplaying) {
        return;
      }
      const record = await loadScriptRecord(id);
      if (!record) {
        return;
      }
      emulator.loadState(record.snapshot);
    },
    [emulator, isReplaying],
  );

  const handleCancelReplay = useCallback(() => {
    replayCancelRef.current?.();
    replayCancelRef.current = null;
    setReplayDebug(null);
  }, []);

  const recState = recorder.state;
  const isRecording = recState === 'recording';
  const isStopped = recState === 'stopped' || scriptMapping !== null;
  const livePreview = isRecording ? serializeToScript(recorder.liveSegments) : null;

  // Compute the highlighted line index from the current replay segment
  const highlightedLine =
    replayDebug && scriptMapping ? (scriptMapping.segmentToLine[replayDebug.segmentIndex] ?? -1) : -1;

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Header / Controls */}
      <div className="bg-slate-800/50 rounded-lg border border-slate-700">
        <div className="px-3 py-2 border-b border-slate-700">
          <div className="text-slate-500 text-[10px] uppercase tracking-wider">Script Recorder</div>
        </div>
        <div className="p-3">
          {/* Recording controls */}
          <div className="flex items-center gap-2">
            {isRecording ? (
              <button
                type="button"
                onClick={handleStopRecording}
                className="flex items-center gap-2 px-4 py-2 bg-red-500/20 text-red-300 border border-red-500/30 rounded-lg font-medium hover:bg-red-500/30 transition-all"
              >
                <span className="w-3 h-3 bg-red-500 rounded-sm" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStartRecording}
                disabled={isReplaying}
                className="flex items-center gap-2 px-4 py-2 bg-red-500/20 text-red-300 border border-red-500/30 rounded-lg font-medium hover:bg-red-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
                Record
              </button>
            )}

            {!isRecording && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".mjs,.js,.txt,text/javascript,text/plain"
                  onChange={handleFileChange}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isReplaying}
                  title="Load a script file and replay it"
                  className="flex items-center gap-2 px-4 py-2 bg-slate-700/50 text-slate-300 border border-slate-600 rounded-lg font-medium hover:bg-slate-600/50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m0-12l-4 4m4-4l4 4"
                    />
                  </svg>
                  Load
                </button>
              </>
            )}

            {isRecording && (
              <div className="text-sm text-slate-400 flex items-center gap-3">
                <span>{formatTime(recorder.totalFrames)}</span>
                <span>{recorder.totalInputs} inputs</span>
              </div>
            )}

            {isStopped && !isRecording && (
              <>
                {isReplaying && (
                  <button
                    type="button"
                    onClick={handleCancelReplay}
                    className="px-3 py-2 text-red-400 text-sm hover:text-red-300 transition-colors"
                  >
                    Cancel
                  </button>
                )}
                {!isReplaying && (
                  <button
                    type="button"
                    onClick={handleReset}
                    className="px-3 py-2 text-slate-400 text-sm hover:text-slate-200 transition-colors"
                  >
                    Clear
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Parse errors from a loaded file */}
      {parseErrors && (
        <div className="bg-red-500/10 rounded-lg border border-red-500/30">
          <div className="px-3 py-2 border-b border-red-500/30">
            <div className="text-red-300 text-[10px] uppercase tracking-wider">
              Could not load {loadedFileName ?? 'script'}
            </div>
          </div>
          <div className="p-3 flex flex-col gap-1">
            {parseErrors.map((err) => (
              <div key={`${err.line}-${err.message}`} className="text-xs text-red-200/90 font-mono">
                <span className="text-red-400">line {err.line}:</span> {err.message}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Live Preview (during recording) */}
      {isRecording && livePreview && (
        <div className="bg-slate-800/50 rounded-lg border border-slate-700">
          <div className="px-3 py-2 border-b border-slate-700">
            <div className="text-slate-500 text-[10px] uppercase tracking-wider">Live Preview</div>
          </div>
          <ScriptEditorView value={livePreview} highlightLine={-1} maxHeight="200px" />
        </div>
      )}

      {/* Script Output (after stop) — with line highlighting during replay */}
      {isStopped && !isRecording && scriptMapping && (
        <div className="bg-slate-800/50 rounded-lg border border-slate-700">
          <div className="px-3 py-2 border-b border-slate-700 flex items-center justify-between">
            <div className="text-slate-500 text-[10px] uppercase tracking-wider truncate">
              {loadedFileName ? `Loaded — ${loadedFileName}` : 'Recorded Script'}
            </div>
            <div className="text-xs text-slate-500 shrink-0 ml-2">{segments?.length ?? 0} segments</div>
          </div>
          <ScriptEditorView value={scriptMapping.text} highlightLine={highlightedLine} />
          <div className="px-3 py-2 border-t border-slate-700 flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="px-3 py-1.5 text-xs bg-slate-700/50 text-slate-300 border border-slate-600 rounded hover:bg-slate-600/50 transition-all"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="px-3 py-1.5 text-xs bg-slate-700/50 text-slate-300 border border-slate-600 rounded hover:bg-slate-600/50 transition-all"
            >
              Download
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!snapshot}
              title={snapshot ? undefined : 'A loaded script has no snapshot to save with it'}
              className="px-3 py-1.5 text-xs bg-sky-500/20 text-sky-300 border border-sky-500/30 rounded hover:bg-sky-500/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {/* Replay Controls (after stop) */}
      {isStopped && !isRecording && segments && segments.length > 0 && (
        <div className="bg-slate-800/50 rounded-lg border border-slate-700">
          <div className="px-3 py-2 border-b border-slate-700">
            <div className="text-slate-500 text-[10px] uppercase tracking-wider">Replay</div>
          </div>
          <div className="p-3">
            <div className="flex flex-col gap-2 mb-3">
              <label
                className={`flex items-center gap-2 text-sm ${
                  snapshot ? 'text-slate-300 cursor-pointer' : 'text-slate-500 cursor-not-allowed'
                }`}
                title={snapshot ? undefined : 'Only a recorded script carries the state it started from'}
              >
                <input
                  type="radio"
                  name="replayMode"
                  checked={replayMode === 'from-start'}
                  onChange={() => setReplayMode('from-start')}
                  disabled={!snapshot}
                  className="accent-sky-500"
                />
                From recording start
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input
                  type="radio"
                  name="replayMode"
                  checked={replayMode === 'from-current'}
                  onChange={() => setReplayMode('from-current')}
                  className="accent-sky-500"
                />
                From current state
              </label>
            </div>
            <button
              type="button"
              onClick={handleReplay}
              disabled={isReplaying}
              className="w-full px-4 py-2 bg-green-500/20 text-green-300 border border-green-500/30 rounded-lg font-medium hover:bg-green-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Replay
            </button>
          </div>
        </div>
      )}

      {/* Saved Scripts */}
      {savedScripts.length > 0 && (
        <div className="bg-slate-800/50 rounded-lg border border-slate-700">
          <div className="px-3 py-2 border-b border-slate-700">
            <div className="text-slate-500 text-[10px] uppercase tracking-wider">
              Saved Scripts ({savedScripts.length})
            </div>
          </div>
          <div className="max-h-50 overflow-y-auto">
            {savedScripts.map((meta) => (
              <div
                key={meta.id}
                className="flex items-center justify-between px-3 py-2 border-b border-slate-700/50 last:border-0 hover:bg-slate-700/30 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-300 truncate">{meta.label}</div>
                  <div className="text-[10px] text-slate-500">{new Date(meta.timestamp).toLocaleString()}</div>
                </div>
                <div className="flex items-center gap-1 ml-2">
                  <button
                    type="button"
                    onClick={() => handleReplaySaved(meta.id)}
                    className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-green-400 rounded hover:bg-slate-700/50 transition-colors"
                    title="Load snapshot"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M6.3 2.841A1.5 1.5 0 004 4.118v11.764a1.5 1.5 0 002.3 1.277l9.344-5.882a1.5 1.5 0 000-2.554L6.3 2.84z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteScript(meta.id)}
                    className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-red-400 rounded hover:bg-slate-700/50 transition-colors"
                    title="Delete"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
