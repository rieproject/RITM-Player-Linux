/**
 * Detektor true-peak dengan oversampling 4× (polyphase FIR 48 tap, sinc berjendela Kaiser),
 * mengikuti pendekatan ITU-R BS.1770-4 Annex 2. Mendeteksi puncak antar-sampel (inter-sample peak)
 * yang tidak terlihat pada nilai sampel mentah.
 */
export const OVERSAMPLE = 4;
const TAPS = 48;
const PER_PHASE = TAPS / OVERSAMPLE; // 12

function besselI0(x: number) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 25; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

/** Koefisien per fase: phases[p][m] dikalikan x[n - m]. Tiap fase dinormalisasi (gain DC = 1). */
function design(): Float64Array[] {
  const beta = 7;
  const h = new Float64Array(TAPS);
  const mid = (TAPS - 1) / 2;
  for (let n = 0; n < TAPS; n++) {
    const t = (n - mid) / OVERSAMPLE;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const r = (2 * n) / (TAPS - 1) - 1;
    h[n] = sinc * (besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / besselI0(beta));
  }
  const phases: Float64Array[] = [];
  for (let p = 0; p < OVERSAMPLE; p++) {
    const ph = new Float64Array(PER_PHASE);
    let sum = 0;
    for (let m = 0; m < PER_PHASE; m++) {
      ph[m] = h[p + OVERSAMPLE * m]!;
      sum += ph[m]!;
    }
    for (let m = 0; m < PER_PHASE; m++) ph[m]! /= sum;
    phases.push(ph);
  }
  return phases;
}

const PHASES = design();

/** Detektor per kanal; simpan riwayat 12 sampel terakhir. */
export class TruePeakDetector {
  private hist = new Float64Array(PER_PHASE);
  private pos = 0;

  reset() {
    this.hist.fill(0);
    this.pos = 0;
  }

  /** Masukkan satu sampel, kembalikan |puncak| terbesar dari 4 titik interpolasinya. */
  push(x: number): number {
    this.pos = (this.pos + 1) % PER_PHASE;
    this.hist[this.pos] = x;
    let peak = 0;
    for (let p = 0; p < OVERSAMPLE; p++) {
      const c = PHASES[p]!;
      let acc = 0;
      let i = this.pos;
      for (let m = 0; m < PER_PHASE; m++) {
        acc += c[m]! * this.hist[i]!;
        i = i === 0 ? PER_PHASE - 1 : i - 1;
      }
      const a = acc < 0 ? -acc : acc;
      if (a > peak) peak = a;
    }
    return peak;
  }
}

/** Latensi grup filter (sampel input) — titik interpolasi tertinggal ± setengah panjang fase. */
export const TRUE_PEAK_LATENCY = PER_PHASE / 2;

export const toDb = (lin: number) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);
export const fromDb = (db: number) => 10 ** (db / 20);

/** True-peak maksimum (linear) dari blok sampel multi-kanal — utilitas untuk analisis & tes. */
export function measureTruePeak(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    const d = new TruePeakDetector();
    for (let i = 0; i < ch.length; i++) peak = Math.max(peak, d.push(ch[i]!));
    for (let i = 0; i < PER_PHASE; i++) peak = Math.max(peak, d.push(0)); // keluarkan sisa filter
  }
  return peak;
}
