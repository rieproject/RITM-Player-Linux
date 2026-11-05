# ritm-audio — mesin audio native RITM Player

Proses sidecar C++17 tanpa pustaka pihak ketiga. Electron menjalankannya dan bicara lewat JSON per baris
(stdin → perintah, stdout → event). Tujuannya: **bit-perfect** ke DAC lewat **WASAPI Exclusive** (Windows)
dan **CoreAudio hog mode + format fisik integer** (macOS). ASIO sengaja tidak dipakai.

## Rantai sinyal

```
file / entry .ritm (stored, dibaca langsung dari offset ZIP)
  → dekoder: WAV & FLAC bawaan (bit-exact) · MP3/AAC/ALAC lewat Media Foundation / AudioToolbox
  → bit-perfect?  ya → sampel digeser ke container perangkat (16→24/32 dgn nol di LSB), selesai
                  tidak → float64: Analog Stage → resampler sinc → Peak Guard → volume
                          → dither TPDF (+ noise shaping) ke bit perangkat, atau float32 (Shared)
  → WASAPI (event-driven, MMCSS "Pro Audio") / CoreAudio IOProc
```

Jalur bit-perfect hanya dipakai bila **tidak ada satu pun** pengubahan sampel: mode Exclusive, rate & bit
perangkat cocok (container boleh lebih besar), profil Purist, volume 100%. Selain itu event `loaded`
melaporkan `path: "processed"` beserta `reasons[]` (mis. "perangkat tidak mendukung 192000 Hz").

Negosiasi format Exclusive: rate sumber → kelipatan keluarga sama (44,1k↔88,2k…) → keluarga lain;
bit persis → container lebih besar (24-in-32) → float. Bila Exclusive ditolak (dipakai aplikasi lain,
atau dimatikan di Properti perangkat Windows), mesin otomatis memakai Shared dan mencatat alasannya.

## Protokol

Perintah: `devices` · `config {mode, device, buffer, phase, dither, shaping, profile, guard}` ·
`open {path, entry?, at?, play?}` · `play` · `pause` · `seek {t}` · `mute {on}` · `stop` · `quit`

Event: `ready` · `devices {list}` · `loaded {duration, source, output, path, reasons, dsp}` ·
`pos {t, playing, levels[6], tp{in,out,gain,overs}}` (tiap 50 ms) · `ended` · `stopped` · `error {code, message}`

`config` saat lagu diputar membuka ulang stream di posisi yang sama.

## Build

| Platform | Perintah | Hasil | Status |
|---|---|---|---|
| Windows x64 | `sh scripts/build-win.sh` (mingw-w64, atau MSYS2 dgn `CXX=g++`) | `bin/win-x64/ritm-audio.exe` | diuji (wine: protokol, WASAPI Shared, MF MP3, 47 tes E2E) |
| macOS | `sh scripts/build-mac.sh` (Xcode CLT) | `bin/mac/ritm-audio` (universal) | **belum dikompilasi di Mac** |
| Linux (uji) | `sh scripts/build-linux.sh` | `build/ritm-audio`, `build/dsp_test` | hanya sink file |

`bin/win-x64/ritm-audio.exe` sudah disertakan, jadi `npm run dist` di ritm-desktop langsung memaketkannya
(electron-builder `extraResources` → `resources/native/`).

## Tes

```sh
sh scripts/build-linux.sh && ./build/dsp_test           # unit DSP: true-peak, guard, analog, resampler, dither
python3 tests/run_tests.py build/ritm-audio <ffmpeg> <workdir> [<rilisan.ritm> <entry> <hot.wav>]
```

`run_tests.py` memakai sink file (`--sink "file:out.wav;rates=..;bits=..;ch=..;speed=.."`) sebagai
"perangkat" dengan kemampuan format yang bisa diatur, lalu membandingkan keluaran sampel demi sampel:
bit-perfect 16/24-bit, FLAC bit-exact (16/24-bit, mono–6 kanal, level 0–12), seek sampel-akurat,
negosiasi rate, SRC (spur < −149 dB, alias < −135 dB), dither tanpa bias, Shared, Analog, protokol.
