/**
 * Analog Stage Emulation — karakter konsol/trafo yang sangat halus.
 * 1. Saturasi harmonik orde-2: y = x + k·x² (asimetris → hanya harmonik genap, dominan H2).
 *    Rasio H2/H1 = k·A/2 → dengan k = 0,0035, THD ≈ 0,175% pada 0 dBFS, makin kecil di level rendah.
 * 2. DC blocker (HPF 1 kutub, 2 Hz) untuk membuang offset DC dari suku x² (−0,04 dB di 20 Hz).
 * 3. All-pass orde-2 berpusat ± 80 Hz (Q 0,5): memutar fase low-end seperti trafo/konsol
 *    tanpa mengubah respons magnitudo; fase frekuensi tengah–tinggi kembali ke 0° (bukan terbalik).
 */
export const ANALOG_K = 0.0035;
export const ANALOG_ALLPASS_HZ = 80;
export const ANALOG_ALLPASS_Q = 0.5;
export const ANALOG_DC_HZ = 2;

class ChannelState {
  dcX = 0;
  dcY = 0;
  x1 = 0;
  x2 = 0;
  y1 = 0;
  y2 = 0;
}

export class AnalogStage {
  private st: ChannelState[] = [];
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private dcR = 0;

  constructor(
    sampleRate: number,
    private k = ANALOG_K,
  ) {
    this.setSampleRate(sampleRate);
  }

  setSampleRate(fs: number) {
    // biquad all-pass (RBJ cookbook), dinormalisasi a0 = 1
    const w0 = (2 * Math.PI * ANALOG_ALLPASS_HZ) / fs;
    const alpha = Math.sin(w0) / (2 * ANALOG_ALLPASS_Q);
    const a0 = 1 + alpha;
    this.b0 = (1 - alpha) / a0;
    this.b1 = (-2 * Math.cos(w0)) / a0;
    this.b2 = 1;
    this.a1 = this.b1;
    this.a2 = this.b0;
    this.dcR = Math.exp((-2 * Math.PI * ANALOG_DC_HZ) / fs);
  }

  reset() {
    for (const s of this.st) Object.assign(s, new ChannelState());
  }

  process(input: Float32Array[], output: Float32Array[]) {
    while (this.st.length < input.length) this.st.push(new ChannelState());
    const k = this.k;
    const { b0, b1, b2, a1, a2 } = this;
    const r = this.dcR;
    for (let c = 0; c < input.length; c++) {
      const x = input[c]!;
      const y = output[c]!;
      const s = this.st[c]!;
      for (let i = 0; i < x.length; i++) {
        const v = x[i]!;
        const sat = v + k * v * v;
        // DC blocker: y = x - x1 + R·y1
        const dc = sat - s.dcX + r * s.dcY;
        s.dcX = sat;
        s.dcY = dc;
        // all-pass orde-2 (Direct Form I)
        const ap = b0 * dc + b1 * s.x1 + b2 * s.x2 - a1 * s.y1 - a2 * s.y2;
        s.x2 = s.x1;
        s.x1 = dc;
        s.y2 = s.y1;
        s.y1 = ap;
        y[i] = ap;
      }
    }
  }
}
