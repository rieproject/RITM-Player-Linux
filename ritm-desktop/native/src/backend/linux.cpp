// Backend sistem Linux: mux ALSA / PipeWire sesuai pilihan pengguna (settings.backend).
#if defined(__linux__)
#include <memory>
#include <string>

#include "backend.hpp"

namespace ritm {
namespace {

class LinuxMuxBackend final : public Backend {
 public:
  std::string name() const override { return api_; }

  void setApi(const std::string& api) override {
    const std::string next = api == "pipewire" ? "pipewire" : "alsa";
    if (next == api_) return;
    if (active_) active_->close();
    active_ = nullptr;
    api_ = next;
  }

  std::vector<DeviceInfo> devices() override { return ensure().devices(); }

  bool open(const OpenRequest& req, DeviceFormat& out, std::string& err) override {
    auto& b = ensure();
    active_ = &b;
    return b.open(req, out, err);
  }

  bool start(RenderCallback cb, std::string& err) override {
    if (!active_) return (err = "backend Linux belum dibuka", false);
    return active_->start(std::move(cb), err);
  }

  void close() override {
    if (active_) active_->close();
  }

  double latency() const override { return active_ ? active_->latency() : 0; }

 private:
  Backend& ensure() {
    if (api_ == "pipewire") {
      if (!pw_) pw_ = createPipeWireBackend();
      return *pw_;
    }
    if (!alsa_) alsa_ = createAlsaBackend();
    return *alsa_;
  }

  std::string api_ = "alsa";
  std::unique_ptr<Backend> alsa_;
  std::unique_ptr<Backend> pw_;
  Backend* active_ = nullptr;
};

}  // namespace

std::unique_ptr<Backend> createSystemBackend() { return std::make_unique<LinuxMuxBackend>(); }

}  // namespace ritm
#endif
