#pragma once
#include <memory>
#include <string>

#include "../common.hpp"
#include "../io.hpp"

namespace ritm {

/**
 * Dekoder sumber. read() mengisi buffer interleaved:
 *  - format().isFloat == false → `ints` (int32, rata kanan sesuai format().bits), nilai PERSIS dari file;
 *  - format().isFloat == true  → `floats` (−1..1).
 * Mengembalikan jumlah frame yang terbaca (0 = selesai).
 */
class Decoder {
 public:
  virtual ~Decoder() = default;
  virtual const SourceFormat& format() const = 0;
  virtual uint64_t totalFrames() const = 0;  // 0 bila tidak diketahui
  virtual size_t read(int32_t* ints, float* floats, size_t frames) = 0;
  virtual bool seek(uint64_t frame) = 0;
};

/** Dekoder WAV bawaan (PCM 8/16/24/32-bit & float 32/64), bit-exact, untuk semua platform. */
std::unique_ptr<Decoder> openWav(const FileRegion& r, std::string& err);

/** Dekoder FLAC bawaan, bit-exact, semua platform. */
std::unique_ptr<Decoder> openFlac(const FileRegion& r, std::string& err);

/** Dekoder OS: Media Foundation (Windows) / AudioToolbox (macOS). Null bila tidak tersedia. */
std::unique_ptr<Decoder> openSystemDecoder(const FileRegion& r, const std::string& codec, std::string& err);

/** Pilih dekoder dari codec (dibaca dari magic bytes). */
std::unique_ptr<Decoder> openDecoder(const FileRegion& r, std::string& err);

}  // namespace ritm
