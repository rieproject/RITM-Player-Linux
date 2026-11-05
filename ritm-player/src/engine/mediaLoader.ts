import type { ActiveMediaState } from '../types/ritm';
import { RitmFormatError, type RitmIssue } from '../format/errors';
import { parseRitmFile, type ParseOptions } from './ritmContainer';
import { parseStandardAudio } from './standardAudio';

export const STANDARD_AUDIO_EXTS = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'] as const;

/** Smart router: .ritm → parser kontainer, ekstensi audio → parser audio standar. */
export async function parseMediaFile(
  file: File,
  opts?: ParseOptions,
): Promise<{ state: ActiveMediaState; warnings: RitmIssue[] }> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'ritm') {
    const { state, warnings } = await parseRitmFile(file, opts);
    return { state, warnings };
  }
  if ((STANDARD_AUDIO_EXTS as readonly string[]).includes(ext)) {
    return { state: await parseStandardAudio(file, opts), warnings: [] };
  }
  throw new RitmFormatError([{ code: 'INVALID_FIELD', field: 'file', message: `format .${ext} tidak didukung` }]);
}

/** Teks ringkas untuk alert Dynamic Island. */
export function alertTextFor(error: unknown): string {
  if (!(error instanceof RitmFormatError)) return 'FORMAT ERROR';
  switch (error.code) {
    case 'UNSUPPORTED_VERSION': return 'UPDATE PLAYER';
    case 'MISSING_FILE': return 'FILE MISSING';
    case 'TOO_LARGE': return 'TOO LARGE';
    default: return 'FORMAT ERROR';
  }
}
