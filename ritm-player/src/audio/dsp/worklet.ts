// AudioWorkletProcessor "ritm-dsp": bus float32 RITM (Analog Stage → Peak Guard).
// Berjalan di thread audio browser; tidak ada alokasi memori per blok setelah awal.
import { DspPipeline, type DspSettings } from './pipeline';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

type Msg = { type: 'settings'; settings: DspSettings } | { type: 'reset' };

class RitmDspProcessor extends AudioWorkletProcessor {
  private dsp = new DspPipeline(sampleRate, 2);
  private blocks = 0;
  private readonly statEvery = Math.max(1, Math.round(sampleRate / 128 / 5)); // ± 5× per detik

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Msg>) => {
      const m = e.data;
      if (m.type === 'settings') this.dsp.settings = { ...m.settings };
      else if (m.type === 'reset') this.dsp.reset();
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    if (!input || input.length === 0) {
      for (const ch of output) ch.fill(0);
    } else if (input.length >= output.length) {
      this.dsp.process(input.slice(0, output.length), output);
    } else {
      // sumber mono → keluaran stereo: proses kanal yang ada, salin ke kanal sisanya
      this.dsp.process(input, output.slice(0, input.length));
      for (let c = input.length; c < output.length; c++) output[c]!.set(output[0]!);
    }
    if (++this.blocks % this.statEvery === 0) this.port.postMessage({ type: 'stats', stats: this.dsp.stats() });
    return true;
  }
}

registerProcessor('ritm-dsp', RitmDspProcessor);
