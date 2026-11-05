import type { LyricLine } from '../types/ritm';

const TIME_TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const LEADING_TAGS = /^((?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$/;
const META_TAG = /^\[([a-zA-Z#]+):(.*)\]$/;

/**
 * Parse LRC. Mendukung beberapa tag waktu per baris ("[00:12.00][01:30.00]teks"),
 * pecahan 1–3 digit, dan mengabaikan tag metadata seperti [ar:...] / [offset:...].
 */
export function parseLRC(lrc: string): LyricLine[] {
  const result: LyricLine[] = [];
  let offsetMs = 0;
  const offsetMatch = /\[offset:\s*([+-]?\d+)\s*\]/i.exec(lrc);
  if (offsetMatch?.[1]) offsetMs = parseInt(offsetMatch[1], 10);

  for (const raw of lrc.split(/\r?\n/)) {
    const line = raw.trim();
    const times: number[] = [];
    let lastIndex = 0;
    TIME_TAG.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TIME_TAG.exec(line)) && m.index === lastIndex) {
      const min = parseInt(m[1] ?? '0', 10);
      const sec = parseInt(m[2] ?? '0', 10);
      const frac = m[3] ? parseInt(m[3], 10) / 10 ** m[3].length : 0;
      times.push(Math.max(0, min * 60 + sec + frac - offsetMs / 1000));
      lastIndex = TIME_TAG.lastIndex;
    }
    if (times.length === 0) continue;
    const text = line.slice(lastIndex).trim();
    for (const time of times) result.push({ time, text });
  }
  return result.sort((a, b) => a.time - b.time);
}

/** Format detik → "mm:ss.xx" (sentidetik, standar LRC). */
export function formatLrcTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** Susun teks LRC dari daftar baris (urut waktu). */
export function buildLRC(lines: LyricLine[], meta: Record<string, string> = {}): string {
  const head = Object.entries(meta)
    .filter(([, v]) => v.trim() !== '')
    .map(([k, v]) => `[${k}:${v.trim()}]`);
  const body = [...lines].sort((a, b) => a.time - b.time).map((l) => `[${formatLrcTime(l.time)}]${l.text}`);
  return [...head, ...body].join('\n') + '\n';
}

/**
 * Geser semua tag waktu di awal baris sebanyak `deltaSec` (boleh negatif, dibatasi ≥ 0).
 * Teks, tag metadata, dan baris tanpa tag tidak diubah.
 */
export function shiftLRC(lrc: string, deltaSec: number): string {
  return lrc
    .split(/\r?\n/)
    .map((raw) => {
      const m = LEADING_TAGS.exec(raw.trimStart());
      if (!m) return raw;
      const tags = (m[1] ?? '').replace(TIME_TAG, (_t, mm: string, ss: string, ff?: string) => {
        const t = parseInt(mm, 10) * 60 + parseInt(ss, 10) + (ff ? parseInt(ff, 10) / 10 ** ff.length : 0);
        return `[${formatLrcTime(t + deltaSec)}]`;
      });
      return tags + (m[2] ?? '');
    })
    .join('\n');
}

/** Ambil teks lirik saja (untuk mode tap-to-sync). Baris kosong & metadata dibuang. */
export function lrcToPlain(lrc: string): string {
  return lrc
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw.trim();
      if (META_TAG.test(line) && !LEADING_TAGS.test(line)) return '';
      const m = LEADING_TAGS.exec(line);
      return (m ? (m[2] ?? '') : line).trim();
    })
    .filter((l) => l !== '')
    .join('\n');
}

export interface LrcIssue {
  line: number; // 1-based
  level: 'error' | 'warning';
  message: string;
}

export interface LrcAnalysis {
  lines: LyricLine[];
  issues: LrcIssue[];
  timedLineCount: number;
}

/**
 * Periksa LRC per baris: baris tanpa timestamp, tag rusak, detik ≥ 60,
 * urutan waktu mundur, dan (opsional) waktu melewati durasi lagu.
 */
export function analyzeLRC(lrc: string, durationSec?: number): LrcAnalysis {
  const issues: LrcIssue[] = [];
  let prev = -1;
  let timed = 0;

  lrc.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const n = i + 1;
    if (line === '') return;

    const lead = LEADING_TAGS.exec(line);
    if (!lead) {
      if (META_TAG.test(line)) return; // [ar:..], [ti:..], [offset:..]
      issues.push({
        line: n,
        level: line.startsWith('[') ? 'error' : 'warning',
        message: line.startsWith('[') ? 'timestamp tidak valid' : 'tanpa timestamp, tidak akan tampil',
      });
      return;
    }

    timed++;
    TIME_TAG.lastIndex = 0;
    let m: RegExpExecArray | null;
    const tags = lead[1] ?? '';
    while ((m = TIME_TAG.exec(tags))) {
      const sec = parseInt(m[2] ?? '0', 10);
      if (sec >= 60) {
        issues.push({ line: n, level: 'error', message: `detik ${sec} harus di bawah 60` });
        continue;
      }
      const t = parseInt(m[1] ?? '0', 10) * 60 + sec + (m[3] ? parseInt(m[3], 10) / 10 ** m[3].length : 0);
      if (durationSec && t > durationSec + 0.5) {
        issues.push({ line: n, level: 'warning', message: `${formatLrcTime(t)} melewati durasi lagu` });
      }
      if (t < prev) issues.push({ line: n, level: 'warning', message: 'waktu lebih awal dari baris sebelumnya' });
      prev = t;
    }
  });

  return { lines: parseLRC(lrc), issues, timedLineCount: timed };
}

/** Indeks baris aktif pada waktu `t` (baris terakhir dengan time ≤ t), atau -1. */
export function activeLyricIndex(lines: LyricLine[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.time <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
