import type { EmulatorBridge } from '@gba-kit/gba-browser';
import { useEmulatorCanvas, useEmulatorKeyboard } from '@gba-kit/gba-react';

interface CanvasGBAProps {
  emulator: EmulatorBridge;
}

export function CanvasGBA({ emulator }: CanvasGBAProps) {
  const canvasRef = useEmulatorCanvas(emulator);
  useEmulatorKeyboard(emulator);

  return (
    <div className="flex flex-col items-center">
      <div className="bg-slate-800 rounded-xl p-4 shadow-xl border border-slate-700">
        <canvas ref={canvasRef} className="[image-rendering:pixelated] block" style={{ width: 720, height: 480 }} />
      </div>
    </div>
  );
}
