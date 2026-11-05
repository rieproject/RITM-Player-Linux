// Berkas & arsip: buka file dengan path UTF-8 (juga di Windows), dan baca entry ZIP .ritm.
// Audio di .ritm disimpan TANPA kompresi (method 0), jadi cukup offset + ukuran — tidak perlu inflate.
#pragma once
#include <cstdint>
#include <cstdio>
#include <string>

namespace ritm {

FILE* openUtf8(const std::string& path, const char* mode);
int64_t fileSize(FILE* f);
bool seekTo(FILE* f, int64_t pos);

/** Bagian dari sebuah file (seluruh file, atau satu entry ZIP stored). */
struct FileRegion {
  std::string path;
  int64_t offset = 0;
  int64_t size = 0;
  std::string entry;       // nama entry bila region berasal dari arsip .ritm (dipakai untuk seed acakan)
  bool scrambled = false;  // entry bertanda "xor-v1": byte di arsip harus dibalik
};

/**
 * Pembalik acakan "xor-v1" (sama dengan ritm-player/src/format/scramble.ts):
 *   seed  = fnv1a32(nama entry) XOR 0x5249544D; bila 0 → 0x9E3779B9
 *   tiap 4 byte: state = xorshift32(state); byte ke-k XOR (state >> 8k) & 0xFF (little-endian)
 * Bisa dipanggil berulang untuk potongan data yang berurutan.
 */
class XorStream {
 public:
  explicit XorStream(const std::string& entry) : state_(seedOf(entry)) {}

  void apply(char* d, size_t n) {
    for (size_t i = 0; i < n; ++i) {
      if (phase_ == 0) advance();
      d[i] = char(uint8_t(d[i]) ^ uint8_t((cur_ >> (8 * phase_)) & 0xFFu));
      phase_ = (phase_ + 1) & 3u;
    }
  }

  static uint32_t seedOf(const std::string& entry) {
    uint32_t h = 0x811C9DC5u;
    for (unsigned char c : entry) {
      h ^= c;
      h *= 0x01000193u;
    }
    uint32_t seed = h ^ 0x5249544Du;
    return seed ? seed : 0x9E3779B9u;
  }

 private:
  void advance() {
    state_ ^= state_ << 13;
    state_ ^= state_ >> 17;
    state_ ^= state_ << 5;
    cur_ = state_;
  }

  uint32_t state_;
  uint32_t cur_ = 0;
  unsigned phase_ = 0;
};

/**
 * Cari entry di arsip ZIP (.ritm). Mengembalikan false dengan pesan bila tidak ditemukan,
 * terkompresi (bukan stored), atau arsip rusak.
 */
bool findStoredEntry(const std::string& zipPath, const std::string& entry, FileRegion& out, std::string& err);

/** Salin region ke file sementara (dipakai dekoder OS yang butuh path). Mengembalikan path, kosong bila gagal. */
std::string extractToTemp(const FileRegion& r, const std::string& ext, std::string& err);
void removeFile(const std::string& path);

}  // namespace ritm
