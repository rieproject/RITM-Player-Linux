import { parseLRC, type ActiveMediaState } from '@ritm/player';
import { desktop } from './desktop';

/**
 * Lirik untuk file audio biasa (mp3, flac, …): hanya file .lrc di sebelah audio (desktop).
 * Edisi standar tidak mencari lirik daring dan tidak melakukan romanisasi.
 * Dipanggil sebelum rilisan dipasang ke pemutar, karena mengganti objek media akan memulai ulang lagu.
 * Tidak melempar error — bila tidak ada lirik, rilisan dikembalikan apa adanya.
 */
export async function attachLyrics(state: ActiveMediaState, filePath: string | null): Promise<ActiveMediaState> {
  const track = state.tracks[0];
  if (!desktop || !filePath || state.sourceType !== 'standard' || !track || track.lyrics?.length) return state;
  try {
    const found = await desktop.findLyrics({ path: filePath, title: track.title, online: false });
    const lyrics = found ? parseLRC(found.lrc) : [];
    if (lyrics.length === 0) return state;
    return { ...state, tracks: [{ ...track, lyrics }, ...state.tracks.slice(1)] };
  } catch {
    return state;
  }
}
