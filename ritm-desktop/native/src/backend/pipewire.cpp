// Backend Linux: PipeWire.
//  Exclusive ≈ node.exclusive + jangan remix + rate dipaksa (sedekat mungkin bit-perfect).
//  Shared    = stream biasa lewat graph PipeWire (mixer desktop).
#if defined(__linux__)
#include <pipewire/pipewire.h>
#include <spa/param/audio/format-utils.h>
#include <spa/param/props.h>
#include <spa/utils/result.h>

#include <atomic>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "backend.hpp"

namespace ritm {
namespace {

spa_audio_format spaFmt(uint16_t container, uint16_t valid, bool isFloat) {
  if (isFloat) return SPA_AUDIO_FORMAT_F32_LE;
  if (container == 16) return SPA_AUDIO_FORMAT_S16_LE;
  if (container == 24) return SPA_AUDIO_FORMAT_S24_LE;  // 3 byte packed di SPA
  if (container == 32 && valid == 24) return SPA_AUDIO_FORMAT_S32_LE;
  if (container == 32) return SPA_AUDIO_FORMAT_S32_LE;
  return SPA_AUDIO_FORMAT_UNKNOWN;
}

class PipeWireBackend final : public Backend {
 public:
  PipeWireBackend() {
    pw_init(nullptr, nullptr);
  }
  ~PipeWireBackend() override {
    close();
    if (loop_) {
      pw_thread_loop_stop(loop_);
    }
    if (core_) {
      pw_core_disconnect(core_);
      core_ = nullptr;
    }
    if (context_) {
      pw_context_destroy(context_);
      context_ = nullptr;
    }
    if (loop_) {
      pw_thread_loop_destroy(loop_);
      loop_ = nullptr;
    }
    if (initialized_) pw_deinit();
  }
  std::string name() const override { return "pipewire"; }

  std::vector<DeviceInfo> devices() override {
    std::vector<DeviceInfo> out;
    DeviceInfo def;
    def.id = "";
    def.name = "Bawaan sistem (PipeWire)";
    def.isDefault = true;
    def.mix = {48000, 2, 32, 32, true};
    out.push_back(def);

    if (!ensureLoop() || !core_) return out;

    pw_thread_loop_lock(loop_);
    sinks_.clear();
    registry_ = pw_core_get_registry(core_, PW_VERSION_REGISTRY, 0);
    if (!registry_) {
      pw_thread_loop_unlock(loop_);
      return out;
    }
    static const pw_registry_events ev = {
        .version = PW_VERSION_REGISTRY_EVENTS,
        .global = &PipeWireBackend::onGlobal,
        .global_remove = nullptr,
    };
    registryListener_ = {};
    pw_registry_add_listener(registry_, &registryListener_, &ev, this);
    syncWait();
    spa_hook_remove(&registryListener_);
    pw_proxy_destroy(reinterpret_cast<pw_proxy*>(registry_));
    registry_ = nullptr;
    pw_thread_loop_unlock(loop_);

    for (auto& s : sinks_) {
      DeviceInfo d;
      d.id = std::to_string(s.id);
      d.name = s.name.empty() ? ("Sink #" + d.id) : s.name;
      d.isDefault = false;
      d.mix = {s.rate ? s.rate : 48000, 2, 32, 32, true};
      out.push_back(d);
    }
    return out;
  }

  bool open(const OpenRequest& req, DeviceFormat& out, std::string& err) override {
    close();
    if (!ensureLoop() || !core_) {
      err = "Gagal terhubung ke daemon PipeWire";
      return false;
    }
    exclusive_ = req.mode == OutputMode::Exclusive;
    bufferFrames_ = req.bufferFrames ? req.bufferFrames : 1024;
    const uint16_t ch = req.channels == 1 ? 2 : std::min<uint16_t>(req.channels, 8);
    targetId_ = PW_ID_ANY;
    if (!req.deviceId.empty()) {
      try {
        targetId_ = uint32_t(std::stoul(req.deviceId));
      } catch (...) {
        targetId_ = PW_ID_ANY;
      }
    }

    if (req.mode == OutputMode::Shared) {
      fmt_ = {48000, ch, 32, 32, true};
      if (!connectStream(fmt_, err)) return false;
      out = fmt_;
      latency_ = double(bufferFrames_) / fmt_.rate;
      return true;
    }

    // Exclusive: negosiasi format sumber
    bool found = false;
    DeviceFormat pick{};
    for (uint32_t r : rateCandidates(req.rate)) {
      for (auto [c, v] : bitCandidates(req.bits, req.srcFloat)) {
        if (spaFmt(c, v, false) == SPA_AUDIO_FORMAT_UNKNOWN) continue;
        pick = {r, ch, c, v, false};
        found = true;
        break;
      }
      if (found) break;
    }
    if (!found) {
      pick = {req.rate, ch, 32, 32, true};
    }
    fmt_ = pick;
    if (!connectStream(fmt_, err)) return false;
    latency_ = double(bufferFrames_) / fmt_.rate;
    out = fmt_;
    return true;
  }

  bool start(RenderCallback cb, std::string& err) override {
    if (!stream_) return (err = "stream PipeWire belum dibuka", false);
    cb_ = std::move(cb);
    pw_thread_loop_lock(loop_);
    pw_stream_set_active(stream_, true);
    pw_thread_loop_unlock(loop_);
    running_ = true;
    return true;
  }

  void close() override {
    running_ = false;
    cb_ = nullptr;
    if (!loop_) return;
    pw_thread_loop_lock(loop_);
    if (stream_) {
      pw_stream_set_active(stream_, false);
      pw_stream_disconnect(stream_);
      pw_stream_destroy(stream_);
      stream_ = nullptr;
    }
    pw_thread_loop_unlock(loop_);
  }

  double latency() const override { return latency_; }

 private:
  struct SinkInfo {
    uint32_t id = 0;
    std::string name;
    uint32_t rate = 0;
  };

  bool ensureLoop() {
    if (core_) return true;
    if (!loop_) {
      loop_ = pw_thread_loop_new("ritm-audio", nullptr);
      if (!loop_) return false;
    }
    pw_thread_loop_lock(loop_);
    if (!context_) {
      context_ = pw_context_new(pw_thread_loop_get_loop(loop_), nullptr, 0);
      if (!context_) {
        pw_thread_loop_unlock(loop_);
        return false;
      }
    }
    core_ = pw_context_connect(context_, nullptr, 0);
    if (!core_) {
      pw_thread_loop_unlock(loop_);
      return false;
    }
    pw_thread_loop_start(loop_);
    // tunggu core terhubung
    syncWait();
    pw_thread_loop_unlock(loop_);
    initialized_ = true;
    return true;
  }

  void syncWait() {
    if (!core_ || !loop_) return;
    // kirim sync dan tunggu done
    struct Data {
      PipeWireBackend* self;
      int seq;
      bool done;
    } data{this, 0, false};
    static const pw_core_events ev = {
        .version = PW_VERSION_CORE_EVENTS,
        .info = nullptr,
        .done =
            [](void* d, uint32_t /*id*/, int seq) {
              auto* x = static_cast<Data*>(d);
              if (seq == x->seq) {
                x->done = true;
                pw_thread_loop_signal(x->self->loop_, false);
              }
            },
        .ping = nullptr,
        .error = nullptr,
        .remove_id = nullptr,
        .bound_id = nullptr,
        .add_mem = nullptr,
        .remove_mem = nullptr,
        .bound_props = nullptr,
    };
    spa_hook listener{};
    pw_core_add_listener(core_, &listener, &ev, &data);
    data.seq = pw_core_sync(core_, PW_ID_CORE, 0);
    while (!data.done) pw_thread_loop_wait(loop_);
    spa_hook_remove(&listener);
  }

  static void onGlobal(void* data, uint32_t id, uint32_t /*permissions*/, const char* type, uint32_t /*version*/,
                       const spa_dict* props) {
    auto* self = static_cast<PipeWireBackend*>(data);
    if (!type || std::strcmp(type, PW_TYPE_INTERFACE_Node) != 0 || !props) return;
    const char* klass = spa_dict_lookup(props, PW_KEY_MEDIA_CLASS);
    if (!klass || std::strcmp(klass, "Audio/Sink") != 0) return;
    SinkInfo s;
    s.id = id;
    if (const char* n = spa_dict_lookup(props, PW_KEY_NODE_DESCRIPTION)) s.name = n;
    else if (const char* n = spa_dict_lookup(props, PW_KEY_NODE_NAME)) s.name = n;
    if (const char* r = spa_dict_lookup(props, PW_KEY_AUDIO_RATE)) {
      try {
        s.rate = uint32_t(std::stoul(r));
      } catch (...) {
      }
    }
    self->sinks_.push_back(std::move(s));
  }

  bool connectStream(const DeviceFormat& fmt, std::string& err) {
    pw_thread_loop_lock(loop_);

    pw_properties* props = pw_properties_new(
        PW_KEY_MEDIA_TYPE, "Audio",
        PW_KEY_MEDIA_CATEGORY, "Playback",
        PW_KEY_MEDIA_ROLE, "Music",
        PW_KEY_NODE_NAME, "ritm-audio",
        PW_KEY_NODE_DESCRIPTION, "RITM Player",
        nullptr);
    if (exclusive_) {
      pw_properties_set(props, "node.exclusive", "true");
      pw_properties_set(props, "stream.dont-remix", "true");
      pw_properties_setf(props, PW_KEY_NODE_FORCE_RATE, "%u", fmt.rate);
      pw_properties_setf(props, PW_KEY_NODE_RATE, "1/%u", fmt.rate);
    }
    if (targetId_ != PW_ID_ANY) pw_properties_setf(props, PW_KEY_TARGET_OBJECT, "%u", targetId_);

    static const pw_stream_events ev = {
        .version = PW_VERSION_STREAM_EVENTS,
        .destroy = nullptr,
        .state_changed = &PipeWireBackend::onState,
        .control_info = nullptr,
        .io_changed = nullptr,
        .param_changed = nullptr,
        .add_buffer = nullptr,
        .remove_buffer = nullptr,
        .process = &PipeWireBackend::onProcess,
        .drained = nullptr,
        .command = nullptr,
        .trigger_done = nullptr,
    };

    stream_ = pw_stream_new(core_, "ritm-audio", props);
    streamListener_ = {};
    pw_stream_add_listener(stream_, &streamListener_, &ev, this);

    spa_audio_info_raw info{};
    info.format = spaFmt(fmt.containerBits, fmt.validBits, fmt.isFloat);
    if (info.format == SPA_AUDIO_FORMAT_UNKNOWN) info.format = SPA_AUDIO_FORMAT_F32_LE;
    info.channels = fmt.channels;
    info.rate = fmt.rate;
    for (uint32_t i = 0; i < info.channels; i++)
      info.position[i] = i == 0 ? SPA_AUDIO_CHANNEL_FL : i == 1 ? SPA_AUDIO_CHANNEL_FR : static_cast<spa_audio_channel>(SPA_AUDIO_CHANNEL_AUX0 + (i - 2));

    uint8_t buffer[1024];
    spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, sizeof buffer);
    const spa_pod* params[1];
    params[0] = spa_format_audio_raw_build(&b, SPA_PARAM_EnumFormat, &info);

    auto flags = pw_stream_flags(PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS | PW_STREAM_FLAG_RT_PROCESS);
    int e = pw_stream_connect(stream_, PW_DIRECTION_OUTPUT, targetId_, flags, params, 1);
    if (e < 0) {
      pw_thread_loop_unlock(loop_);
      err = std::string("PipeWire connect: ") + spa_strerror(e);
      return false;
    }
    // tunggu stream paused/streaming
    for (int i = 0; i < 50 && streamState_ == PW_STREAM_STATE_CONNECTING; i++) {
      pw_thread_loop_timed_wait(loop_, 1);  // hingga 1 detik total kasar via signal
      // fallback sleep via unlock/lock
      pw_thread_loop_unlock(loop_);
      timespec ts{0, 20 * 1000 * 1000};
      nanosleep(&ts, nullptr);
      pw_thread_loop_lock(loop_);
      if (streamState_ == PW_STREAM_STATE_ERROR) break;
    }
    bool ok = streamState_ == PW_STREAM_STATE_PAUSED || streamState_ == PW_STREAM_STATE_STREAMING;
    if (!ok) err = streamError_.empty() ? "PipeWire gagal menghubungkan stream" : streamError_;
    pw_thread_loop_unlock(loop_);
    return ok;
  }

  static void onState(void* data, pw_stream_state /*old*/, pw_stream_state state, const char* error) {
    auto* self = static_cast<PipeWireBackend*>(data);
    self->streamState_ = state;
    if (error) self->streamError_ = error;
    pw_thread_loop_signal(self->loop_, false);
  }

  static void onProcess(void* data) {
    auto* self = static_cast<PipeWireBackend*>(data);
    pw_buffer* b = pw_stream_dequeue_buffer(self->stream_);
    if (!b) return;
    spa_buffer* buf = b->buffer;
    spa_data* d = &buf->datas[0];
    if (!d->data) {
      pw_stream_queue_buffer(self->stream_, b);
      return;
    }
    const uint32_t stride = self->fmt_.bytesPerFrame();
    uint32_t n = d->maxsize / stride;
    if (b->requested) n = std::min(n, uint32_t(b->requested));
    if (n > self->bufferFrames_ * 4) n = self->bufferFrames_ * 4;
    if (self->cb_ && self->running_) self->cb_(static_cast<uint8_t*>(d->data), n);
    else std::memset(d->data, 0, size_t(n) * stride);
    d->chunk->offset = 0;
    d->chunk->stride = int32_t(stride);
    d->chunk->size = n * stride;
    pw_stream_queue_buffer(self->stream_, b);
  }

  bool initialized_ = false;
  bool exclusive_ = false;
  pw_thread_loop* loop_ = nullptr;
  pw_context* context_ = nullptr;
  pw_core* core_ = nullptr;
  pw_registry* registry_ = nullptr;
  spa_hook registryListener_{};
  pw_stream* stream_ = nullptr;
  spa_hook streamListener_{};
  pw_stream_state streamState_ = PW_STREAM_STATE_UNCONNECTED;
  std::string streamError_;
  uint32_t targetId_ = PW_ID_ANY;
  std::vector<SinkInfo> sinks_;
  DeviceFormat fmt_;
  uint32_t bufferFrames_ = 1024;
  double latency_ = 0;
  RenderCallback cb_;
  std::atomic<bool> running_{false};
};

}  // namespace

std::unique_ptr<Backend> createPipeWireBackend() { return std::make_unique<PipeWireBackend>(); }

}  // namespace ritm
#endif
