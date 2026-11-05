// Engine pemutaran: dekoder → (bit-perfect | bus float64 DSP) → ring buffer → backend.
#pragma once
#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "backend/backend.hpp"
#include "common.hpp"
#include "decode/decoder.hpp"
#include "dsp/dsp.hpp"
#include "dsp/resampler.hpp"

namespace ritm {

using EventSink = std::function<void(const std::string& jsonLine)>;

class Engine {
 public:
  Engine(Backend& backend, EventSink emit);
  ~Engine();

  void setConfig(const EngineConfig& cfg);
  const EngineConfig& config() const { return cfg_; }
  /** Buka sumber (seluruh file atau entry .ritm) dan mulai dari `startSec`. */
  bool open(const FileRegion& src, double startSec, bool autoplay);
  void play();
  void pause();
  /** Senyapkan keluaran tanpa menghentikan posisi & tanpa mengubah jalur bit-perfect. */
  void setMuted(bool on) { muted_ = on; }
  void seek(double sec);
  void stop();
  /** Untuk uji/file sink: tunggu sampai lagu habis. */
  bool waitEnded(double timeoutSec);
  /**
   * Siapkan lagu berikutnya tanpa memutus stream (gapless). Bila lagu sekarang habis dan formatnya sama
   * (rate, kanal, bit, float), feeder berpindah ke lagu ini di tengah aliran; mesin mengirim `advanced`.
   * Gagal atau format berbeda → lagu berikutnya dibuka biasa lewat `open` setelah `ended`.
   */
  bool preload(const FileRegion& src);

 private:
  struct LevelMark {
    uint64_t frame;
    double low, mid, high;
  };

  /** Lagu yang sedang/akan diputar di aliran keluaran: mulai di frame keluaran `startFrame`. */
  struct Segment {
    uint64_t startFrame = 0;
    double srcStartSec = 0;
    int seq = 0;  // nomor lagu sejak open (0 = lagu pertama)
    double duration = 0;
    std::string codec;
  };

  bool startStream(double startSec, bool autoplay);
  void stopStream();
  void feeder();
  void monitor();
  uint32_t render(uint8_t* dst, uint32_t frames);
  void decodeChunk();
  bool tryAdvance();
  Segment makeSegment(uint64_t startFrame, double srcStartSec) const;
  void setSegment(uint64_t startFrame, double srcStartSec, bool clear);
  Segment segmentAt(double playedSec) const;
  void rollbackToAudible(double latencySec);
  void setRunning(bool on);
  void pushDouble(std::vector<double>& buf, size_t frames);
  void writeRing(const uint8_t* data, size_t bytes);
  void emitLoaded();
  double positionSec() const;

  Backend& backend_;
  EventSink emit_;
  EngineConfig cfg_;

  // sumber
  FileRegion src_;
  std::unique_ptr<Decoder> dec_;
  SourceFormat sf_;
  uint64_t srcStartFrame_ = 0;
  // format & durasi yang dilaporkan di `loaded`: snapshot sebelum feeder berjalan (feeder bisa pindah ke lagu berikutnya)
  SourceFormat loadedSrc_;
  double loadedDuration_ = 0;

  // gapless: lagu berikutnya yang sudah dibuka, dan daftar lagu di aliran keluaran
  std::mutex nextMu_;
  std::unique_ptr<Decoder> next_;
  std::deque<Segment> segs_;
  // dekoder lagu yang masih terdengar saat feeder sudah pindah ke lagu berikutnya (dijaga segMu_)
  std::unique_ptr<Decoder> prevDec_;
  mutable std::mutex segMu_;
  int advances_ = 0;  // jumlah perpindahan gapless sejak open (feeder)
  int announced_ = 0;  // seq terakhir yang sudah dilaporkan ke klien (monitor)

  // keluaran
  DeviceFormat df_;
  SignalPath path_ = SignalPath::Processed;
  std::vector<std::string> reasons_;
  bool resampling_ = false;

  // DSP
  dsp::AnalogStage analog_;
  dsp::PeakGuard guard_;
  dsp::Resampler src_rs_;
  dsp::Ditherer dither_;
  double lpL_ = 0, lpH_ = 0, lvA_ = 0, lvB_ = 0;  // filter level meter

  // ring buffer (byte format perangkat)
  std::mutex ringMu_;
  std::vector<uint8_t> ring_;
  size_t rRead_ = 0, rWrite_ = 0, rFill_ = 0;
  std::condition_variable ringCv_;

  // status
  std::thread feeder_, monitor_;
  std::atomic<bool> running_{false}, playing_{false}, eof_{false}, endedSent_{false}, streamOpen_{false};
  OutputMode activeMode_ = OutputMode::Exclusive;  // mode yang benar-benar dipakai (bisa turun ke Shared)
  std::atomic<bool> muted_{false};
  int drainTicks_ = -1;  // monitor: sisa tick 50 ms menunggu buffer perangkat habis sebelum 'ended'
  std::atomic<uint64_t> outPushed_{0};    // frame keluaran yang sudah masuk ring (sejak start)
  std::atomic<uint64_t> outPlayed_{0};    // frame keluaran yang sudah dikirim ke perangkat
  double startSec_ = 0;
  std::mutex levelMu_;
  std::deque<LevelMark> levels_;
  LevelMark lastLevel_{0, 0, 0, 0};
  std::mutex ctlMu_;
  mutable std::mutex statsMu_;  // guard_ ditulis feeder, dibaca monitor
  std::condition_variable endedCv_;
  std::mutex endedMu_;
};

}  // namespace ritm
