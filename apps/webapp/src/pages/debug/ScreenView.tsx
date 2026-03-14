import type { RefObject } from 'react';

import { Panel } from '../../components/Panel';

interface ScreenViewProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
}

export function ScreenView({ canvasRef }: ScreenViewProps) {
  return (
    <Panel title="Screen" className="h-full" scroll={false} contentClassName="p-2">
      <canvas
        ref={canvasRef}
        className="[image-rendering:pixelated] block w-full"
        style={{ aspectRatio: '240 / 160' }}
      />
    </Panel>
  );
}
