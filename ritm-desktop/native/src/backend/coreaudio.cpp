// Backend macOS: CoreAudio HAL.
//  Exclusive = hog mode + format FISIK integer (rate & bit sumber) + mixing dimatikan → bit-perfect.
//  Shared    = format virtual float32 di sample rate perangkat saat ini (lewat mixer HAL).
// STATUS: ditulis tanpa SDK macOS di lingkungan build — belum dikompilasi/diuji di Mac.
#ifdef __APPLE__
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <unistd.h>

#include <atomic>
#include <cmath>
#include <chrono>
#include <cstring>
#include <thread>

#include "backend.hpp"

namespace ritm {
namespace {

AudioObjectPropertyAddress addr(AudioObjectPropertySelector sel, AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal) {
  return AudioObjectPropertyAddress{sel, scope, 0 /* element main */};
}

template <class T>
bool getProp(AudioObjectID obj, AudioObjectPropertySelector sel, T& out, AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal) {
  auto a = addr(sel, scope);
  UInt32 size = sizeof(T);
  return AudioObjectGetPropertyData(obj, &a, 0, nullptr, &size, &out) == noErr;
}
template <class T>
OSStatus setProp(AudioObjectID obj, AudioObjectPropertySelector sel, const T& v, AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal) {
  auto a = addr(sel, scope);
  return AudioObjectSetPropertyData(obj, &a, 0, nullptr, sizeof(T), &v);
}
template <class T>
std::vector<T> getArray(AudioObjectID obj, AudioObjectPropertySelector sel, AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal) {
  auto a = addr(sel, scope);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(obj, &a, 0, nullptr, &size) != noErr || size == 0) return {};
  std::vector<T> v(size / sizeof(T));
  if (AudioObjectGetPropertyData(obj, &a, 0, nullptr, &size, v.data()) != noErr) return {};
  v.resize(size / sizeof(T));
  return v;
}

std::string cfToUtf8(CFStringRef s) {
  if (!s) return {};
  CFIndex len = CFStringGetMaximumSizeForEncoding(CFStringGetLength(s), kCFStringEncodingUTF8) + 1;
  std::string out(size_t(len), '\0');
  if (!CFStringGetCString(s, out.data(), len, kCFStringEncodingUTF8)) return {};
  out.resize(strlen(out.c_str()));
  return out;
}
std::string stringProp(AudioObjectID obj, AudioObjectPropertySelector sel) {
  CFStringRef s = nullptr;
  if (!getProp(obj, sel, s) || !s) return {};
  std::string r = cfToUtf8(s);
  CFRelease(s);
  return r;
}

int outputChannels(AudioDeviceID dev) {
  auto a = addr(kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeOutput);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(dev, &a, 0, nullptr, &size) != noErr || size == 0) return 0;
  std::vector<uint8_t> buf(size);
  auto* list = reinterpret_cast<AudioBufferList*>(buf.data());
  if (AudioObjectGetPropertyData(dev, &a, 0, nullptr, &size, list) != noErr) return 0;
  int ch = 0;
  for (UInt32 i = 0; i < list->mNumberBuffers; i++) ch += int(list->mBuffers[i].mNumberChannels);
  return ch;
}

std::string osText(OSStatus st) {
  switch (st) {
    case kAudioDevicePermissionsError: return "perangkat sedang dipakai aplikasi lain secara eksklusif (hog mode)";
    case kAudioDeviceUnsupportedFormatError: return "format tidak didukung perangkat";
    case kAudioHardwareNotRunningError: return "CoreAudio tidak berjalan";
    case kAudioHardwareBadDeviceError: return "perangkat tidak valid / dicabut";
    default: {
      char b[48];
      snprintf(b, sizeof b, "OSStatus %d", int(st));
      return b;
    }
  }
}

/** Format fisik yang cocok persis dengan (container, valid) integer little-endian, MSB-aligned bila valid < container. */
bool matchesInt(const AudioStreamBasicDescription& f, uint16_t container, uint16_t valid) {
  if (f.mFormatID != kAudioFormatLinearPCM) return false;
  if (f.mFormatFlags & (kAudioFormatFlagIsFloat | kAudioFormatFlagIsBigEndian | kAudioFormatFlagIsNonInterleaved)) return false;
  if (!(f.mFormatFlags & kAudioFormatFlagIsSignedInteger)) return false;
  if (f.mBitsPerChannel != valid || f.mChannelsPerFrame == 0) return false;
  if (f.mBytesPerFrame != f.mChannelsPerFrame * (container / 8u)) return false;
  if (valid < container && !(f.mFormatFlags & kAudioFormatFlagIsAlignedHigh)) return false;
  return true;
}

class CoreAudioBackend final : public Backend {
 public:
  ~CoreAudioBackend() override { close(); }
  std::string name() const override { return "coreaudio"; }

  std::vector<DeviceInfo> devices() override {
    std::vector<DeviceInfo> out;
    AudioDeviceID def = kAudioObjectUnknown;
    getProp(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultOutputDevice, def);
    for (AudioDeviceID d : getArray<AudioDeviceID>(kAudioObjectSystemObject, kAudioHardwarePropertyDevices)) {
      int ch = outputChannels(d);
      if (ch <= 0) continue;
      DeviceInfo info;
      info.id = stringProp(d, kAudioDevicePropertyDeviceUID);
      info.name = stringProp(d, kAudioObjectPropertyName);
      info.isDefault = d == def;
      Float64 rate = 0;
      getProp(d, kAudioDevicePropertyNominalSampleRate, rate);
      info.mix = {uint32_t(rate), uint16_t(std::min(ch, 8)), 32, 32, true};
      out.push_back(info);
    }
    return out;
  }

  bool open(const OpenRequest& req, DeviceFormat& out, std::string& err) override {
    close();
    dev_ = findDevice(req.deviceId);
    if (dev_ == kAudioObjectUnknown) return (err = "tidak ada perangkat keluaran", false);
    auto streams = getArray<AudioStreamID>(dev_, kAudioDevicePropertyStreams, kAudioDevicePropertyScopeOutput);
    if (streams.empty()) return (err = "perangkat tanpa stream keluaran", false);
    stream_ = streams[0];
    exclusive_ = req.mode == OutputMode::Exclusive;
    getProp(dev_, kAudioDevicePropertyNominalSampleRate, origRate_);

    if (exclusive_) {
      // 1) hog mode: perangkat hanya untuk proses ini
      pid_t owner = -1;
      getProp(dev_, kAudioDevicePropertyHogMode, owner);
      if (owner != -1 && owner != getpid()) return (err = osText(kAudioDevicePermissionsError), false);
      pid_t me = getpid();
      OSStatus st = setProp(dev_, kAudioDevicePropertyHogMode, me);
      pid_t now = -1;
      getProp(dev_, kAudioDevicePropertyHogMode, now);
      if (st != noErr || now != getpid()) return (err = "hog mode ditolak: " + osText(st), false);
      hogged_ = true;
      // 2) pilih format fisik: rate sumber → keluarga sama → lain; bit persis → container lebih besar
      getProp(stream_, kAudioStreamPropertyPhysicalFormat, origPhys_);
      havePhys_ = true;
      auto avail = getArray<AudioStreamRangedDescription>(stream_, kAudioStreamPropertyAvailablePhysicalFormats);
      const UInt32 wantCh = req.channels == 1 ? 2 : req.channels;
      bool found = false;
      AudioStreamBasicDescription pick{};
      for (uint32_t r : rateCandidates(req.rate)) {
        for (auto [c, v] : bitCandidates(req.bits, req.srcFloat)) {
          // utamakan jumlah kanal = sumber, lalu kanal apa pun ≥ 2
          for (int pass = 0; pass < 2 && !found; pass++) {
            for (auto& rd : avail) {
              const auto& f = rd.mFormat;
              if (!matchesInt(f, c, v)) continue;
              if (pass == 0 ? f.mChannelsPerFrame != wantCh : f.mChannelsPerFrame < 2) continue;
              if (r < rd.mSampleRateRange.mMinimum - 0.5 || r > rd.mSampleRateRange.mMaximum + 0.5) continue;
              pick = f;
              pick.mSampleRate = r;
              found = true;
              break;
            }
          }
          if (found) break;
        }
        if (found) break;
      }
      if (!found) return (err = "perangkat tidak menyediakan format integer yang cocok (coba mode Shared)", false);
      // 3) set sample rate perangkat & format fisik, tunggu hingga diterapkan
      Float64 rate = pick.mSampleRate;
      setProp(dev_, kAudioDevicePropertyNominalSampleRate, rate);
      OSStatus st2 = setProp(stream_, kAudioStreamPropertyPhysicalFormat, pick);
      if (st2 != noErr) return (err = "format fisik ditolak: " + osText(st2), false);
      for (int i = 0; i < 100; i++) {
        AudioStreamBasicDescription cur{};
        Float64 nr = 0;
        getProp(stream_, kAudioStreamPropertyPhysicalFormat, cur);
        getProp(dev_, kAudioDevicePropertyNominalSampleRate, nr);
        if (std::abs(nr - rate) < 0.5 && cur.mBitsPerChannel == pick.mBitsPerChannel) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
      }
      // 4) matikan mixing → IOProc menerima buffer dalam format fisik (integer), tanpa konversi HAL
      UInt32 mixing = 1;
      if (getProp(dev_, kAudioDevicePropertySupportsMixing, mixing)) {
        origMixing_ = mixing;
        UInt32 off = 0;
        if (setProp(dev_, kAudioDevicePropertySupportsMixing, off) == noErr) mixingChanged_ = true;
      }
      fmt_.rate = uint32_t(pick.mSampleRate);
      fmt_.channels = uint16_t(pick.mChannelsPerFrame);
      fmt_.containerBits = uint16_t(pick.mBytesPerFrame / pick.mChannelsPerFrame * 8);
      fmt_.validBits = uint16_t(pick.mBitsPerChannel);
      fmt_.isFloat = false;
    } else {
      AudioStreamBasicDescription vf{};
      getProp(stream_, kAudioStreamPropertyVirtualFormat, vf);
      fmt_.rate = uint32_t(origRate_ > 0 ? origRate_ : vf.mSampleRate);
      fmt_.channels = uint16_t(std::max<UInt32>(1, vf.mChannelsPerFrame));
      fmt_.containerBits = 32;
      fmt_.validBits = 32;
      fmt_.isFloat = true;
    }
    UInt32 frames = req.bufferFrames;
    setProp(dev_, kAudioDevicePropertyBufferFrameSize, frames, kAudioDevicePropertyScopeOutput);
    getProp(dev_, kAudioDevicePropertyBufferFrameSize, frames, kAudioDevicePropertyScopeOutput);
    UInt32 devLat = 0, safety = 0, strLat = 0;
    getProp(dev_, kAudioDevicePropertyLatency, devLat, kAudioDevicePropertyScopeOutput);
    getProp(dev_, kAudioDevicePropertySafetyOffset, safety, kAudioDevicePropertyScopeOutput);
    getProp(stream_, kAudioStreamPropertyLatency, strLat);
    latency_ = double(frames + devLat + safety + strLat) / fmt_.rate;
    OSStatus st = AudioDeviceCreateIOProcID(dev_, &CoreAudioBackend::ioProc, this, &proc_);
    if (st != noErr) return (err = "IOProc: " + osText(st), false);
    out = fmt_;
    return true;
  }

  bool start(RenderCallback cb, std::string& err) override {
    cb_ = std::move(cb);
    OSStatus st = AudioDeviceStart(dev_, proc_);
    if (st != noErr) return (err = "AudioDeviceStart: " + osText(st), false);
    running_ = true;
    return true;
  }

  void close() override {
    if (dev_ != kAudioObjectUnknown && proc_) {
      if (running_) AudioDeviceStop(dev_, proc_);
      AudioDeviceDestroyIOProcID(dev_, proc_);
    }
    running_ = false;
    proc_ = nullptr;
    if (dev_ != kAudioObjectUnknown) {
      // kembalikan perangkat seperti semula untuk aplikasi lain
      if (mixingChanged_) setProp(dev_, kAudioDevicePropertySupportsMixing, origMixing_);
      if (havePhys_ && stream_) setProp(stream_, kAudioStreamPropertyPhysicalFormat, origPhys_);
      if (exclusive_ && origRate_ > 0) setProp(dev_, kAudioDevicePropertyNominalSampleRate, origRate_);
      if (hogged_) {
        pid_t none = -1;
        setProp(dev_, kAudioDevicePropertyHogMode, none);
      }
    }
    mixingChanged_ = havePhys_ = hogged_ = false;
    dev_ = kAudioObjectUnknown;
    stream_ = 0;
  }

  double latency() const override { return latency_; }

 private:
  AudioDeviceID findDevice(const std::string& uid) {
    AudioDeviceID dev = kAudioObjectUnknown;
    if (!uid.empty()) {
      CFStringRef s = CFStringCreateWithCString(nullptr, uid.c_str(), kCFStringEncodingUTF8);
      auto a = addr(kAudioHardwarePropertyTranslateUIDToDevice);
      UInt32 size = sizeof dev;
      AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, sizeof(CFStringRef), &s, &size, &dev);
      CFRelease(s);
    }
    if (dev == kAudioObjectUnknown) getProp(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultOutputDevice, dev);
    return dev;
  }

  static OSStatus ioProc(AudioObjectID, const AudioTimeStamp*, const AudioBufferList*, const AudioTimeStamp*, AudioBufferList* out,
                         const AudioTimeStamp*, void* self) {
    auto* b = static_cast<CoreAudioBackend*>(self);
    if (!out || out->mNumberBuffers == 0) return noErr;
    AudioBuffer& buf = out->mBuffers[0];
    const UInt32 bpf = b->fmt_.bytesPerFrame();
    if (buf.mData && bpf && buf.mNumberChannels == b->fmt_.channels) {
      UInt32 frames = buf.mDataByteSize / bpf;
      if (b->cb_) b->cb_(static_cast<uint8_t*>(buf.mData), frames);
      else memset(buf.mData, 0, buf.mDataByteSize);
    } else if (buf.mData) {
      memset(buf.mData, 0, buf.mDataByteSize);
    }
    for (UInt32 i = 1; i < out->mNumberBuffers; i++)
      if (out->mBuffers[i].mData) memset(out->mBuffers[i].mData, 0, out->mBuffers[i].mDataByteSize);
    return noErr;
  }

  AudioDeviceID dev_ = kAudioObjectUnknown;
  AudioStreamID stream_ = 0;
  AudioDeviceIOProcID proc_ = nullptr;
  bool exclusive_ = false, hogged_ = false, havePhys_ = false, mixingChanged_ = false;
  AudioStreamBasicDescription origPhys_{};
  Float64 origRate_ = 0;
  UInt32 origMixing_ = 1;
  DeviceFormat fmt_;
  double latency_ = 0;
  RenderCallback cb_;
  std::atomic<bool> running_{false};
};

}  // namespace

std::unique_ptr<Backend> createSystemBackend() { return std::make_unique<CoreAudioBackend>(); }

}  // namespace ritm
#endif
