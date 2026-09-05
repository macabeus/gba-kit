import type { Session } from '@gba-kit/debug-core';
import { useMemo } from 'react';

import { Panel } from '../../components/Panel';

interface RegisterViewProps {
  session: Session;
  revision: number;
}

/** The registers as the session's inspector names them: `lr`/`pc` symbolized, `cpsr` decoded. */
export function RegisterView({ session, revision }: RegisterViewProps) {
  // `revision` is the cache key: the machine moved, or a label changed
  const nodes = useMemo(
    () => (session.state === 'stopped' ? (session.scopes(0).find((s) => s.kind === 'registers')?.nodes ?? []) : []),
    [session, revision],
  );

  return (
    <Panel
      title="Registers"
      className="h-full"
      contentClassName="font-mono text-[13px] leading-[1.4] text-xs space-y-0.5 px-2 py-1"
    >
      {nodes.length === 0 ? (
        <div className="text-slate-600 px-1 py-2">{session.state === 'running' ? 'running…' : 'no registers'}</div>
      ) : (
        nodes.map((node) => (
          <div key={node.name} className="flex justify-between gap-2 px-1 py-0.5 rounded hover:bg-slate-700/50">
            <span className="text-slate-400 w-10 shrink-0">{node.name}</span>
            <span className="text-slate-200 truncate">{node.value}</span>
          </div>
        ))
      )}
    </Panel>
  );
}
