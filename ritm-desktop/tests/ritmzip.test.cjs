// Uji pembaca entry .ritm terkompresi (electron/ritmzip.cjs). Jalankan: node --test tests/
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { entryMethod, readRitmAudio, xorScramble, scrambleSeed } = require('../electron/ritmzip.cjs');

// vektor tetap yang sama dengan ritm-player/tests/scramble.test.ts (harus cocok dengan native C++)
test('seed dan keystream cocok dengan vektor referensi', () => {
  assert.equal(scrambleSeed('audio/01.flac').toString(16), '68042f9a');
  const out = xorScramble(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 'audio/01.flac');
  assert.deepEqual([...out], [0x41, 0x34, 0x16, 0x50, 0x7b, 0x89, 0x35, 0x65, 0x89, 0xd8]);
});

test('acak lalu acak lagi = data asli, untuk berbagai panjang', () => {
  for (const n of [0, 1, 3, 4, 5, 7, 8, 1000, 65537]) {
    const data = Buffer.from(Array.from({ length: n }, (_, i) => (i * 97 + 3) & 0xff));
    const once = xorScramble(data, 'audio/02.wav');
    assert.deepEqual(xorScramble(once, 'audio/02.wav'), data);
  }
});

// arsip nyata: audio/01.mp3 di master-v3.ritm terkompresi deflate. Lewati bila berkas tidak ada di mesin ini.
const REAL = path.join(__dirname, '..', '..', 'ritm-server', 'data', 'storage', 'private', 'releases', 'rel_d93abe0da65842d4', 'master-v3.ritm');
const real = fs.existsSync(REAL) ? { skip: false } : { skip: 'arsip contoh tidak ada' };

test('entry deflate dibaca dan hash-nya cocok dengan integrity.json', real, async () => {
  assert.equal(await entryMethod(REAL, 'audio/01.mp3'), 8);
  const audio = await readRitmAudio(REAL, 'audio/01.mp3', false); // tidak diacak (manifest tanpa scramble)
  assert.equal(audio.subarray(0, 3).toString('latin1'), 'ID3');
  assert.equal(audio.length, 10870198);
});

test('entry stored terdeteksi (method 0) dan entry tidak ada → null', real, async () => {
  assert.equal(await entryMethod(REAL, 'mimetype'), 0);
  assert.equal(await entryMethod(REAL, 'audio/tidak-ada.mp3'), null);
});

test('entry yang tidak ada ditolak dengan pesan jelas', real, async () => {
  await assert.rejects(readRitmAudio(REAL, 'audio/tidak-ada.mp3', false), /tidak ditemukan/);
});
