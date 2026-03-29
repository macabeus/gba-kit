import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import clsx from 'clsx';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import type { DecompFunction } from './mizuchi-db';

export type CodeAtlasNodeData = {
  fn: DecompFunction;
  isActive: boolean;
  pc: number;
};

export type CodeAtlasNodeType = Node<CodeAtlasNodeData, 'codeAtlas'>;

/**
 * Given the assembly text and a PC offset into the function,
 * return the 0-based line index that corresponds to the current instruction.
 *
 * Assumes Thumb mode (ARMv4T) instruction encoding:
 * - `.word` → 4 bytes, `.hword` → 2 bytes
 * - `bl`/`blx` (long branch with link) → 4 bytes (two 16-bit half-words)
 * - all other instructions → 2 bytes
 * - empty/whitespace lines → 0 bytes
 *
 * ARM-mode functions (4 bytes per instruction) are not supported.
 * This is acceptable for GBA where nearly all game code is Thumb.
 */
function computeActiveLine(asmCode: string, romAddress: number, pc: number): number | null {
  if (pc < romAddress) return null;
  const targetOffset = pc - romAddress;

  const lines = asmCode.split('\n');
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trimStart();
    if (stripped === '') continue;

    // Strip leading digits — these are objdiff label markers (e.g. "16ldrb"), not byte offsets
    const mnemonic = stripped.replace(/^\d+/, '').trimStart();

    let size: number;
    if (mnemonic.startsWith('.word')) {
      size = 4;
    } else if (mnemonic.startsWith('.hword')) {
      size = 2;
    } else if (/^blx?\s/.test(mnemonic)) {
      size = 4;
    } else {
      size = 2;
    }

    // Match if PC is anywhere within this instruction's byte range
    if (targetOffset >= offset && targetOffset < offset + size) return i;

    offset += size;
  }

  return null;
}

// ─── Collapsible section ─────────────────────────────────────────────

function CollapsibleSection({
  label,
  pathLabel,
  open,
  onToggle,
  children,
}: {
  label: string;
  pathLabel?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-slate-700/60 last:border-b-0">
      <button
        type="button"
        className="nodrag nopan w-full flex items-center gap-1 px-3 py-1 text-[10px] text-slate-400 hover:text-slate-300 transition-colors"
        onClick={onToggle}
      >
        <span className={clsx('transition-transform', open && 'rotate-90')}>&#9656;</span>
        {label}
        {pathLabel && <span className="text-slate-600 ml-auto">{pathLabel}</span>}
      </button>
      {open && children}
    </div>
  );
}

// ─── Node component ──────────────────────────────────────────────────

function CodeAtlasNodeInner({ data }: NodeProps<CodeAtlasNodeType>) {
  const { fn, isActive, pc } = data;
  const hasC = !!fn.cCode;
  const [asmOpen, setAsmOpen] = useState(isActive);
  const [cOpen, setCOpen] = useState(isActive && hasC);
  const activeLineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isActive) {
      setAsmOpen(true);
      if (hasC) setCOpen(true);
    }
  }, [isActive, hasC]);

  const activeLine = useMemo(() => {
    if (!isActive || fn.romAddress === undefined) return null;
    return computeActiveLine(fn.asmCode, fn.romAddress, pc);
  }, [isActive, fn.romAddress, fn.asmCode, pc]);

  useEffect(() => {
    if (activeLine !== null && activeLineRef.current) {
      activeLineRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [activeLine]);

  const asmLines = useMemo(() => fn.asmCode.split('\n'), [fn.asmCode]);

  return (
    <div
      className={clsx(
        'rounded-lg border bg-slate-800/95 shadow-lg w-[380px]',
        isActive ? 'border-sky-500 ring-1 ring-sky-500/40' : hasC ? 'border-slate-600' : 'border-slate-700',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-500 !w-2 !h-2 !border-0" />

      {/* Header */}
      <div
        className={clsx(
          'flex items-center justify-between px-3 py-1.5 border-b rounded-t-lg',
          isActive ? 'border-sky-500/40 bg-sky-500/10' : 'border-slate-700 bg-slate-800',
        )}
      >
        <span className="text-xs font-medium text-slate-200 truncate">{fn.name}</span>
        <div className="flex gap-1 ml-2 shrink-0">
          {hasC && (
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">C</span>
          )}
          <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-slate-600/60 text-slate-400">ASM</span>
        </div>
      </div>

      <CollapsibleSection
        label="Assembly"
        pathLabel={fn.asmModulePath}
        open={asmOpen}
        onToggle={() => setAsmOpen(!asmOpen)}
      >
        <div className="nodrag nopan nowheel px-1 pb-2 overflow-auto max-h-[140px] font-mono text-[10px] leading-[1.5]">
          {asmLines.map((line, i) => {
            const isCurrent = i === activeLine;
            return (
              <div
                key={i}
                ref={isCurrent ? activeLineRef : undefined}
                className={clsx('px-2 whitespace-pre', isCurrent ? 'bg-sky-500/20 text-sky-200' : 'text-slate-300')}
              >
                {line || '\u00A0'}
              </div>
            );
          })}
        </div>
      </CollapsibleSection>

      {hasC && (
        <CollapsibleSection label="C Code" pathLabel={fn.cModulePath} open={cOpen} onToggle={() => setCOpen(!cOpen)}>
          <pre className="nodrag nopan nowheel px-3 pb-2 text-[10px] leading-[1.5] text-green-300/80 font-mono overflow-auto max-h-[140px] whitespace-pre">
            {fn.cCode}
          </pre>
        </CollapsibleSection>
      )}

      <Handle type="source" position={Position.Bottom} className="!bg-slate-500 !w-2 !h-2 !border-0" />
    </div>
  );
}

export const CodeAtlasNode = memo(CodeAtlasNodeInner, (prev, next) => {
  return prev.data.fn === next.data.fn && prev.data.isActive === next.data.isActive && prev.data.pc === next.data.pc;
});
