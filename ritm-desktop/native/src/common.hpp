// RITM Audio — mesin audio native RITM Player.
// Tipe dasar yang dipakai bersama dekoder, DSP, engine, dan backend.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace ritm {

/** Format sumber setelah didekode. Sampel integer disimpan rata kanan di int32 (mis. 24-bit: −2^23..2^23−1). */
struct SourceFormat {
  uint32_t rate = 0;
  uint16_t channels = 0;
  uint16_t bits = 0;      // bit valid sampel integer; 32 untuk float
  bool isFloat = false;   // true untuk codec lossy yang didekode ke float (MP3/AAC)
  std::string codec;      // "flac", "wav", "mp3", ...
};

/** Format yang diterima perangkat keluaran. */
struct DeviceFormat {
  uint32_t rate = 0;
  uint16_t channels = 0;
  uint16_t containerBits = 0;  // 16 / 24 / 32
  uint16_t validBits = 0;      // ≤ containerBits
  bool isFloat = false;
  uint32_t bytesPerFrame() const { return channels * (containerBits / 8); }
};

enum class OutputMode { Exclusive, Shared };
enum class FilterPhase { Linear, Minimum };
enum class Profile { Purist, Analog };

struct EngineConfig {
  OutputMode mode = OutputMode::Exclusive;
  std::string deviceId;          // kosong = perangkat default
  uint32_t bufferFrames = 1024;  // 512 / 1024 / 2048
  FilterPhase phase = FilterPhase::Linear;
  bool dither = true;
  bool noiseShaping = true;
  Profile profile = Profile::Purist;
  bool guard = true;
  double volume = 1.0;           // < 1 → volume digital (bukan lagi bit-perfect)
  /** Linux: "alsa" | "pipewire". Diabaikan di Windows/macOS. */
  std::string api = "alsa";
};

/** Jalur sinyal yang benar-benar dipakai untuk lagu saat ini. */
enum class SignalPath { BitPerfect, Processed };

struct DeviceInfo {
  std::string id;
  std::string name;
  bool isDefault = false;
  DeviceFormat mix;  // format mixer (mode Shared)
};

inline std::string pathName(SignalPath p) { return p == SignalPath::BitPerfect ? "bitperfect" : "processed"; }

}  // namespace ritm
