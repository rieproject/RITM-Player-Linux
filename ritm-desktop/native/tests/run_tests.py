#!/usr/bin/env python3
"""Uji ujung-ke-ujung mesin audio native lewat file sink (tanpa kartu suara).

Membuktikan: bit-perfect (sampel keluar == sampel sumber), negosiasi format, SRC, dither,
mode Shared, profil Analog, pembacaan entry .ritm, dan protokol perintah/event.
Pemakaian: python3 run_tests.py <ritm-audio> <ffmpeg> <workdir> [file.ritm entry ref.wav]
"""
import json
import os
import subprocess
import sys
import time
import wave

import numpy as np

BIN, FF, WORK = sys.argv[1], sys.argv[2], sys.argv[3]
RITM = sys.argv[4:7] if len(sys.argv) >= 7 else None
os.makedirs(WORK, exist_ok=True)
passed = failed = 0


def check(cond, msg):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {msg}")
    else:
        failed += 1
        print(f"  GAGAL {msg}")


def gen(name, filt, rate, codec, dur=2):
    path = os.path.join(WORK, name)
    subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    f"{filt}", "-ar", str(rate), "-ac", "2", "-t", str(dur), "-c:a", codec, path], check=True)
    return path


def write_wav24(name, freq, rate, dur, amplitude):
    """Sinus murni 24-bit stereo (dihasilkan numpy; generator ffmpeg punya distorsi ≈ −90 dB sendiri)."""
    path = os.path.join(WORK, name)
    t = np.arange(int(rate * dur)) / rate
    v = np.round(amplitude * np.sin(2 * np.pi * freq * t) * (2 ** 23 - 1)).astype(np.int64)
    st = np.repeat(v, 2)
    b = np.stack([st & 0xFF, (st >> 8) & 0xFF, (st >> 16) & 0xFF], axis=1).astype(np.uint8).tobytes()
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(3)
        w.setframerate(rate)
        w.writeframes(b)
    return path


def read_wav(path):
    """Baca WAV (PCM int / float, termasuk WAVE_FORMAT_EXTENSIBLE) → (rate, valid_bits, is_float, array int64/float64 [n, ch])."""
    with open(path, "rb") as f:
        b = f.read()
    assert b[:4] == b"RIFF" and b[8:12] == b"WAVE"
    p, fmt, data = 12, None, None
    while p + 8 <= len(b):
        cid, size = b[p:p + 4], int.from_bytes(b[p + 4:p + 8], "little")
        body = b[p + 8:p + 8 + size]
        if cid == b"fmt ":
            tag = int.from_bytes(body[0:2], "little")
            ch = int.from_bytes(body[2:4], "little")
            rate = int.from_bytes(body[4:8], "little")
            cbits = int.from_bytes(body[14:16], "little")
            valid = cbits
            if tag == 0xFFFE:
                valid = int.from_bytes(body[18:20], "little") or cbits
                tag = int.from_bytes(body[24:26], "little")
            fmt = (tag, ch, rate, cbits, valid)
        elif cid == b"data":
            data = body
        p += 8 + size + (size & 1)
    tag, ch, rate, cbits, valid = fmt
    if tag == 3:
        arr = np.frombuffer(data, dtype=np.float32 if cbits == 32 else np.float64).astype(np.float64)
        return rate, 32, True, arr.reshape(-1, ch)
    bps = cbits // 8
    raw = np.frombuffer(data[: len(data) // (bps * ch) * bps * ch], dtype=np.uint8).reshape(-1, bps)
    if bps == 3:
        v = (raw[:, 0].astype(np.int64) | (raw[:, 1].astype(np.int64) << 8) | (raw[:, 2].astype(np.int64) << 16))
        v = np.where(v >= 1 << 23, v - (1 << 24), v)
    elif bps == 2:
        v = raw.view("<i2").astype(np.int64).ravel()
    else:
        v = raw.view("<i4").astype(np.int64).ravel()
    v = v >> (cbits - valid)  # rata kanan sesuai bit valid
    return rate, valid, False, v.reshape(-1, ch)


def render(src, sink, cfg=None, entry=None):
    out = os.path.join(WORK, "out.wav")
    args = [BIN, "--sink", f"file:{out};{sink}", "--render", src]
    if entry:
        args += ["--entry", entry]
    if cfg:
        args += ["--config", json.dumps(cfg)]
    r = subprocess.run(args, capture_output=True, text=True, timeout=300)
    events = [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
    loaded = next((e for e in events if e["ev"] == "loaded"), None)
    return loaded, events, out


def amp(x, f, fs):
    n = len(x)
    w = np.blackman(n)
    t = np.arange(n) / fs
    return 2 * abs(np.sum(x * w * np.exp(-2j * np.pi * f * t))) / np.sum(w)


print("bit-perfect")
s24 = gen("s24_96.wav", "anoisesrc=c=pink:a=0.6", 96000, "pcm_s24le")
s16 = gen("s16_44.wav", "anoisesrc=c=white:a=0.4", 44100, "pcm_s16le")
_, _, _, src24 = read_wav(s24)
_, _, _, src16 = read_wav(s16)

ld, ev, out = render(s24, "rates=44100,96000;bits=16,32/24")
r, bits, _, o = read_wav(out)
check(ld["path"] == "bitperfect" and ld["output"]["rate"] == 96000, "24/96 → perangkat 96 kHz 24-in-32: jalur bit-perfect")
check(o.shape == src24.shape and np.array_equal(o, src24), f"24/96: {len(src24)} frame identik bit-per-bit")
check(any(e["ev"] == "ended" for e in ev), "event ended terkirim")

ld, _, out = render(s16, "rates=44100;bits=32/24")
_, bits, _, o = read_wav(out)
check(ld["path"] == "bitperfect", "16/44,1 → perangkat hanya 24-in-32: tetap bit-perfect (nol di LSB)")
check(np.array_equal(o >> 8, src16) and not np.any(o & 0xFF), "16-bit dipindah ke 24-bit tanpa perubahan nilai")

ld, _, out = render(s16, "rates=44100;bits=24")
_, _, _, o = read_wav(out)
check(ld["output"]["container"] == 24 and np.array_equal(o >> 8, src16), "16/44,1 → 24-bit packed: bit-perfect")

if RITM:
    ritm, entry, ref = RITM
    ld, _, out = render(ritm, "rates=48000;bits=32/24", entry=entry)
    _, _, _, o = read_wav(out)
    _, _, _, refa = read_wav(ref)
    check(ld and ld["path"] == "bitperfect" and np.array_equal(o, refa), f".ritm entry {entry}: dibaca langsung dari arsip, bit-perfect")

print("negosiasi & SRC")
tone = write_wav24("tone_96.wav", 1000, 96000, 3, 0.5)
ld, _, out = render(tone, "rates=44100,48000;bits=32/24")
r, _, _, o = read_wav(out)
check(ld["path"] == "processed" and r == 48000 and ld["dsp"]["resampler"], "perangkat tanpa 96 kHz → pilih 48 kHz (keluarga sama), SRC aktif")
check(any("96000" in x for x in ld["reasons"]), "alasan bukan bit-perfect dilaporkan")
check(abs(len(o) - 3 * 48000) <= 4, f"durasi tetap 3 dtk ({len(o)} frame)")
_, _, _, ta = read_wav(tone)
ref = amp(ta[96000:192000, 0] / 2 ** 23, 1000, 96000)
x = o[48000:96000, 0] / 2 ** 23
g = 20 * np.log10(amp(x, 1000, 48000) / ref)
check(abs(g) < 0.05, f"amplitudo 1 kHz setelah SRC {g:+.3f} dB")
spur = max(20 * np.log10(amp(x, f, 48000) / ref + 1e-15) for f in (2000, 3000, 5000, 11000))
check(spur < -110, f"komponen palsu terbesar {spur:.1f} dB")
for phase in ("linear", "minimum"):
    hot = write_wav24("hf_96.wav", 27000, 96000, 2, 0.5)
    ld, _, out = render(hot, "rates=48000;bits=32/24", {"phase": phase})
    _, _, _, o = read_wav(out)
    a = 20 * np.log10(amp(o[24000:72000, 0] / 2 ** 23, 21000, 48000) / 0.5 + 1e-15)
    check(ld["dsp"]["phase"] == phase and a < -100, f"SRC {phase}: nada 27 kHz tidak alias ke 21 kHz ({a:.1f} dB)")

print("dither")
ld, _, out = render(s24, "rates=96000;bits=16")
_, bits, _, o = read_wav(out)
check(ld["path"] == "processed" and bits == 16 and ld["dsp"]["dither"] and ld["dsp"]["shaping"], "24-bit → perangkat 16-bit: dither + noise shaping aktif")
trunc = src24 >> 8
check(not np.array_equal(o, trunc), "bukan truncation")
err = o * 256 - src24
check(abs(err.mean()) < 4 and np.abs(err).max() < 256 * 40, f"error tanpa bias (rata-rata {err.mean() / 256:+.3f} LSB)")
ld, _, out = render(s24, "rates=96000;bits=16", {"dither": False})
_, _, _, o = read_wav(out)
check(np.array_equal(o, np.clip(np.round(src24 / 256), -32768, 32767)), "dither mati → pembulatan ke terdekat (tetap bukan truncation)")

print("mode Shared, profil Analog, volume")
ld, _, out = render(s16, "rates=44100;bits=16;mix=48000", {"mode": "shared"})
r, _, isf, o = read_wav(out)
check(ld["path"] == "processed" and r == 48000 and isf and ld["output"]["float"], "Shared: float32 di rate mixer, di-resample")
ld, _, out = render(s16, "rates=44100;bits=16", {"profile": "analog"})
check(ld["path"] == "processed" and "profil Analog Stage" in ld["reasons"] and ld["dsp"]["guard"], "profil Analog → jalur diproses + Peak Guard")
ld, _, out = render(s16, "rates=44100;bits=16", {"volume": 0.5})
_, _, _, o = read_wav(out)
ratio = np.std(o[2000:]) / np.std(src16[2000:])
check(ld["path"] == "processed" and abs(ratio - 0.5) < 0.01, f"volume digital 50% → jalur diproses (rasio {ratio:.3f})")

print("protokol interaktif")
out = os.path.join(WORK, "proto.wav")
p = subprocess.Popen([BIN, "--sink", f"file:{out};rates=96000;bits=32/24;speed=4"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
first = json.loads(p.stdout.readline())
check(first["ev"] == "ready", "event ready saat start")
p.stdin.write(json.dumps({"cmd": "devices"}) + "\n")
dev = json.loads(p.stdout.readline())
check(dev["ev"] == "devices" and dev["list"][0]["id"] == "file", "perintah devices")
p.stdin.write(json.dumps({"cmd": "open", "path": s24, "play": False}) + "\n")
ld = json.loads(p.stdout.readline())
check(ld["ev"] == "loaded" and not ld["playing"], "open tanpa autoplay")
p.stdin.write(json.dumps({"cmd": "seek", "t": 1.5}) + "\n")
p.stdin.write(json.dumps({"cmd": "play"}) + "\n")
seen_pos, ended = [], False
deadline = time.time() + 30
while time.time() < deadline:
    line = p.stdout.readline()
    if not line:
        break
    e = json.loads(line)
    if e["ev"] == "pos":
        seen_pos.append(e["t"])
    if e["ev"] == "ended":
        ended = True
        break
check(ended, "lagu selesai setelah seek")
check(seen_pos and min(seen_pos) >= 1.49, f"posisi mulai dari 1,5 dtk (pertama {seen_pos[0] if seen_pos else None})")
p.stdin.write(json.dumps({"cmd": "bogus"}) + "\n")
err = json.loads(p.stdout.readline())
check(err["ev"] == "error" and err["code"] == "PROTOCOL", "perintah tak dikenal → error PROTOCOL")
p.stdin.write(json.dumps({"cmd": "open", "path": "/tidak/ada.wav"}) + "\n")
err = json.loads(p.stdout.readline())
check(err["ev"] == "error", "file tidak ada → error")
p.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
p.wait(10)
check(p.returncode == 0, "quit bersih")
_, _, _, o = read_wav(out)
check(np.array_equal(o, src24[int(1.5 * 96000):]), "setelah seek 1,5 dtk: sisa lagu tetap bit-perfect")

print("dekoder FLAC bawaan")
for bits, ch, lvl, rate in [(16, 2, 5, 44100), (24, 2, 8, 96000), (24, 1, 0, 48000), (24, 6, 5, 48000)]:
    n = int(rate * 2.37)
    rng = np.random.default_rng(bits + ch + lvl)
    t = np.arange(n) / rate
    x = np.clip(0.5 * np.sin(2 * np.pi * (220 + np.arange(ch))[None, :] * t[:, None]) + rng.normal(0, 0.05, (n, ch)), -1, 1)
    full = 2 ** (bits - 1)
    q = np.clip(np.round(x * full), -full, full - 1).astype(np.int64)
    raw = os.path.join(WORK, "f.raw")
    if bits == 16:
        q.astype("<i2").tofile(raw)
    else:
        q.astype("<i4").view(np.uint8).reshape(-1, 4)[:, :3].copy().tofile(raw)
    fl = os.path.join(WORK, f"t{bits}_{ch}.flac")
    subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", "-f", "s16le" if bits == 16 else "s24le", "-ar", str(rate),
                    "-ac", str(ch), "-i", raw, "-c:a", "flac", "-compression_level", str(lvl), fl], check=True)
    ld, _, out = render(fl, f"rates={rate};bits=32;ch=8")
    _, _, _, o = read_wav(out)
    o = o >> (32 - bits) if o.dtype == np.int64 else o
    if ch == 1:
        o = o[:, :1]
    check(ld and ld["path"] == "bitperfect" and np.array_equal(o, q), f"FLAC {bits}-bit {ch} kanal level {lvl} @ {rate}: bit-exact ({n} frame)")
    if bits == 24 and ch == 2:
        import zipfile
        pk = os.path.join(WORK, "flac.ritm")
        with zipfile.ZipFile(pk, "w", zipfile.ZIP_STORED) as z:
            z.writestr("manifest.json", "{}")
            z.write(fl, "audio/01.flac")
        ld, _, out = render(pk, f"rates={rate};bits=32", entry="audio/01.flac")
        _, _, _, o = read_wav(out)
        check(ld and ld["path"] == "bitperfect" and np.array_equal(o >> 8, q), "  FLAC di dalam .ritm (entry stored): bit-exact")
    if ch == 2:
        for frame in [0, 4095, 4096, 4097, int(n * 0.61) | 1, n - 300]:
            out = os.path.join(WORK, "seek.wav")
            p = subprocess.Popen([BIN, "--sink", f"file:{out};rates={rate};bits=32"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 text=True, bufsize=1)
            p.stdout.readline()
            p.stdin.write(json.dumps({"cmd": "open", "path": fl, "at": frame / rate, "play": True}) + "\n")
            while True:
                line = p.stdout.readline()
                if not line or json.loads(line)["ev"] == "ended":
                    break
            p.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
            p.wait(10)
            _, _, _, o = read_wav(out)
            o = o >> (32 - bits)
            check(np.array_equal(o, q[frame:]), f"  seek ke frame {frame}: sampel-akurat & bit-exact")

print(f"\n{passed} lulus, {failed} gagal")
sys.exit(1 if failed else 0)
