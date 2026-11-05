import { describe, expect, it } from 'vitest';
import { TruePeakDetector, measureTruePeak, toDb } from '../src/audio/peak_guard/truePeak';
import { GUARD_LOOKAHEAD, PeakGuard } from '../src/audio/peak_guard/peakGuard';
import { AnalogStage } from '../src/audio/dsp/analogStage';
import { DspPipeline } from '../src/audio/dsp/pipeline';

const FS = 48000;
const sine = (f: number, amp: number, n: number, phase = 0) =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / FS + phase));

/** Amplitudo komponen frekuensi f (DFT tunggal) pada potongan stabil sinyal. */
function amp(x: Float32Array, f: number, from = FS / 2) {
  let re = 0;
  let im = 0;
  const n = x.length - from;
  for (let i = from; i < x.length; i++) {
    const w = (2 * Math.PI * f * i) / FS;
    re += x[i]! * Math.cos(w);
    im -= x[i]! * Math.sin(w);
  }
  return (2 * Math.hypot(re, im)) / n;
}
function phaseOf(x: Float32Array, f: number, from = FS / 2) {
  let re = 0;
  let im = 0;
  for (let i = from; i < x.length; i++) {
    const w = (2 * Math.PI * f * i) / FS;
    re += x[i]! * Math.cos(w);
    im -= x[i]! * Math.sin(w);
  }
  return Math.atan2(im, re);
}

describe('true-peak 4× oversampling', () => {
  it('menemukan puncak antar-sampel yang tidak terlihat di sampel mentah', () => {
    // sinus fs/4 bergeser 45°: semua sampel ±0,707 (−3 dBFS) padahal puncak analognya 1,0 (0 dBTP)
    const x = sine(FS / 4, 1, 4800, Math.PI / 4);
    const samplePeak = Math.max(...x.map(Math.abs));
    expect(toDb(samplePeak)).toBeCloseTo(-3.01, 1);
    expect(toDb(measureTruePeak([x]))).toBeGreaterThan(-0.6);
    expect(toDb(measureTruePeak([x]))).toBeLessThan(0.3);
  });

  it('pola klasik +1,+1,−1,−1 di 0 dBFS → true-peak sekitar +3 dBTP', () => {
    const x = Float32Array.from({ length: 4000 }, (_, i) => ((i >> 1) % 2 ? -1 : 1));
    const tp = toDb(measureTruePeak([x]));
    expect(tp).toBeGreaterThan(2);
    expect(tp).toBeLessThan(3.5);
  });

  it('sinus 1 kHz −6 dBFS terukur ≈ −6 dBTP', () => {
    expect(toDb(measureTruePeak([sine(1000, 0.5, 9600)]))).toBeCloseTo(-6.02, 1);
  });

  it('reset mengosongkan riwayat', () => {
    const d = new TruePeakDetector();
    for (let i = 0; i < 20; i++) d.push(1);
    d.reset();
    expect(d.push(0)).toBe(0);
  });
});

describe('Purist = bit-perfect', () => {
  it('sampel keluar identik dengan masukan (hanya ditunda lookahead)', () => {
    const p = new DspPipeline(FS);
    p.settings = { profile: 'purist', guard: true };
    const n = 4096;
    const L = Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) * 0.98 + (i % 7) * 1e-7);
    const R = Float32Array.from({ length: n }, (_, i) => Math.cos(i * 0.11) * 1.2); // termasuk > 0 dBFS
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    for (let o = 0; o < n; o += 128) {
      p.process([L.subarray(o, o + 128), R.subarray(o, o + 128)], [outL.subarray(o, o + 128), outR.subarray(o, o + 128)]);
    }
    for (let i = GUARD_LOOKAHEAD; i < n; i++) {
      expect(outL[i]).toBe(L[i - GUARD_LOOKAHEAD]);
      expect(outR[i]).toBe(R[i - GUARD_LOOKAHEAD]);
    }
    expect(p.stats().gainDb).toBe(0);
    expect(p.stats().guardActive).toBe(false);
  });
});

describe('Analog Stage', () => {
  it('THD (H2) < 0,2% pada 1 kHz 0 dBFS, dan lebih kecil di level rendah', () => {
    for (const [level, max] of [[1, 0.002], [0.25, 0.0005]] as const) {
      const a = new AnalogStage(FS);
      const x = sine(1000, level, FS);
      const y = new Float32Array(x.length);
      a.process([x], [y]);
      const h1 = amp(y, 1000);
      const h2 = amp(y, 2000);
      const h3 = amp(y, 3000);
      const thd = Math.hypot(h2, h3) / h1;
      expect(thd).toBeLessThan(max);
      expect(thd).toBeGreaterThan(max / 20); // benar-benar menambah harmonik (bukan bypass)
      expect(h2).toBeGreaterThan(h3 * 10); // dominan orde-2
    }
  });

  it('respons magnitudo rata (±0,1 dB) dari 20 Hz sampai 20 kHz', () => {
    for (const f of [20, 40, 90, 200, 1000, 5000, 10000, 20000]) {
      const a = new AnalogStage(FS);
      const x = sine(f, 0.1, FS * 2);
      const y = new Float32Array(x.length);
      a.process([x], [y]);
      const gainDb = 20 * Math.log10(amp(y, f, FS) / amp(x, f, FS));
      expect(Math.abs(gainDb)).toBeLessThan(0.1);
    }
  });

  it('memutar fase frekuensi rendah (± 180° di 80 Hz), fase frekuensi tinggi tetap ± 0° (tidak terbalik)', () => {
    const shift = (f: number) => {
      const a = new AnalogStage(FS);
      const x = sine(f, 0.1, FS * 2);
      const y = new Float32Array(x.length);
      a.process([x], [y]);
      let d = (phaseOf(y, f, FS) - phaseOf(x, f, FS)) * (180 / Math.PI);
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      return Math.abs(d);
    };
    expect(shift(80)).toBeGreaterThan(170);
    expect(shift(30)).toBeGreaterThan(60);
    expect(shift(1000)).toBeLessThan(20);
    expect(shift(10000)).toBeLessThan(3);
  });

  it('tanpa offset DC', () => {
    const a = new AnalogStage(FS);
    const x = sine(1000, 1, FS * 2);
    const y = new Float32Array(x.length);
    a.process([x], [y]);
    const mean = y.subarray(FS).reduce((s, v) => s + v, 0) / FS;
    expect(Math.abs(mean)).toBeLessThan(1e-4);
  });
});

describe('Peak Guard', () => {
  const run = (x: Float32Array, enabled = true) => {
    const g = new PeakGuard(1);
    const y = new Float32Array(x.length);
    for (let o = 0; o < x.length; o += 128) g.process([x.subarray(o, o + 128)], [y.subarray(o, o + 128)], enabled);
    return { g, y };
  };

  it('di bawah 0 dBTP: sinyal tidak disentuh', () => {
    const x = sine(1000, 0.9, 9600);
    const { g, y } = run(x);
    expect(g.stats().gainDb).toBe(0);
    for (let i = GUARD_LOOKAHEAD; i < x.length; i++) expect(y[i]).toBe(x[i - GUARD_LOOKAHEAD]);
  });

  it('inter-sample peak +0,1 dBTP → atenuasi 0,4 dB, diterapkan sebelum puncak lewat, lalu ditahan', () => {
    const quiet = sine(1000, 0.5, 4800);
    const hot = sine(FS / 4, 1.0116, 4800, Math.PI / 4); // sampel −2,9 dBFS, true-peak ≈ +0,1 dBTP
    const x = new Float32Array(quiet.length * 2 + hot.length);
    x.set(quiet, 0);
    x.set(hot, quiet.length);
    x.set(quiet, quiet.length + hot.length);
    const { g, y } = run(x);
    const s = g.stats();
    expect(s.inputTpDb).toBeGreaterThan(0);
    expect(s.gainDb).toBeLessThanOrEqual(-0.3);
    expect(s.gainDb).toBeGreaterThanOrEqual(-0.5 - 1e-9);
    expect(s.outputTpDb).toBeLessThan(0);
    // ditahan: bagian tenang setelahnya juga diturunkan dengan gain yang sama (tanpa pumping)
    const after = quiet.length + hot.length + 1000;
    expect(y[after + GUARD_LOOKAHEAD]! / x[after]!).toBeCloseTo(10 ** (s.gainDb / 20), 5);
    // bagian tenang sebelum puncak tidak tersentuh
    expect(y[2000 + GUARD_LOOKAHEAD]).toBe(x[2000]);
  });

  it('overshoot besar (+3 dBTP) hanya diturunkan maksimum 0,5 dB — bukan limiter', () => {
    const x = Float32Array.from({ length: 4000 }, (_, i) => ((i >> 1) % 2 ? -1 : 1));
    const { g } = run(x);
    expect(g.stats().gainDb).toBeCloseTo(-0.5, 5);
    expect(g.stats().overs).toBeGreaterThan(0);
  });

  it('nonaktif → hanya mengukur', () => {
    const x = Float32Array.from({ length: 4000 }, (_, i) => ((i >> 1) % 2 ? -1 : 1));
    const { g, y } = run(x, false);
    expect(g.stats().gainDb).toBe(0);
    expect(g.stats().inputTpDb).toBeGreaterThan(2);
    expect(y[1000 + GUARD_LOOKAHEAD]).toBe(x[1000]);
  });
});

describe('Pipeline Analog', () => {
  it('Analog + Guard: sinyal berubah halus, reset mengembalikan gain', () => {
    const p = new DspPipeline(FS);
    p.settings = { profile: 'analog', guard: true };
    const x = Float32Array.from({ length: 4096 }, (_, i) => ((i >> 1) % 2 ? -1 : 1));
    const y = new Float32Array(x.length);
    for (let o = 0; o < x.length; o += 128) p.process([x.subarray(o, o + 128)], [y.subarray(o, o + 128)]);
    expect(p.stats()).toMatchObject({ profile: 'analog', guardActive: true });
    expect(p.stats().gainDb).toBeLessThan(-0.29);
    p.reset();
    expect(p.stats().gainDb).toBe(0);
  });
});

import { describeFormat, sniffAudioFormat } from '../src/format/detect';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

describe('sniffAudioFormat (file asli dari ffmpeg)', () => {
  let ff: string;
  try {
    ff = createRequire(import.meta.url)('ffmpeg-static') as string;
  } catch {
    ff = 'ffmpeg';
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'ritm-fmt-'));
  const gen = (name: string, args: string[]) => {
    const out = path.join(dir, name);
    execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', ...args, out]);
    return new Uint8Array(readFileSync(out));
  };
  it.each([
    ['a.flac', ['-ar', '96000', '-ac', '2', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'], { codec: 'flac', sampleRate: 96000, bitDepth: 24, channels: 2 }],
    ['b.wav', ['-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le'], { codec: 'wav', sampleRate: 44100, bitDepth: 16, channels: 2 }],
    ['c.wav', ['-ar', '192000', '-ac', '1', '-c:a', 'pcm_s24le'], { codec: 'wav', sampleRate: 192000, bitDepth: 24, channels: 1 }],
    ['d.mp3', ['-ar', '48000', '-ac', '2', '-b:a', '320k'], { codec: 'mp3', sampleRate: 48000, channels: 2 }],
    ['e.ogg', ['-ar', '44100', '-ac', '2', '-c:a', 'libvorbis'], { codec: 'ogg', sampleRate: 44100, channels: 2 }],
  ] as const)('%s', (name, args, expected) => {
    expect(sniffAudioFormat(gen(name, [...args]))).toMatchObject(expected);
  });
  it('describeFormat', () => {
    expect(describeFormat({ codec: 'flac', sampleRate: 96000, bitDepth: 24, channels: 2 })).toBe('FLAC · 96 kHz · 24-bit · stereo');
    expect(describeFormat({ codec: 'mp3', sampleRate: 44100, channels: 2 })).toBe('MP3 · 44,1 kHz · stereo');
  });
});
