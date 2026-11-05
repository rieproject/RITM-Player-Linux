import workletUrl from './worklet.ts?worker&url';
import type { DspSettings, DspStats } from './pipeline';

export interface DspNode {
  node: AudioWorkletNode;
  setSettings(s: DspSettings): void;
  reset(): void;
  onStats(cb: (s: DspStats) => void): void;
}

/** Muat AudioWorklet "ritm-dsp" ke konteks lalu buat node stereo float32. */
export async function createDspNode(ctx: AudioContext, settings: DspSettings): Promise<DspNode> {
  await ctx.audioWorklet.addModule(workletUrl);
  const node = new AudioWorkletNode(ctx, 'ritm-dsp', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
  let cb: ((s: DspStats) => void) | null = null;
  node.port.onmessage = (e: MessageEvent<{ type: string; stats: DspStats }>) => {
    if (e.data?.type === 'stats') cb?.(e.data.stats);
  };
  node.port.postMessage({ type: 'settings', settings });
  return {
    node,
    setSettings: (s) => node.port.postMessage({ type: 'settings', settings: s }),
    reset: () => node.port.postMessage({ type: 'reset' }),
    onStats: (f) => {
      cb = f;
    },
  };
}
