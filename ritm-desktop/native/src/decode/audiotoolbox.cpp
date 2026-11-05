// Dekoder macOS: ExtAudioFile (AudioToolbox) untuk MP3, AAC & ALAC. FLAC/WAV memakai dekoder bawaan.
// ALAC (lossless) → integer 32-bit lalu digeser ke bit asli (bit-exact). Lossy → float32.
// STATUS: ditulis tanpa SDK macOS di lingkungan build — belum dikompilasi/diuji di Mac.
#ifdef __APPLE__
#include <AudioToolbox/AudioToolbox.h>
#include <CoreFoundation/CoreFoundation.h>

#include <cstring>
#include <vector>

#include "decoder.hpp"

namespace ritm {
namespace {

class AtDecoder final : public Decoder {
 public:
  ~AtDecoder() override {
    if (file_) ExtAudioFileDispose(file_);
    if (!temp_.empty()) removeFile(temp_);
  }

  bool open(const FileRegion& r, const std::string& codec, std::string& err) {
    std::string path = r.path;
    FILE* f = openUtf8(r.path, "rb");
    int64_t whole = f ? fileSize(f) : -1;
    if (f) fclose(f);
    if (r.offset != 0 || r.size != whole) {
      const char* ext = codec == "mp3" ? "mp3" : codec == "aac" ? "m4a" : codec == "ogg" ? "ogg" : "bin";
      temp_ = extractToTemp(r, ext, err);
      if (temp_.empty()) return false;
      path = temp_;
    }
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(nullptr, reinterpret_cast<const UInt8*>(path.c_str()),
                                                           CFIndex(path.size()), false);
    OSStatus st = ExtAudioFileOpenURL(url, &file_);
    CFRelease(url);
    if (st != noErr || !file_) return (err = "AudioToolbox tidak bisa membuka " + codec, false);

    AudioStreamBasicDescription src{};
    UInt32 size = sizeof src;
    ExtAudioFileGetProperty(file_, kExtAudioFileProperty_FileDataFormat, &size, &src);
    SInt64 frames = 0;
    size = sizeof frames;
    ExtAudioFileGetProperty(file_, kExtAudioFileProperty_FileLengthFrames, &size, &frames);
    total_ = frames > 0 ? uint64_t(frames) : 0;

    fmt_.codec = codec;
    fmt_.rate = uint32_t(src.mSampleRate);
    fmt_.channels = uint16_t(std::max<UInt32>(1, src.mChannelsPerFrame));
    int bits = 0;
    if (src.mFormatID == kAudioFormatAppleLossless) {
      switch (src.mFormatFlags) {
        case kAppleLosslessFormatFlag_16BitSourceData: bits = 16; break;
        case kAppleLosslessFormatFlag_20BitSourceData: bits = 20; break;
        case kAppleLosslessFormatFlag_24BitSourceData: bits = 24; break;
        case kAppleLosslessFormatFlag_32BitSourceData: bits = 32; break;
        default: bits = 24;
      }
    }
    AudioStreamBasicDescription client{};
    client.mFormatID = kAudioFormatLinearPCM;
    client.mSampleRate = src.mSampleRate;
    client.mChannelsPerFrame = fmt_.channels;
    client.mFramesPerPacket = 1;
    client.mBitsPerChannel = 32;
    client.mBytesPerFrame = client.mBytesPerPacket = 4 * fmt_.channels;
    if (bits) {
      client.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
      fmt_.bits = uint16_t(bits);
      fmt_.isFloat = false;
    } else {
      client.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
      fmt_.bits = 32;
      fmt_.isFloat = true;
    }
    st = ExtAudioFileSetProperty(file_, kExtAudioFileProperty_ClientDataFormat, sizeof client, &client);
    if (st != noErr) return (err = "AudioToolbox menolak format keluaran", false);
    return true;
  }

  const SourceFormat& format() const override { return fmt_; }
  uint64_t totalFrames() const override { return total_; }

  size_t read(int32_t* ints, float* floats, size_t frames) override {
    const UInt32 ch = fmt_.channels;
    size_t done = 0;
    while (done < frames) {
      UInt32 n = UInt32(std::min<size_t>(frames - done, 8192));
      AudioBufferList list;
      list.mNumberBuffers = 1;
      list.mBuffers[0].mNumberChannels = ch;
      list.mBuffers[0].mDataByteSize = n * ch * 4;
      list.mBuffers[0].mData = fmt_.isFloat ? static_cast<void*>(floats + done * ch) : static_cast<void*>(ints + done * ch);
      if (ExtAudioFileRead(file_, &n, &list) != noErr || n == 0) break;
      if (!fmt_.isFloat && fmt_.bits < 32) {
        // ALAC → int32 MSB-aligned; geser ke nilai asli (rata kanan)
        for (size_t i = done * ch; i < (done + n) * ch; i++) ints[i] >>= (32 - fmt_.bits);
      }
      done += n;
    }
    return done;
  }

  bool seek(uint64_t frame) override { return ExtAudioFileSeek(file_, SInt64(frame)) == noErr; }

 private:
  ExtAudioFileRef file_ = nullptr;
  SourceFormat fmt_;
  uint64_t total_ = 0;
  std::string temp_;
};

}  // namespace

std::unique_ptr<Decoder> openSystemDecoder(const FileRegion& r, const std::string& codec, std::string& err) {
  auto d = std::make_unique<AtDecoder>();
  if (!d->open(r, codec, err)) return nullptr;
  return d;
}

}  // namespace ritm
#endif
