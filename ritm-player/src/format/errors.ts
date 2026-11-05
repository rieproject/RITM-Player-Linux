export type RitmErrorCode =
  | 'NOT_ZIP'             // file bukan arsip zip yang valid
  | 'BAD_MIMETYPE'        // entry "mimetype" ada tapi isinya salah
  | 'NO_MANIFEST'         // manifest.json tidak ada
  | 'BAD_JSON'            // manifest.json bukan JSON valid
  | 'UNSUPPORTED_VERSION' // formatVersion lebih baru dari yang didukung
  | 'INVALID_FIELD'       // field wajib hilang / tipe atau nilai salah
  | 'BAD_PATH'            // path tidak aman atau di luar folder yang diizinkan
  | 'MISSING_FILE'        // path di manifest tidak ada di arsip
  | 'TOO_LARGE'           // melewati batas ukuran
  | 'TAMPERED';           // isi arsip tidak cocok dengan integrity.json / tanda tangan

export interface RitmIssue {
  code: RitmErrorCode;
  field?: string;   // mis. "tracks[0].audio.mime"
  message: string;
}

export class RitmFormatError extends Error {
  readonly issues: RitmIssue[];
  constructor(issues: RitmIssue[]) {
    super(issues.map((i) => `${i.code}${i.field ? ` (${i.field})` : ''}: ${i.message}`).join('; '));
    this.name = 'RitmFormatError';
    this.issues = issues;
  }
  get code(): RitmErrorCode {
    return this.issues[0]?.code ?? 'INVALID_FIELD';
  }
}
