// Dekoder Windows: Media Foundation Source Reader.
// Lossless (FLAC/ALAC) → PCM integer dengan bit asli (bit-exact). Lossy (MP3/AAC) → float 32.
#ifdef _WIN32
#define NOMINMAX // macro min/max dari windows.h bentrok dengan std::min
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <propvarutil.h>

#include <algorithm>
#include <cstring>
#include <vector>

#include "decoder.hpp"

namespace ritm {
namespace {

template <class T>
void release(T*& p) {
  if (p) {
    p->Release();
    p = nullptr;
  }
}

std::wstring widen(const std::string& s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  std::wstring w(n > 0 ? n - 1 : 0, L'\0');
  if (n > 1) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n);
  return w;
}

struct MfRuntime {
  bool ok = false;
  MfRuntime() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    ok = SUCCEEDED(MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET));
  }
  ~MfRuntime() {
    if (ok) MFShutdown();
  }
};
MfRuntime& runtime() {
  static MfRuntime rt;
  return rt;
}

class MfDecoder final : public Decoder {
 public:
  ~MfDecoder() override {
    release(reader_);
    if (!temp_.empty()) removeFile(temp_);
  }

  bool open(const FileRegion& r, const std::string& codec, std::string& err) {
    if (!runtime().ok) return (err = "Media Foundation tidak tersedia", false);
    std::string path = r.path;
    // entry di dalam .ritm → salin ke file sementara (Source Reader butuh path/berkas utuh)
    FILE* f = openUtf8(r.path, "rb");
    int64_t whole = f ? fileSize(f) : -1;
    if (f) fclose(f);
    if (r.offset != 0 || r.size != whole) {
      const char* ext = codec == "flac" ? "flac" : codec == "mp3" ? "mp3" : codec == "aac" ? "m4a" : codec == "ogg" ? "ogg" : "bin";
      temp_ = extractToTemp(r, ext, err);
      if (temp_.empty()) return false;
      path = temp_;
    }
    HRESULT hr = MFCreateSourceReaderFromURL(widen(path).c_str(), nullptr, &reader_);
    if (FAILED(hr)) return (err = "Media Foundation tidak bisa membuka " + codec, false);
    reader_->SetStreamSelection(DWORD(MF_SOURCE_READER_ALL_STREAMS), FALSE);
    reader_->SetStreamSelection(DWORD(MF_SOURCE_READER_FIRST_AUDIO_STREAM), TRUE);

    IMFMediaType* native = nullptr;
    if (FAILED(reader_->GetNativeMediaType(DWORD(MF_SOURCE_READER_FIRST_AUDIO_STREAM), 0, &native)))
      return (err = "tidak ada stream audio", false);
    UINT32 rate = 0, ch = 0, bits = 0;
    native->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &rate);
    native->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &ch);
    native->GetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, &bits);
    GUID sub{};
    native->GetGUID(MF_MT_SUBTYPE, &sub);
    release(native);

    const bool lossless = codec == "flac" || codec == "wav" || IsEqualGUID(sub, MFAudioFormat_ALAC) ||
                          IsEqualGUID(sub, MFAudioFormat_FLAC);
    fmt_.codec = codec;
    fmt_.rate = rate;
    fmt_.channels = uint16_t(ch);
    bool ok = false;
    if (lossless && bits >= 8 && bits <= 32) {
      // container PCM yang diminta: 16 → 16, 17..24 → 24 (packed), lainnya → 32
      UINT32 container = bits <= 16 ? 16 : bits <= 24 ? 24 : 32;
      ok = setOutput(MFAudioFormat_PCM, rate, ch, container, bits);
      if (!ok && container == 24) ok = setOutput(MFAudioFormat_PCM, rate, ch, (container = 32), bits);
      if (ok) {
        fmt_.bits = uint16_t(bits);
        fmt_.isFloat = false;
        container_ = container;
      }
    }
    if (!ok) {
      ok = setOutput(MFAudioFormat_Float, rate, ch, 32, 32);
      if (!ok) return (err = "Media Foundation menolak format keluaran", false);
      fmt_.bits = 32;
      fmt_.isFloat = true;
      container_ = 32;
    }
    // baca ulang tipe aktual (decoder bisa mengubah rate/kanal)
    IMFMediaType* cur = nullptr;
    if (SUCCEEDED(reader_->GetCurrentMediaType(DWORD(MF_SOURCE_READER_FIRST_AUDIO_STREAM), &cur))) {
      UINT32 v = 0;
      if (SUCCEEDED(cur->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &v))) fmt_.rate = v;
      if (SUCCEEDED(cur->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &v))) fmt_.channels = uint16_t(v);
      if (SUCCEEDED(cur->GetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, &v))) container_ = v;
      release(cur);
    }
    PROPVARIANT pv;
    PropVariantInit(&pv);
    if (SUCCEEDED(reader_->GetPresentationAttribute(DWORD(MF_SOURCE_READER_MEDIASOURCE), MF_PD_DURATION, &pv)) &&
        pv.vt == VT_UI8)
      total_ = uint64_t(double(pv.uhVal.QuadPart) * fmt_.rate / 1e7 + 0.5);
    PropVariantClear(&pv);
    return true;
  }

  const SourceFormat& format() const override { return fmt_; }
  uint64_t totalFrames() const override { return total_; }

  size_t read(int32_t* ints, float* floats, size_t frames) override {
    const size_t ch = fmt_.channels, bpf = ch * container_ / 8;
    size_t done = 0;
    while (done < frames) {
      if (pos_ >= pend_.size()) {
        if (!fetch()) break;
        continue;
      }
      size_t avail = (pend_.size() - pos_) / bpf;
      size_t n = std::min(avail, frames - done);
      const uint8_t* src = pend_.data() + pos_;
      for (size_t i = 0; i < n * ch; i++) {
        if (fmt_.isFloat) {
          float v;
          memcpy(&v, src + i * 4, 4);
          floats[done * ch + i] = v;
        } else {
          ints[done * ch + i] = toInt(src + i * (container_ / 8));
        }
      }
      pos_ += n * bpf;
      done += n;
    }
    return done;
  }

  bool seek(uint64_t frame) override {
    PROPVARIANT pv;
    InitPropVariantFromInt64(LONGLONG(double(frame) * 1e7 / fmt_.rate), &pv);
    HRESULT hr = reader_->SetCurrentPosition(GUID_NULL, pv);
    PropVariantClear(&pv);
    if (FAILED(hr)) return false;
    pend_.clear();
    pos_ = 0;
    eof_ = false;
    target_ = int64_t(frame);  // fetch() membuang frame sebelum target (seek MF tidak sample-accurate)
    return true;
  }

 private:
  bool setOutput(const GUID& sub, UINT32 rate, UINT32 ch, UINT32 container, UINT32 valid) {
    IMFMediaType* t = nullptr;
    if (FAILED(MFCreateMediaType(&t))) return false;
    t->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    t->SetGUID(MF_MT_SUBTYPE, sub);
    t->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, rate);
    t->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, ch);
    t->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, container);
    t->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, ch * container / 8);
    t->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, rate * ch * container / 8);
    if (valid != container) t->SetUINT32(MF_MT_AUDIO_VALID_BITS_PER_SAMPLE, valid);
    HRESULT hr = reader_->SetCurrentMediaType(DWORD(MF_SOURCE_READER_FIRST_AUDIO_STREAM), nullptr, t);
    release(t);
    return SUCCEEDED(hr);
  }

  // sampel PCM little-endian → int32 rata kanan sesuai fmt_.bits (nilai persis seperti di file)
  int32_t toInt(const uint8_t* p) const {
    int32_t v;
    switch (container_) {
      case 16: v = int16_t(p[0] | (p[1] << 8)); return v >> (16 - std::min<int>(16, fmt_.bits));
      case 24: v = int32_t((uint32_t(p[0]) << 8) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 24)) >> 8;
        return v >> (24 - std::min<int>(24, fmt_.bits));
      default: memcpy(&v, p, 4); return v >> (32 - fmt_.bits);
    }
  }

  bool fetch() {
    if (eof_) return false;
    for (;;) {
      DWORD flags = 0;
      LONGLONG ts = 0;
      IMFSample* s = nullptr;
      HRESULT hr = reader_->ReadSample(DWORD(MF_SOURCE_READER_FIRST_AUDIO_STREAM), 0, nullptr, &flags, &ts, &s);
      if (FAILED(hr) || (flags & MF_SOURCE_READERF_ENDOFSTREAM)) {
        release(s);
        eof_ = true;
        return false;
      }
      if (!s) continue;
      IMFMediaBuffer* b = nullptr;
      if (FAILED(s->ConvertToContiguousBuffer(&b))) {
        release(s);
        continue;
      }
      BYTE* data = nullptr;
      DWORD len = 0;
      b->Lock(&data, nullptr, &len);
      pend_.assign(data, data + len);
      b->Unlock();
      release(b);
      release(s);
      pos_ = 0;
      if (target_ >= 0) {
        const size_t bpf = size_t(fmt_.channels) * container_ / 8;
        int64_t first = int64_t(double(ts) * fmt_.rate / 1e7 + 0.5);
        int64_t skip = target_ - first;
        size_t frames = pend_.size() / bpf;
        if (skip >= int64_t(frames)) continue;  // seluruh blok sebelum target
        if (skip > 0) pos_ = size_t(skip) * bpf;
        target_ = -1;
      }
      if (pos_ < pend_.size()) return true;
    }
  }

  IMFSourceReader* reader_ = nullptr;
  SourceFormat fmt_;
  UINT32 container_ = 16;
  uint64_t total_ = 0;
  std::vector<uint8_t> pend_;
  size_t pos_ = 0;
  bool eof_ = false;
  int64_t target_ = -1;
  std::string temp_;
};

}  // namespace

std::unique_ptr<Decoder> openSystemDecoder(const FileRegion& r, const std::string& codec, std::string& err) {
  auto d = std::make_unique<MfDecoder>();
  if (!d->open(r, codec, err)) return nullptr;
  return d;
}

}  // namespace ritm
#endif
