// Backend Linux: ALSA.
//  Exclusive = perangkat hw: (bit-perfect, tanpa plugin rate/format).
//  Shared    = "default" / plughw: lewat mixer/plugin ALSA.
#if defined(__linux__)
#include <alsa/asoundlib.h>

#include <atomic>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

#include "backend.hpp"

namespace ritm {
namespace {

struct AlsaFormat {
  snd_pcm_format_t fmt = SND_PCM_FORMAT_UNKNOWN;
  uint16_t container = 0;
  uint16_t valid = 0;
  bool isFloat = false;
};

AlsaFormat mapBits(uint16_t container, uint16_t valid, bool /*srcFloat*/) {
  if (container == 16 && valid == 16) return {SND_PCM_FORMAT_S16_LE, 16, 16, false};
  if (container == 24 && valid == 24) return {SND_PCM_FORMAT_S24_3LE, 24, 24, false};
  if (container == 32 && valid == 24) return {SND_PCM_FORMAT_S32_LE, 32, 24, false};
  if (container == 32 && valid == 32) return {SND_PCM_FORMAT_S32_LE, 32, 32, false};
  return {};
}

std::string alsaErr(int e) {
  return e < 0 ? snd_strerror(e) : "ok";
}

class AlsaBackend final : public Backend {
 public:
  ~AlsaBackend() override { close(); }
  std::string name() const override { return "alsa"; }

  std::vector<DeviceInfo> devices() override {
    std::vector<DeviceInfo> out;
    void** hints = nullptr;
    if (snd_device_name_hint(-1, "pcm", &hints) < 0) return out;
    std::string defName = "default";
    // perangkat bawaan sistem
    {
      DeviceInfo d;
      d.id = "default";
      d.name = "Bawaan sistem (ALSA default)";
      d.isDefault = true;
      d.mix = {48000, 2, 32, 32, true};
      out.push_back(d);
    }
    for (void** h = hints; *h; ++h) {
      char* name = snd_device_name_get_hint(*h, "NAME");
      char* desc = snd_device_name_get_hint(*h, "DESC");
      char* ioid = snd_device_name_get_hint(*h, "IOID");
      // hanya keluaran (atau null = dua arah)
      bool skip = ioid && std::strcmp(ioid, "Input") == 0;
      if (!skip && name && std::strcmp(name, "null") != 0) {
        // utamakan hw: / plughw: / default; lewati duplikat default
        std::string id = name;
        if (id == "default") {
          free(name);
          free(desc);
          free(ioid);
          continue;
        }
        bool useful = id.rfind("hw:", 0) == 0 || id.rfind("plughw:", 0) == 0 || id.rfind("sysdefault:", 0) == 0 ||
                      id.find("card") != std::string::npos;
        // tetap tampilkan perangkat hw/plughw; perangkat lain yang jelas output juga boleh
        if (useful || id.rfind("hdmi:", 0) == 0 || id.rfind("usbstream:", 0) == 0) {
          DeviceInfo d;
          d.id = id;
          if (desc) {
            // DESC bisa multi-baris; ambil baris pertama
            std::string s = desc;
            auto n = s.find('\n');
            d.name = n == std::string::npos ? s : s.substr(0, n);
          } else {
            d.name = id;
          }
          d.isDefault = false;
          d.mix = probeMix(id);
          out.push_back(d);
        }
      }
      free(name);
      free(desc);
      free(ioid);
    }
    snd_device_name_free_hint(hints);
    return out;
  }

  bool open(const OpenRequest& req, DeviceFormat& out, std::string& err) override {
    close();
    mode_ = req.mode;
    const uint16_t ch = req.channels == 1 ? 2 : std::min<uint16_t>(req.channels, 8);
    bufferFrames_ = req.bufferFrames ? req.bufferFrames : 1024;

    if (req.mode == OutputMode::Shared) {
      std::string id = req.deviceId.empty() ? "default" : req.deviceId;
      // Shared: izinkan plugin (plughw/default) mengubah format
      if (id.rfind("hw:", 0) == 0) id = "plug" + id;  // hw:X → plughw:X
      int e = snd_pcm_open(&pcm_, id.c_str(), SND_PCM_STREAM_PLAYBACK, 0);
      if (e < 0) return (err = std::string("membuka ") + id + ": " + alsaErr(e), false);
      // float32 @ rate perangkat / 48000 — mirip mixer Shared
      uint32_t rate = 48000;
      snd_pcm_hw_params_t* hw = nullptr;
      snd_pcm_hw_params_alloca(&hw);
      snd_pcm_hw_params_any(pcm_, hw);
      snd_pcm_hw_params_set_access(pcm_, hw, SND_PCM_ACCESS_RW_INTERLEAVED);
      snd_pcm_hw_params_set_format(pcm_, hw, SND_PCM_FORMAT_FLOAT_LE);
      snd_pcm_hw_params_set_channels(pcm_, hw, ch);
      snd_pcm_hw_params_set_rate_near(pcm_, hw, &rate, nullptr);
      snd_pcm_uframes_t frames = bufferFrames_;
      snd_pcm_hw_params_set_period_size_near(pcm_, hw, &frames, nullptr);
      snd_pcm_uframes_t whole = frames * 2;
      snd_pcm_hw_params_set_buffer_size_near(pcm_, hw, &whole);
      e = snd_pcm_hw_params(pcm_, hw);
      if (e < 0) return (err = std::string("Shared hw_params: ") + alsaErr(e), false);
      snd_pcm_hw_params_get_period_size(hw, &frames, nullptr);
      bufferFrames_ = uint32_t(frames);
      fmt_ = {rate, ch, 32, 32, true};
      latency_ = double(whole) / rate;
      out = fmt_;
      return true;
    }

    // Exclusive: hanya hw: — tanpa resample/plugin
    std::string id = pickHwDevice(req.deviceId);
    if (id.empty()) return (err = "tidak ada perangkat hw: untuk mode Exclusive", false);
    int e = snd_pcm_open(&pcm_, id.c_str(), SND_PCM_STREAM_PLAYBACK, 0);
    if (e < 0) return (err = std::string("membuka ") + id + ": " + alsaErr(e), false);

    bool found = false;
    AlsaFormat chosen{};
    uint32_t chosenRate = 0;
    for (uint32_t r : rateCandidates(req.rate)) {
      for (auto [c, v] : bitCandidates(req.bits, req.srcFloat)) {
        AlsaFormat af = mapBits(c, v, false);
        if (af.fmt == SND_PCM_FORMAT_UNKNOWN) continue;
        if (tryParams(r, ch, af, bufferFrames_, false)) {
          chosen = af;
          chosenRate = r;
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) {
      AlsaFormat af = {SND_PCM_FORMAT_FLOAT_LE, 32, 32, true};
      if (tryParams(req.rate, ch, af, bufferFrames_, false)) {
        chosen = af;
        chosenRate = req.rate;
        found = true;
      }
    }
    if (!found) return (err = "perangkat tidak menerima format exclusive apa pun (coba mode Shared)", false);

    // terapkan parameter yang dipilih
    if (!tryParams(chosenRate, ch, chosen, bufferFrames_, true))
      return (err = "gagal menerapkan format Exclusive", false);

    fmt_ = {chosenRate, ch, chosen.container, chosen.valid, chosen.isFloat};
    snd_pcm_uframes_t buf = 0, period = 0;
    snd_pcm_get_params(pcm_, &buf, &period);
    if (period) bufferFrames_ = uint32_t(period);
    latency_ = double(buf ? buf : bufferFrames_ * 2) / fmt_.rate;
    out = fmt_;
    return true;
  }

  bool start(RenderCallback cb, std::string& err) override {
    if (!pcm_) return (err = "perangkat belum dibuka", false);
    cb_ = std::move(cb);
    int e = snd_pcm_prepare(pcm_);
    if (e < 0) return (err = std::string("prepare: ") + alsaErr(e), false);
    running_ = true;
    thread_ = std::thread([this] { loop(); });
    return true;
  }

  void close() override {
    running_ = false;
    if (thread_.joinable()) thread_.join();
    if (pcm_) {
      snd_pcm_drop(pcm_);
      snd_pcm_close(pcm_);
      pcm_ = nullptr;
    }
  }

  double latency() const override { return latency_; }

 private:
  DeviceFormat probeMix(const std::string& id) {
    DeviceFormat mix{48000, 2, 32, 32, true};
    snd_pcm_t* p = nullptr;
    if (snd_pcm_open(&p, id.c_str(), SND_PCM_STREAM_PLAYBACK, SND_PCM_NONBLOCK) < 0) return mix;
    snd_pcm_hw_params_t* hw = nullptr;
    snd_pcm_hw_params_alloca(&hw);
    if (snd_pcm_hw_params_any(p, hw) >= 0) {
      unsigned rate = 48000;
      snd_pcm_hw_params_get_rate(hw, &rate, nullptr);
      // get_rate sebelum set sering gagal; coba rate_near dari current
      if (snd_pcm_hw_params_set_rate_near(p, hw, &rate, nullptr) >= 0) mix.rate = rate;
      unsigned ch = 2;
      if (snd_pcm_hw_params_get_channels_max(hw, &ch) >= 0 && ch > 0) mix.channels = uint16_t(std::min(ch, 8u));
    }
    snd_pcm_close(p);
    return mix;
  }

  std::string pickHwDevice(const std::string& want) {
    if (!want.empty()) {
      if (want.rfind("hw:", 0) == 0) return want;
      if (want.rfind("plughw:", 0) == 0) return "hw:" + want.substr(7);
      if (want == "default") {
        // cari hw: pertama
      } else {
        return want;  // coba apa adanya
      }
    }
    auto list = devices();
    for (auto& d : list)
      if (d.id.rfind("hw:", 0) == 0) return d.id;
    // fallback card 0
    return "hw:0,0";
  }

  bool tryParams(uint32_t rate, uint16_t ch, AlsaFormat af, uint32_t periodFrames, bool apply) {
    if (!pcm_) return false;
    snd_pcm_hw_params_t* hw = nullptr;
    snd_pcm_hw_params_alloca(&hw);
    if (snd_pcm_hw_params_any(pcm_, hw) < 0) return false;
    if (snd_pcm_hw_params_test_access(pcm_, hw, SND_PCM_ACCESS_RW_INTERLEAVED) < 0) return false;
    if (snd_pcm_hw_params_test_format(pcm_, hw, af.fmt) < 0) return false;
    if (snd_pcm_hw_params_test_channels(pcm_, hw, ch) < 0) return false;
    if (snd_pcm_hw_params_test_rate(pcm_, hw, rate, 0) < 0) return false;
    if (!apply) return true;
    if (snd_pcm_hw_params_set_access(pcm_, hw, SND_PCM_ACCESS_RW_INTERLEAVED) < 0) return false;
    if (snd_pcm_hw_params_set_format(pcm_, hw, af.fmt) < 0) return false;
    if (snd_pcm_hw_params_set_channels(pcm_, hw, ch) < 0) return false;
    snd_pcm_hw_params_set_rate_resample(pcm_, hw, 0);
    if (snd_pcm_hw_params_set_rate(pcm_, hw, rate, 0) < 0) return false;
    snd_pcm_uframes_t period = periodFrames;
    if (snd_pcm_hw_params_set_period_size_near(pcm_, hw, &period, nullptr) < 0) return false;
    snd_pcm_uframes_t buf = period * 2;
    snd_pcm_hw_params_set_buffer_size_near(pcm_, hw, &buf);
    return snd_pcm_hw_params(pcm_, hw) >= 0;
  }

  void loop() {
    const size_t bpf = fmt_.bytesPerFrame();
    std::vector<uint8_t> buf(size_t(bufferFrames_) * bpf);
    while (running_) {
      if (!pcm_) break;
      snd_pcm_sframes_t avail = snd_pcm_avail_update(pcm_);
      if (avail == -EPIPE) {
        snd_pcm_prepare(pcm_);
        continue;
      }
      if (avail < 0) {
        snd_pcm_recover(pcm_, int(avail), 1);
        continue;
      }
      if (avail == 0) {
        if (snd_pcm_wait(pcm_, 200) < 0) continue;
        continue;
      }
      uint32_t frames = uint32_t(std::min<snd_pcm_sframes_t>(avail, bufferFrames_));
      if (cb_) cb_(buf.data(), frames);
      else std::memset(buf.data(), 0, size_t(frames) * bpf);
      uint8_t* p = buf.data();
      uint32_t left = frames;
      while (left && running_) {
        snd_pcm_sframes_t w = snd_pcm_writei(pcm_, p, left);
        if (w == -EPIPE) {
          snd_pcm_prepare(pcm_);
          continue;
        }
        if (w < 0) {
          w = snd_pcm_recover(pcm_, int(w), 1);
          if (w < 0) break;
          continue;
        }
        p += size_t(w) * bpf;
        left -= uint32_t(w);
      }
    }
  }

  OutputMode mode_ = OutputMode::Exclusive;
  snd_pcm_t* pcm_ = nullptr;
  DeviceFormat fmt_;
  uint32_t bufferFrames_ = 1024;
  double latency_ = 0;
  RenderCallback cb_;
  std::atomic<bool> running_{false};
  std::thread thread_;
};

}  // namespace

std::unique_ptr<Backend> createAlsaBackend() { return std::make_unique<AlsaBackend>(); }

}  // namespace ritm
#endif
