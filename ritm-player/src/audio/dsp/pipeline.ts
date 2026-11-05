import { AnalogStage } from './analogStage';
import { PeakGuard, type PeakGuardStats } from '../peak_guard/peakGuard';

/** Profil dengar. `purist` = bypass total (sampel diteruskan apa adanya). */
export type DspProfile = 'purist' | 'analog';

export interface DspSettings {
  profile: DspProfile;
  /** Peak Guard aktif (hanya berlaku di luar Purist). */
  guard: boolean;
}

export interface DspStats extends PeakGuardStats {
  profile: DspProfile;
  guardActive: boolean;
}

export const DEFAULT_DSP: DspSettings = { profile: 'purist', guard: true };

/**
 * Bus internal float32: [Analog Stage] → [Peak Guard] → keluar.
 * Purist: tanpa satu pun pengolahan — hanya ditunda lookahead (agar perpindahan profil tidak meloncat)
 * dan diukur true-peak-nya. Nilai sampel identik dengan masukan.
 */
export class DspPipeline {
  settings: DspSettings = { ...DEFAULT_DSP };
  private analog: AnalogStage;
  private guard: PeakGuard;
  private scratch: Float32Array[] = [];

  constructor(sampleRate: number, channels = 2) {
    this.analog = new AnalogStage(sampleRate);
    this.guard = new PeakGuard(channels);
  }

  /** Panggil saat ganti lagu: atenuasi & statistik mulai dari nol. */
  reset() {
    this.analog.reset();
    this.guard.reset();
  }

  stats(): DspStats {
    const g = this.guard.stats();
    return { ...g, profile: this.settings.profile, guardActive: this.settings.profile !== 'purist' && this.settings.guard };
  }

  process(input: Float32Array[], output: Float32Array[]) {
    const n = input[0]?.length ?? 0;
    const purist = this.settings.profile === 'purist';
    let src = input;
    if (!purist) {
      if (this.scratch.length !== input.length || this.scratch[0]?.length !== n) {
        this.scratch = input.map(() => new Float32Array(n));
      }
      this.analog.process(input, this.scratch);
      src = this.scratch;
    }
    this.guard.process(src, output, !purist && this.settings.guard);
  }
}
