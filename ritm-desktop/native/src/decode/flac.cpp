// Dekoder FLAC bawaan (ditulis dari spesifikasi format FLAC / RFC 9639), bit-exact, semua platform.
// Mendukung 4–32 bit, 1–8 kanal, CONSTANT/VERBATIM/FIXED/LPC, rice 4/5-bit + escape,
// dekorelasi left/right/mid-side, wasted bits, blocksize tetap & variabel, seek sample-accurate (bisection).
#include <cstring>
#include <functional>
#include <vector>
#ifdef _MSC_VER
#include <intrin.h>
#endif

#include "decoder.hpp"

namespace ritm {
namespace {

// posisi bit 1 tertinggi (v != 0); __builtin_clzll tidak ada di MSVC
int highestBit64(uint64_t v) {
#ifdef _MSC_VER
  unsigned long i = 0;
  _BitScanReverse64(&i, v);
  return int(i);
#else
  return 63 - __builtin_clzll(v);
#endif
}

uint8_t crc8(const uint8_t* p, size_t n) {
  uint8_t c = 0;
  for (size_t i = 0; i < n; i++) {
    c ^= p[i];
    for (int k = 0; k < 8; k++) c = uint8_t(c & 0x80 ? (c << 1) ^ 0x07 : c << 1);
  }
  return c;
}

struct FrameHeader {
  uint32_t blockSize = 0, rate = 0;
  int channels = 0, assignment = 0, bps = 0;
  bool variable = false;
  uint64_t number = 0;  // frame (blocksize tetap) atau sampel pertama (variabel)
};

/** Parse header frame dari aliran byte (mulai dari sync). Memvalidasi CRC-8. */
bool parseHeader(const std::function<int()>& next, uint32_t siRate, int siBps, FrameHeader& h) {
  uint8_t b[24];
  size_t n = 0;
  auto get = [&]() -> int {
    int v = next();
    if (v < 0 || n >= sizeof b) return -1;
    return b[n++] = uint8_t(v);
  };
  int b0 = get(), b1 = get();
  if (b0 != 0xFF || b1 < 0 || (b1 & 0xFE) != 0xF8) return false;
  h.variable = b1 & 1;
  int b2 = get(), b3 = get();
  if (b2 < 0 || b3 < 0) return false;
  int bsCode = b2 >> 4, rCode = b2 & 15, chCode = b3 >> 4, ssCode = (b3 >> 1) & 7;
  if (bsCode == 0 || rCode == 15 || chCode > 10 || ssCode == 3 || (b3 & 1)) return false;
  // nomor frame/sampel: kode mirip UTF-8, hingga 7 byte (36 bit)
  int u = get();
  if (u < 0) return false;
  int extra = 0;
  uint64_t num;
  if (!(u & 0x80)) num = uint64_t(u);
  else if ((u & 0xE0) == 0xC0) num = u & 0x1F, extra = 1;
  else if ((u & 0xF0) == 0xE0) num = u & 0x0F, extra = 2;
  else if ((u & 0xF8) == 0xF0) num = u & 0x07, extra = 3;
  else if ((u & 0xFC) == 0xF8) num = u & 0x03, extra = 4;
  else if ((u & 0xFE) == 0xFC) num = u & 0x01, extra = 5;
  else if (u == 0xFE) num = 0, extra = 6;
  else return false;
  for (int i = 0; i < extra; i++) {
    int c = get();
    if (c < 0 || (c & 0xC0) != 0x80) return false;
    num = (num << 6) | uint64_t(c & 0x3F);
  }
  h.number = num;
  if (bsCode == 1) h.blockSize = 192;
  else if (bsCode <= 5) h.blockSize = 576u << (bsCode - 2);
  else if (bsCode == 6) {
    int c = get();
    if (c < 0) return false;
    h.blockSize = uint32_t(c) + 1;
  } else if (bsCode == 7) {
    int c = get(), d = get();
    if (c < 0 || d < 0) return false;
    h.blockSize = uint32_t((c << 8) | d) + 1;
  } else h.blockSize = 256u << (bsCode - 8);
  static const uint32_t rates[] = {0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000};
  if (rCode == 0) h.rate = siRate;
  else if (rCode < 12) h.rate = rates[rCode];
  else {
    int c = get();
    if (c < 0) return false;
    if (rCode == 12) h.rate = uint32_t(c) * 1000;
    else {
      int d = get();
      if (d < 0) return false;
      h.rate = uint32_t((c << 8) | d) * (rCode == 14 ? 10 : 1);
    }
  }
  static const int sizes[] = {0, 8, 12, 0, 16, 20, 24, 32};
  h.bps = ssCode == 0 ? siBps : sizes[ssCode];
  h.assignment = chCode;
  h.channels = chCode < 8 ? chCode + 1 : 2;
  size_t len = n;
  int crc = get();
  if (crc < 0 || crc8(b, len) != uint8_t(crc)) return false;
  return true;
}

class FlacDecoder final : public Decoder {
 public:
  ~FlacDecoder() override {
    if (f_) fclose(f_);
  }

  bool open(const FileRegion& r, std::string& err) {
    f_ = openUtf8(r.path, "rb");
    if (!f_) return (err = "tidak bisa membuka file", false);
    base_ = r.offset;
    end_ = r.offset + r.size;
    reposition(base_);
    if (bits(32) != 0x664C6143u) return (err = "bukan FLAC", false);
    bool last = false, haveInfo = false;
    while (!last) {
      last = bits(1);
      uint32_t type = bits(7), len = bits(24);
      if (type == 0 && len >= 34) {
        minBlock_ = bits(16);
        maxBlock_ = bits(16);
        bits(24), bits(24);
        rate_ = bits(20);
        channels_ = int(bits(3)) + 1;
        bps_ = int(bits(5)) + 1;
        total_ = (uint64_t(bits(4)) << 32) | bits(32);
        for (uint32_t i = 18; i < len; i++) bits(8);  // MD5 + sisa
        haveInfo = true;
      } else {
        skipBytes(len);
      }
      if (eof_) return (err = "metadata FLAC terpotong", false);
    }
    if (!haveInfo || rate_ == 0) return (err = "STREAMINFO FLAC tidak ada", false);
    audioStart_ = bytePos();
    fmt_.rate = rate_;
    fmt_.channels = uint16_t(channels_);
    fmt_.bits = uint16_t(bps_);
    fmt_.isFloat = false;
    fmt_.codec = "flac";
    return true;
  }

  const SourceFormat& format() const override { return fmt_; }
  uint64_t totalFrames() const override { return total_; }

  size_t read(int32_t* ints, float*, size_t frames) override {
    size_t done = 0;
    while (done < frames) {
      if (outPos_ >= outFrames_) {
        if (!decodeFrame()) break;
        continue;
      }
      size_t n = std::min(frames - done, outFrames_ - outPos_);
      memcpy(ints + done * channels_, out_.data() + outPos_ * channels_, n * channels_ * sizeof(int32_t));
      outPos_ += n;
      done += n;
    }
    return done;
  }

  bool seek(uint64_t target) override {
    if (total_ && target >= total_) target = total_;
    int64_t pos = audioStart_;
    if (target > 0) {
      // bisection pada posisi byte: cari frame valid terakhir yang mulai ≤ target
      int64_t lo = audioStart_, hi = end_;
      for (int it = 0; it < 64 && hi - lo > 16384; it++) {
        int64_t mid = lo + (hi - lo) / 2;
        int64_t fpos;
        uint64_t first;
        if (!findFrame(mid, fpos, first) || first > target) hi = mid;
        else lo = fpos, pos = fpos;
      }
    }
    reposition(pos);
    outFrames_ = outPos_ = 0;
    // decode maju sampai frame yang memuat target
    for (;;) {
      if (!decodeFrame()) return target >= (total_ ? total_ : target);
      if (frameFirst_ + outFrames_ > target) {
        outPos_ = size_t(target > frameFirst_ ? target - frameFirst_ : 0);
        return true;
      }
    }
  }

 private:
  // ------------------------------------------------ pembaca bit dengan buffer file
  void reposition(int64_t pos) {
    seekTo(f_, pos);
    filePos_ = pos;
    bufLen_ = bufPos_ = 0;
    cache_ = 0;
    cbits_ = 0;
    eof_ = false;
  }
  int nextByte() {
    if (bufPos_ >= bufLen_) {
      if (filePos_ >= end_) return eof_ = true, -1;
      size_t want = size_t(std::min<int64_t>(int64_t(sizeof buf_), end_ - filePos_));
      bufLen_ = fread(buf_, 1, want, f_);
      bufPos_ = 0;
      filePos_ += int64_t(bufLen_);
      if (bufLen_ == 0) return eof_ = true, -1;
    }
    return buf_[bufPos_++];
  }
  /** Posisi byte berikut yang belum dibaca (cache harus sejajar byte). */
  int64_t bytePos() const { return filePos_ - int64_t(bufLen_ - bufPos_) - cbits_ / 8; }
  uint64_t bits(int n) {
    if (n == 0) return 0;
    while (cbits_ < n) {
      int b = nextByte();
      cache_ = (cache_ << 8) | uint64_t(b < 0 ? 0 : b);
      cbits_ += 8;
    }
    cbits_ -= n;
    return (cache_ >> cbits_) & ((n == 64 ? 0 : (uint64_t(1) << n)) - 1);
  }
  int64_t sbits(int n) {
    if (n == 0) return 0;
    uint64_t v = bits(n);
    return int64_t(v << (64 - n)) >> (64 - n);
  }
  uint32_t unary() {
    uint32_t zeros = 0;
    for (;;) {
      if (cbits_ == 0) {
        int b = nextByte();
        if (b < 0) return zeros;
        cache_ = uint64_t(b);
        cbits_ = 8;
      }
      uint64_t v = cache_ & ((uint64_t(1) << cbits_) - 1);
      if (v == 0) {
        zeros += uint32_t(cbits_);
        cbits_ = 0;
        continue;
      }
      int top = highestBit64(v);  // posisi bit 1 tertinggi
      zeros += uint32_t(cbits_ - 1 - top);
      cbits_ = top;
      return zeros;
    }
  }
  void alignByte() { cbits_ -= cbits_ % 8; }
  void skipBytes(uint32_t n) {
    for (uint32_t i = 0; i < n && !eof_; i++) bits(8);
  }

  /** Cari sync frame valid mulai dari byte `from` (dipakai seek). */
  bool findFrame(int64_t from, int64_t& at, uint64_t& first) {
    std::vector<uint8_t> chunk(1 << 16);
    seekTo(f_, from);
    size_t n = fread(chunk.data(), 1, size_t(std::min<int64_t>(int64_t(chunk.size()), end_ - from)), f_);
    for (size_t i = 0; i + 16 < n; i++) {
      if (chunk[i] != 0xFF || (chunk[i + 1] & 0xFE) != 0xF8) continue;
      size_t k = i;
      FrameHeader h;
      if (!parseHeader([&]() -> int { return k < n ? chunk[k++] : -1; }, rate_, bps_, h)) continue;
      if (h.rate != rate_ || h.bps != bps_ || h.channels != channels_) continue;
      at = from + int64_t(i);
      first = h.variable ? h.number : h.number * minBlock_;
      reposition(filePos_);  // buffer bit tidak lagi valid
      return true;
    }
    return false;
  }

  // ------------------------------------------------ dekode frame
  bool decodeFrame() {
    for (;;) {
      alignByte();
      FrameHeader h;
      int64_t start = bytePos();
      auto pull = [this]() -> int {
        int v = int(bits(8));
        return eof_ ? -1 : v;
      };
      if (parseHeader(pull, rate_, bps_, h) && !eof_) {
        if (h.channels == channels_ && h.bps >= 4 && h.bps <= 32) {
          if (decodeBody(h)) {
            frameFirst_ = h.variable ? h.number : h.number * minBlock_;
            return true;
          }
        }
      }
      if (eof_) return false;
      // header/frame rusak: cari sync berikutnya setelah posisi awal
      reposition(start + 1);
      int64_t at;
      uint64_t first;
      if (!findFrame(start + 1, at, first)) return false;
      reposition(at);
    }
  }

  bool decodeBody(const FrameHeader& h) {
    const uint32_t n = h.blockSize;
    ch_.resize(size_t(channels_));
    for (int c = 0; c < channels_; c++) {
      int bps = h.bps;
      if ((h.assignment == 8 && c == 1) || (h.assignment == 9 && c == 0) || (h.assignment == 10 && c == 1)) bps++;
      ch_[c].resize(n);
      if (!subframe(ch_[c].data(), n, bps)) return false;
    }
    alignByte();
    bits(16);  // CRC-16 footer
    if (eof_) return false;
    auto& L = ch_[0];
    if (h.assignment == 8) {  // left/side
      for (uint32_t i = 0; i < n; i++) ch_[1][i] = L[i] - ch_[1][i];
    } else if (h.assignment == 9) {  // side/right
      for (uint32_t i = 0; i < n; i++) L[i] += ch_[1][i];
    } else if (h.assignment == 10) {  // mid/side
      for (uint32_t i = 0; i < n; i++) {
        int64_t mid = L[i] * 2 + (ch_[1][i] & 1), side = ch_[1][i];
        L[i] = (mid + side) >> 1;
        ch_[1][i] = (mid - side) >> 1;
      }
    }
    out_.resize(size_t(n) * channels_);
    for (uint32_t i = 0; i < n; i++)
      for (int c = 0; c < channels_; c++) out_[size_t(i) * channels_ + c] = int32_t(ch_[c][i]);
    outFrames_ = n;
    outPos_ = 0;
    return true;
  }

  bool subframe(int64_t* s, uint32_t n, int bps) {
    if (bits(1) != 0) return false;
    uint32_t type = uint32_t(bits(6));
    int wasted = 0;
    if (bits(1)) wasted = int(unary()) + 1;
    bps -= wasted;
    if (bps <= 0) return false;
    if (type == 0) {
      int64_t v = sbits(bps);
      for (uint32_t i = 0; i < n; i++) s[i] = v;
    } else if (type == 1) {
      for (uint32_t i = 0; i < n; i++) s[i] = sbits(bps);
    } else if (type >= 8 && type <= 12) {
      uint32_t order = type - 8;
      if (order > n) return false;
      for (uint32_t i = 0; i < order; i++) s[i] = sbits(bps);
      if (!residual(s, n, order)) return false;
      for (uint32_t i = order; i < n; i++) {
        switch (order) {
          case 1: s[i] += s[i - 1]; break;
          case 2: s[i] += 2 * s[i - 1] - s[i - 2]; break;
          case 3: s[i] += 3 * s[i - 1] - 3 * s[i - 2] + s[i - 3]; break;
          case 4: s[i] += 4 * s[i - 1] - 6 * s[i - 2] + 4 * s[i - 3] - s[i - 4]; break;
          default: break;
        }
      }
    } else if (type >= 32) {
      uint32_t order = (type & 31) + 1;
      if (order > n) return false;
      for (uint32_t i = 0; i < order; i++) s[i] = sbits(bps);
      int prec = int(bits(4)) + 1;
      if (prec == 16) return false;
      int shift = int(sbits(5));
      if (shift < 0) return false;
      int64_t coef[32];
      for (uint32_t k = 0; k < order; k++) coef[k] = sbits(prec);
      if (!residual(s, n, order)) return false;
      for (uint32_t i = order; i < n; i++) {
        int64_t acc = 0;
        for (uint32_t k = 0; k < order; k++) acc += coef[k] * s[i - 1 - k];
        s[i] += acc >> shift;
      }
    } else {
      return false;
    }
    if (wasted)
      for (uint32_t i = 0; i < n; i++) s[i] = int64_t(uint64_t(s[i]) << wasted);
    return !eof_;
  }

  bool residual(int64_t* s, uint32_t n, uint32_t order) {
    uint32_t method = uint32_t(bits(2));
    if (method > 1) return false;
    const int pbits = method == 0 ? 4 : 5;
    const uint32_t escape = method == 0 ? 15 : 31;
    uint32_t porder = uint32_t(bits(4));
    uint32_t parts = 1u << porder;
    if ((n >> porder) < order && porder) return false;
    uint32_t i = order;
    for (uint32_t p = 0; p < parts; p++) {
      uint32_t count = (n >> porder) - (p == 0 ? order : 0);
      uint32_t k = uint32_t(bits(pbits));
      if (k == escape) {
        int nb = int(bits(5));
        for (uint32_t j = 0; j < count; j++) s[i++] = sbits(nb);
      } else {
        for (uint32_t j = 0; j < count; j++) {
          uint64_t v = (uint64_t(unary()) << k) | bits(int(k));
          s[i++] = int64_t(v >> 1) ^ -int64_t(v & 1);
        }
      }
      if (eof_) return false;
    }
    return i == n;
  }

  FILE* f_ = nullptr;
  int64_t base_ = 0, end_ = 0, audioStart_ = 0, filePos_ = 0;
  uint8_t buf_[1 << 16];
  size_t bufLen_ = 0, bufPos_ = 0;
  uint64_t cache_ = 0;
  int cbits_ = 0;
  bool eof_ = false;

  uint32_t rate_ = 0, minBlock_ = 0, maxBlock_ = 0;
  int channels_ = 0, bps_ = 0;
  uint64_t total_ = 0, frameFirst_ = 0;
  SourceFormat fmt_;
  std::vector<std::vector<int64_t>> ch_;
  std::vector<int32_t> out_;
  size_t outFrames_ = 0, outPos_ = 0;
};

}  // namespace

std::unique_ptr<Decoder> openFlac(const FileRegion& r, std::string& err) {
  auto d = std::make_unique<FlacDecoder>();
  if (!d->open(r, err)) return nullptr;
  return d;
}

}  // namespace ritm
