// Antarmuka keluaran audio. Implementasi: WASAPI (Windows), CoreAudio (macOS), File (uji).
#pragma once
#include <algorithm>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "../common.hpp"

namespace ritm {

struct OpenRequest {
  OutputMode mode = OutputMode::Exclusive;
  std::string deviceId;
  uint32_t rate = 44100;       // sample rate sumber
  uint16_t channels = 2;       // kanal sumber
  uint16_t bits = 16;          // bit sumber (0/32 + srcFloat untuk float)
  bool srcFloat = false;
  uint32_t bufferFrames = 1024;
};

/**
 * Isi `frames` frame ke `dst` dalam format perangkat (sisa diisi hening). Dipanggil dari thread audio.
 * Mengembalikan jumlah frame berisi data sungguhan (dipakai sink uji untuk berhenti menulis).
 */
using RenderCallback = std::function<uint32_t(uint8_t* dst, uint32_t frames)>;

class Backend {
 public:
  virtual ~Backend() = default;
  virtual std::string name() const = 0;
  virtual std::vector<DeviceInfo> devices() = 0;
  /**
   * Negosiasi & buka perangkat. Exclusive: coba format sumber persis dulu (bit-perfect), lalu
   * container bit lebih besar, lalu sample rate lain (→ SRC). Shared: format mixer perangkat.
   */
  virtual bool open(const OpenRequest& req, DeviceFormat& out, std::string& err) = 0;
  virtual bool start(RenderCallback cb, std::string& err) = 0;
  /** Hentikan & tutup stream (aman dipanggil berulang). */
  virtual void close() = 0;
  /** Latensi keluaran (detik) untuk koreksi posisi. */
  virtual double latency() const = 0;
  /** true hanya untuk sink uji (file): render menunggu data alih-alih mengisi hening. */
  virtual bool blocking() const { return false; }
  /** Linux: pilih "alsa" atau "pipewire". No-op di platform lain. */
  virtual void setApi(const std::string&) {}
};

std::unique_ptr<Backend> createSystemBackend();  // WASAPI / CoreAudio / ALSA|PipeWire
std::unique_ptr<Backend> createFileBackend(const std::string& spec);  // "file:out.wav;rates=44100,96000;bits=16,32/24;mix=float/48000"
#if defined(__linux__)
std::unique_ptr<Backend> createAlsaBackend();
std::unique_ptr<Backend> createPipeWireBackend();
#endif

/** Urutan sample rate yang dicoba bila perangkat menolak rate sumber: kelipatan keluarga yang sama dulu. */
inline std::vector<uint32_t> rateCandidates(uint32_t src) {
  static const uint32_t all[] = {44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000};
  bool fam44 = src % 11025 == 0;
  std::vector<uint32_t> out{src};
  auto add = [&](uint32_t r) {
    for (uint32_t x : out)
      if (x == r) return;
    out.push_back(r);
  };
  // keluarga sama: naik (kelipatan bulat) lalu turun, kemudian keluarga lain dari yang terdekat
  for (uint32_t r : all)
    if ((r % 11025 == 0) == fam44 && r > src && r % src == 0) add(r);
  for (int i = 7; i >= 0; i--)
    if ((all[i] % 11025 == 0) == fam44 && all[i] < src) add(all[i]);
  std::vector<uint32_t> other;
  for (uint32_t r : all)
    if ((r % 11025 == 0) != fam44) other.push_back(r);
  std::sort(other.begin(), other.end(), [&](uint32_t a, uint32_t b) {
    auto d = [&](uint32_t r) { return r >= src ? double(r - src) : double(src - r) * 1.5; };  // utamakan ke atas
    return d(a) < d(b);
  });
  for (uint32_t r : other) add(r);
  return out;
}

/** Kombinasi (container, valid) yang dicoba untuk bit sumber, dari paling hemat yang tetap bit-perfect. */
inline std::vector<std::pair<uint16_t, uint16_t>> bitCandidates(uint16_t bits, bool srcFloat) {
  if (srcFloat || bits > 24) return {{32, 32}, {32, 24}, {24, 24}, {16, 16}};
  if (bits > 16) return {{24, 24}, {32, 24}, {32, 32}, {16, 16}};
  return {{16, 16}, {24, 24}, {32, 24}, {32, 32}};
}

}  // namespace ritm
