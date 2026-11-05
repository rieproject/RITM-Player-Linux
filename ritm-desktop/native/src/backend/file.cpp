// Sink uji: menulis keluaran perangkat ke WAV, dengan kemampuan format yang bisa diatur,
// untuk menguji negosiasi format & bit-perfect tanpa kartu suara.
// spec: "file:out.wav;rates=44100,96000;bits=16,24,32/24;mix=48000;ch=8" (ch = kanal maksimal perangkat, bawaan 2)
#include <atomic>
#include <chrono>
#include <cstring>
#include <sstream>
#include <thread>

#include "../io.hpp"
#include "backend.hpp"

namespace ritm {
namespace {

class FileBackend final : public Backend {
 public:
  explicit FileBackend(const std::string& spec) {
    std::string s = spec.substr(spec.find(':') + 1);
    std::stringstream ss(s);
    std::string part;
    bool first = true;
    while (std::getline(ss, part, ';')) {
      if (first) {
        path_ = part;
        first = false;
        continue;
      }
      auto eq = part.find('=');
      std::string k = part.substr(0, eq), v = part.substr(eq + 1);
      std::stringstream vs(v);
      std::string item;
      while (std::getline(vs, item, ',')) {
        if (k == "rates") rates_.push_back(uint32_t(std::stoul(item)));
        else if (k == "bits") {
          auto sl = item.find('/');
          uint16_t c = uint16_t(std::stoi(item.substr(0, sl)));
          uint16_t val = sl == std::string::npos ? c : uint16_t(std::stoi(item.substr(sl + 1)));
          bits_.push_back({c, val});
        } else if (k == "mix") mix_ = uint32_t(std::stoul(item));
        else if (k == "speed") speed_ = std::stod(item);
        else if (k == "ch") maxCh_ = uint16_t(std::stoi(item));
      }
    }
    if (rates_.empty()) rates_ = {44100, 48000, 96000};
    if (bits_.empty()) bits_ = {{16, 16}, {32, 24}};
  }
  ~FileBackend() override { close(); }
  std::string name() const override { return "file"; }
  std::vector<DeviceInfo> devices() override {
    DeviceInfo d;
    d.id = "file";
    d.name = "File sink (" + path_ + ")";
    d.isDefault = true;
    d.mix = {mix_, 2, 32, 32, true};
    return {d};
  }
  bool open(const OpenRequest& req, DeviceFormat& out, std::string& err) override {
    close();
    req_ = req;
    if (req.mode == OutputMode::Shared) {
      fmt_ = {mix_, 2, 32, 32, true};
    } else {
      bool found = false;
      for (uint32_t r : rateCandidates(req.rate)) {
        if (std::find(rates_.begin(), rates_.end(), r) == rates_.end()) continue;
        for (auto [c, v] : bitCandidates(req.bits, req.srcFloat)) {
          for (auto [bc, bv] : bits_)
            if (bc == c && bv == v) {
              fmt_ = {r, uint16_t(std::min<int>(maxCh_, req.channels == 1 ? 2 : req.channels)), c, v, false};
              found = true;
              break;
            }
          if (found) break;
        }
        if (found) break;
      }
      if (!found) return (err = "tidak ada format yang cocok", false);
    }
    out = fmt_;
    return true;
  }
  bool start(RenderCallback cb, std::string& err) override {
    f_ = openUtf8(path_, "wb");
    if (!f_) return (err = "tidak bisa menulis " + path_, false);
    writeHeader(0);
    running_ = true;
    thread_ = std::thread([this, cb] {
      std::vector<uint8_t> buf(size_t(req_.bufferFrames) * fmt_.bytesPerFrame());
      while (running_) {
        uint32_t got = cb(buf.data(), req_.bufferFrames);
        // data yang sudah diambil dari ring tetap ditulis walau stop datang bersamaan
        if (got == 0) {
          if (!running_) break;
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
          continue;
        }
        size_t n = size_t(got) * fmt_.bytesPerFrame();
        fwrite(buf.data(), 1, n, f_);
        bytes_ += n;
        if (speed_ > 0)  // simulasi waktu nyata (×speed) untuk menguji event posisi
          std::this_thread::sleep_for(std::chrono::duration<double>(double(got) / fmt_.rate / speed_));
      }
    });
    return true;
  }
  void close() override {
    running_ = false;
    if (thread_.joinable()) thread_.join();
    if (f_) {
      writeHeader(bytes_);
      fclose(f_);
      f_ = nullptr;
    }
    bytes_ = 0;
  }
  double latency() const override { return 0; }
  bool blocking() const override { return true; }

 private:
  void writeHeader(uint64_t dataBytes) {
    auto le16 = [&](uint16_t v) { fwrite(&v, 2, 1, f_); };
    auto le32 = [&](uint32_t v) { fwrite(&v, 4, 1, f_); };
    fseek(f_, 0, SEEK_SET);
    fwrite("RIFF", 1, 4, f_);
    le32(uint32_t(36 + 24 + dataBytes));
    fwrite("WAVEfmt ", 1, 8, f_);
    le32(40);
    le16(0xFFFE);
    le16(fmt_.channels);
    le32(fmt_.rate);
    le32(fmt_.rate * fmt_.bytesPerFrame());
    le16(uint16_t(fmt_.bytesPerFrame()));
    le16(fmt_.containerBits);
    le16(22);
    le16(fmt_.validBits);
    le32(3);  // channel mask FL|FR
    // SubFormat GUID: PCM {00000001-0000-0010-8000-00aa00389b71} atau IEEE float {00000003-...}
    uint8_t guid[16] = {uint8_t(fmt_.isFloat ? 3 : 1), 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71};
    fwrite(guid, 1, 16, f_);
    fwrite("data", 1, 4, f_);
    le32(uint32_t(dataBytes));
    fseek(f_, 0, SEEK_END);
  }

  std::string path_;
  std::vector<uint32_t> rates_;
  std::vector<std::pair<uint16_t, uint16_t>> bits_;
  uint32_t mix_ = 48000;
  double speed_ = 0;
  uint16_t maxCh_ = 2;
  OpenRequest req_;
  DeviceFormat fmt_;
  FILE* f_ = nullptr;
  uint64_t bytes_ = 0;
  std::atomic<bool> running_{false};
  std::thread thread_;
};

}  // namespace

std::unique_ptr<Backend> createFileBackend(const std::string& spec) { return std::make_unique<FileBackend>(spec); }

}  // namespace ritm
