#include <cstring>
#include <vector>

#include "decoder.hpp"

namespace ritm {
namespace {

uint16_t le16(const uint8_t* p) { return uint16_t(p[0] | (p[1] << 8)); }
uint32_t le32(const uint8_t* p) { return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24); }

class WavDecoder final : public Decoder {
 public:
  ~WavDecoder() override {
    if (f_) fclose(f_);
  }
  bool open(const FileRegion& r, std::string& err) {
    f_ = openUtf8(r.path, "rb");
    if (!f_) return (err = "tidak bisa membuka file", false);
    base_ = r.offset;
    int64_t end = r.offset + (r.size > 0 ? r.size : fileSize(f_) - r.offset);
    uint8_t h[12];
    seekTo(f_, base_);
    if (fread(h, 1, 12, f_) != 12 || memcmp(h, "RIFF", 4) || memcmp(h + 8, "WAVE", 4)) return (err = "bukan WAV", false);
    int64_t pos = base_ + 12;
    bool haveFmt = false;
    while (pos + 8 <= end) {
      uint8_t c[8];
      seekTo(f_, pos);
      if (fread(c, 1, 8, f_) != 8) break;
      uint32_t sz = le32(c + 4);
      if (!memcmp(c, "fmt ", 4)) {
        std::vector<uint8_t> fm(std::max<uint32_t>(sz, 16));
        if (fread(fm.data(), 1, sz, f_) != sz) return (err = "fmt rusak", false);
        uint16_t tag = le16(&fm[0]);
        fmt_.channels = le16(&fm[2]);
        fmt_.rate = le32(&fm[4]);
        blockAlign_ = le16(&fm[12]);
        containerBits_ = le16(&fm[14]);
        uint16_t valid = containerBits_;
        if (tag == 0xFFFE && sz >= 40) {
          valid = le16(&fm[18]) ? le16(&fm[18]) : containerBits_;
          tag = le16(&fm[24]);  // dua byte pertama SubFormat GUID
        }
        if (tag == 1) {
          fmt_.isFloat = false;
          fmt_.bits = valid;
        } else if (tag == 3) {
          fmt_.isFloat = true;
          fmt_.bits = 32;
        } else return (err = "WAV bukan PCM/float", false);
        haveFmt = true;
      } else if (!memcmp(c, "data", 4)) {
        dataStart_ = pos + 8;
        int64_t dsz = sz;
        if (dataStart_ + dsz > end || sz == 0xFFFFFFFFu) dsz = end - dataStart_;
        dataBytes_ = dsz;
        break;
      }
      pos += 8 + sz + (sz & 1);
    }
    if (!haveFmt || dataStart_ < 0) return (err = "WAV tanpa fmt/data", false);
    if (fmt_.channels == 0 || blockAlign_ == 0 || (containerBits_ % 8)) return (err = "format WAV tidak didukung", false);
    if (!fmt_.isFloat && (containerBits_ < 8 || containerBits_ > 32)) return (err = "kedalaman bit tidak didukung", false);
    if (fmt_.isFloat && containerBits_ != 32 && containerBits_ != 64) return (err = "float WAV tidak didukung", false);
    fmt_.codec = "wav";
    total_ = uint64_t(dataBytes_ / blockAlign_);
    seek(0);
    return true;
  }
  const SourceFormat& format() const override { return fmt_; }
  uint64_t totalFrames() const override { return total_; }
  bool seek(uint64_t frame) override {
    if (frame > total_) frame = total_;
    cur_ = frame;
    return seekTo(f_, dataStart_ + int64_t(frame) * blockAlign_);
  }
  size_t read(int32_t* ints, float* floats, size_t frames) override {
    if (cur_ >= total_) return 0;
    frames = size_t(std::min<uint64_t>(frames, total_ - cur_));
    buf_.resize(frames * blockAlign_);
    size_t got = fread(buf_.data(), blockAlign_, frames, f_);
    const uint8_t* p = buf_.data();
    const size_t n = got * fmt_.channels;
    const int bytes = containerBits_ / 8;
    const int shift = containerBits_ - (fmt_.isFloat ? containerBits_ : fmt_.bits);
    for (size_t i = 0; i < n; i++, p += bytes) {
      if (fmt_.isFloat) {
        if (bytes == 4) {
          float v;
          memcpy(&v, p, 4);
          floats[i] = v;
        } else {
          double v;
          memcpy(&v, p, 8);
          floats[i] = float(v);
        }
        continue;
      }
      int32_t v;
      switch (bytes) {
        case 1: v = int32_t(p[0]) - 128; break;  // 8-bit WAV unsigned
        case 2: v = int16_t(le16(p)); break;
        case 3: v = int32_t((uint32_t(p[0]) << 8) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 24)) >> 8; break;
        default: v = int32_t(le32(p)); break;
      }
      ints[i] = v >> shift;  // valid bits rata kanan (data WAV rata kiri dalam container)
    }
    cur_ += got;
    return got;
  }

 private:
  FILE* f_ = nullptr;
  SourceFormat fmt_;
  int64_t base_ = 0, dataStart_ = -1, dataBytes_ = 0;
  uint16_t blockAlign_ = 0, containerBits_ = 0;
  uint64_t total_ = 0, cur_ = 0;
  std::vector<uint8_t> buf_;
};

std::string sniffCodec(const FileRegion& r) {
  FILE* f = openUtf8(r.path, "rb");
  if (!f) return {};
  uint8_t b[12] = {};
  seekTo(f, r.offset);
  size_t n = fread(b, 1, 12, f);
  fclose(f);
  if (n < 12) return {};
  if (!memcmp(b, "fLaC", 4)) return "flac";
  if (!memcmp(b, "RIFF", 4) && !memcmp(b + 8, "WAVE", 4)) return "wav";
  if (!memcmp(b, "OggS", 4)) return "ogg";
  if (!memcmp(b + 4, "ftyp", 4)) return "aac";
  if (!memcmp(b, "ID3", 3) || (b[0] == 0xFF && (b[1] & 0xE0) == 0xE0)) return "mp3";
  return {};
}

}  // namespace

std::unique_ptr<Decoder> openWav(const FileRegion& r, std::string& err) {
  auto d = std::make_unique<WavDecoder>();
  if (!d->open(r, err)) return nullptr;
  return d;
}

std::unique_ptr<Decoder> openDecoder(const FileRegion& r, std::string& err) {
  std::string codec = sniffCodec(r);
  if (codec.empty()) {
    err = "format audio tidak dikenali";
    return nullptr;
  }
  if (codec == "wav") return openWav(r, err);
  if (codec == "flac") return openFlac(r, err);
  auto d = openSystemDecoder(r, codec, err);
  if (!d && err.empty()) err = "codec " + codec + " belum didukung mesin native di platform ini";
  return d;
}

}  // namespace ritm
