import { TruePeakDetector, fromDb, toDb } from './truePeak';

/** Headroom yang diberikan saat risiko inter-sample peak terdeteksi (sesuai spesifikasi: 0,3–0,5 dB). */
export const GUARD_MIN_DB = 0.3;
export const GUARD_MAX_DB = 0.5;
/** Ambang deteksi: di atas 0 dBTP. */
export const GUARD_THRESHOLD = 1;
/** Lookahead (sampel): sinyal ditunda agar penurunan gain sudah selesai sebelum puncak lewat. */
export const GUARD_LOOKAHEAD = 64;

export interface PeakGuardStats {
  /** True-peak tertinggi sinyal masuk sejak reset (dBTP). */
  inputTpDb: number;
  /** True-peak tertinggi sinyal keluar (dBTP). */
  outputTpDb: number;
  /** Atenuasi yang sedang diterapkan (dB, ≤ 0). */
  gainDb: number;
  /** Jumlah sampel keluar yang masih > 0 dBTP (overshoot di atas 0,5 dB tidak ditekan agar dinamika utuh). */
  overs: number;
}

/**
 * Peak Guard: pre-gain statis per lagu. Saat true-peak masuk > 0 dBTP, gain diturunkan sekali
 * sebesar overshoot + 0,3 dB (dibatasi 0,3–0,5 dB) dengan ramp halus selama lookahead,
 * lalu DITAHAN sampai reset (ganti lagu). Bukan limiter/kompresor → dinamika tidak dipotong.
 */
export class PeakGuard {
  private det: TruePeakDetector[] = [];
  private outDet: TruePeakDetector[] = [];
  private delay: Float32Array[] = [];
  private w = 0;
  private gain = 1;
  private target = 1;
  private step = 0;
  private inPeak = 0;
  private outPeak = 0;
  private overs = 0;

  constructor(
    private channels: number,
    private lookahead = GUARD_LOOKAHEAD,
  ) {
    this.alloc(channels);
  }

  private alloc(n: number) {
    this.channels = n;
    this.det = Array.from({ length: n }, () => new TruePeakDetector());
    this.outDet = Array.from({ length: n }, () => new TruePeakDetector());
    this.delay = Array.from({ length: n }, () => new Float32Array(this.lookahead));
    this.w = 0;
  }

  reset() {
    this.alloc(this.channels);
    this.gain = this.target = 1;
    this.step = 0;
    this.inPeak = this.outPeak = 0;
    this.overs = 0;
  }

  stats(): PeakGuardStats {
    return { inputTpDb: toDb(this.inPeak), outputTpDb: toDb(this.outPeak), gainDb: toDb(this.gain), overs: this.overs };
  }

  /**
   * Proses blok in-place-safe: `input` → `output` (boleh array yang sama).
   * `enabled=false` → hanya ukur & tunda (sampel tidak diubah).
   */
  process(input: Float32Array[], output: Float32Array[], enabled: boolean) {
    const n = input[0]?.length ?? 0;
    if (input.length !== this.channels) this.alloc(input.length);
    const L = this.lookahead;
    for (let i = 0; i < n; i++) {
      // deteksi pada sinyal yang baru masuk (sebelum tunda)
      let peak = 0;
      for (let c = 0; c < this.channels; c++) peak = Math.max(peak, this.det[c]!.push(input[c]![i]!));
      if (peak > this.inPeak) this.inPeak = peak;
      if (enabled && peak > GUARD_THRESHOLD) {
        const needDb = Math.min(GUARD_MAX_DB, Math.max(GUARD_MIN_DB, toDb(peak) + GUARD_MIN_DB));
        const t = fromDb(-needDb);
        if (t < this.target) {
          this.target = t;
          this.step = (this.target - this.gain) / L;
        }
      }
      if (!enabled && this.target !== 1) {
        this.target = 1;
        this.step = (1 - this.gain) / L;
      }
      if (this.step !== 0) {
        this.gain += this.step;
        if ((this.step < 0 && this.gain <= this.target) || (this.step > 0 && this.gain >= this.target)) {
          this.gain = this.target;
          this.step = 0;
        }
      }
      // keluarkan sampel tertunda × gain
      let outPk = 0;
      for (let c = 0; c < this.channels; c++) {
        const buf = this.delay[c]!;
        const delayed = buf[this.w]!;
        buf[this.w] = input[c]![i]!;
        const y = enabled ? delayed * this.gain : delayed;
        output[c]![i] = y;
        outPk = Math.max(outPk, this.outDet[c]!.push(y));
      }
      if (outPk > this.outPeak) this.outPeak = outPk;
      if (outPk > GUARD_THRESHOLD) this.overs++;
      this.w = (this.w + 1) % L;
    }
  }
}
