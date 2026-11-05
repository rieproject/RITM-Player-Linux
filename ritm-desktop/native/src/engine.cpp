#include "engine.hpp"

#include <chrono>
#include <cmath>
#include <cstring>

#include "json.hpp"

namespace ritm {

using json::Writer;
using namespace std::chrono_literals;

namespace {
constexpr size_t CHUNK = 4096;  // frame sumber per langkah dekode

void storeSample(uint8_t* p, int32_t v, uint16_t containerBits) {
  switch (containerBits) {
    case 16: {
      int16_t s = int16_t(v);
      memcpy(p, &s, 2);
      break;
    }
    case 24:
      p[0] = uint8_t(v);
      p[1] = uint8_t(v >> 8);
      p[2] = uint8_t(v >> 16);
      break;
    default:
      memcpy(p, &v, 4);
  }
}
}  // namespace

Engine::Engine(Backend& backend, EventSink emit) : backend_(backend), emit_(std::move(emit)) {}

Engine::~Engine() { stopStream(); }

void Engine::setConfig(const EngineConfig& cfg) {
  std::lock_guard<std::mutex> lk(ctlMu_);
  // hanya `streamOpen_` (diubah thread perintah): dec_ sendiri bisa sesaat kosong saat feeder berpindah lagu
  bool reopen = streamOpen_;
  double at = reopen ? positionSec() : 0;
  bool wasPlaying = playing_;
  double latency = backend_.latency();
  if (reopen) {
    // terapkan pengaturan baru (mode, perangkat, buffer, DSP) dengan membuka ulang di posisi yang sama
    stopStream();  // feeder & monitor berhenti dulu: cfg_ dan state lain aman diubah setelah ini
    rollbackToAudible(latency);
  }
  cfg_ = cfg;
  if (reopen) startStream(at, wasPlaying);
}

bool Engine::open(const FileRegion& src, double startSec, bool autoplay) {
  std::lock_guard<std::mutex> lk(ctlMu_);
  stopStream();
  {
    std::lock_guard<std::mutex> nl(nextMu_);
    next_.reset();  // lagu berikutnya milik rilisan/posisi lama
  }
  advances_ = announced_ = 0;  // nomor lagu dihitung ulang dari open; setConfig membuka ulang tanpa mengubahnya
  std::string err;
  dec_ = openDecoder(src, err);
  if (!dec_) {
    emit_(Writer().add("ev", "error").add("code", "DECODE").add("message", err).str());
    return false;
  }
  src_ = src;
  sf_ = dec_->format();
  return startStream(startSec, autoplay);
}

bool Engine::startStream(double startSec, bool autoplay) {
  if (!dec_) return false;
  OpenRequest req;
  req.mode = cfg_.mode;
  req.deviceId = cfg_.deviceId;
  req.rate = sf_.rate;
  req.channels = sf_.channels;
  req.bits = sf_.bits;
  req.srcFloat = sf_.isFloat;
  req.bufferFrames = cfg_.bufferFrames;
  std::string err;
  reasons_.clear();
  activeMode_ = cfg_.mode;
  if (!backend_.open(req, df_, err)) {
    std::string firstErr = err.rfind("Exclusive: ", 0) == 0 ? err.substr(11) : err;
    bool recovered = false;
    if (cfg_.mode == OutputMode::Exclusive && !backend_.blocking()) {
      // Exclusive ditolak (dipakai aplikasi lain / dimatikan di pengaturan OS) → tetap bunyi lewat Shared
      req.mode = OutputMode::Shared;
      err.clear();
      if (backend_.open(req, df_, err)) {
        recovered = true;
        activeMode_ = OutputMode::Shared;
        reasons_.push_back("Exclusive gagal (" + firstErr + "), memakai Shared");
      }
    }
    if (!recovered) {
      emit_(Writer().add("ev", "error").add("code", "DEVICE").add("message", firstErr).str());
      return false;
    }
  }

  // ---- jalur sinyal: bit-perfect hanya bila tidak ada satu pun pengubahan sampel
  if (activeMode_ == OutputMode::Shared) reasons_.push_back("mode Shared: melewati mixer sistem");
  if (sf_.isFloat) reasons_.push_back("sumber lossy didekode ke float");
  if (df_.rate != sf_.rate) reasons_.push_back("perangkat tidak mendukung " + std::to_string(sf_.rate) + " Hz");
  if (!df_.isFloat && !sf_.isFloat && df_.validBits < sf_.bits) reasons_.push_back("perangkat maksimal " + std::to_string(df_.validBits) + "-bit");
  if (df_.isFloat && activeMode_ == OutputMode::Exclusive) reasons_.push_back("perangkat hanya menerima float");
  if (cfg_.profile == Profile::Analog) reasons_.push_back("profil Analog Stage");
  if (cfg_.volume < 0.9999) reasons_.push_back("volume digital di bawah 100%");
  if (sf_.channels > df_.channels) reasons_.push_back("downmix kanal");
  path_ = reasons_.empty() ? SignalPath::BitPerfect : SignalPath::Processed;
  resampling_ = df_.rate != sf_.rate;

  const int ch = df_.channels;
  analog_.init(sf_.rate, ch);
  {
    std::lock_guard<std::mutex> sl(statsMu_);
    guard_.init(ch);
  }
  if (resampling_) src_rs_.init(sf_.rate, df_.rate, ch, cfg_.phase);
  if (!df_.isFloat) dither_.init(df_.validBits, ch, df_.rate, cfg_.noiseShaping);
  lpL_ = lpH_ = lvA_ = lvB_ = 0;

  // ---- posisi awal
  uint64_t total = dec_->totalFrames();
  uint64_t startFrame = uint64_t(std::llround(std::max(0.0, startSec) * sf_.rate));
  if (total && startFrame >= total) startFrame = total ? total - 1 : 0;
  dec_->seek(startFrame);
  srcStartFrame_ = startFrame;
  startSec_ = double(startFrame) / sf_.rate;

  // ---- ring ± 1 detik
  {
    std::lock_guard<std::mutex> lk(ringMu_);
    size_t bpf = df_.bytesPerFrame();
    ring_.assign(size_t(df_.rate) * bpf, 0);
    rRead_ = rWrite_ = rFill_ = 0;
  }
  {
    std::lock_guard<std::mutex> lk(levelMu_);
    levels_.clear();
    lastLevel_ = {0, 0, 0, 0};
  }
  outPushed_ = outPlayed_ = 0;
  setSegment(0, startSec_, true);
  eof_ = false;
  endedSent_ = false;
  drainTicks_ = -1;
  playing_ = autoplay;
  loadedSrc_ = sf_;
  uint64_t frames = dec_->totalFrames();
  loadedDuration_ = frames ? double(frames) / sf_.rate : 0.0;
  setRunning(true);
  feeder_ = std::thread([this] { feeder(); });

  // isi awal sebelum perangkat mulai meminta data
  {
    std::unique_lock<std::mutex> lk(ringMu_);
    size_t want = std::min(ring_.size() / 2, size_t(cfg_.bufferFrames) * 4 * df_.bytesPerFrame());
    ringCv_.wait_for(lk, 3s, [&] { return rFill_ >= want || eof_; });
  }
  if (!backend_.start([this](uint8_t* d, uint32_t f) { return render(d, f); }, err)) {
    setRunning(false);
    ringCv_.notify_all();
    if (feeder_.joinable()) feeder_.join();
    backend_.close();
    emit_(Writer().add("ev", "error").add("code", "DEVICE").add("message", err).str());
    return false;
  }
  streamOpen_ = true;
  monitor_ = std::thread([this] { monitor(); });
  emitLoaded();
  return true;
}

void Engine::stopStream() {
  if (!running_ && !streamOpen_) return;
  setRunning(false);
  ringCv_.notify_all();
  backend_.close();
  if (feeder_.joinable()) feeder_.join();
  if (monitor_.joinable()) monitor_.join();
  streamOpen_ = false;
}

void Engine::play() {
  playing_ = true;
  if (eof_ && endedSent_) seek(0);
}
void Engine::pause() { playing_ = false; }

void Engine::stop() {
  std::lock_guard<std::mutex> lk(ctlMu_);
  stopStream();
  {
    std::lock_guard<std::mutex> nl(nextMu_);
    next_.reset();
  }
  {
    std::lock_guard<std::mutex> sl(segMu_);
    prevDec_.reset();
  }
  dec_.reset();
  emit_(Writer().add("ev", "stopped").str());
}

void Engine::seek(double sec) {
  std::lock_guard<std::mutex> lk(ctlMu_);
  if (!dec_ || !streamOpen_) return;
  bool wasPlaying = playing_;
  // hentikan feeder sebentar, kosongkan ring, lalu lanjut dari posisi baru di perangkat yang sama
  setRunning(false);
  ringCv_.notify_all();
  if (feeder_.joinable()) feeder_.join();
  if (monitor_.joinable()) monitor_.join();
  playing_ = false;
  rollbackToAudible(backend_.latency());  // posisi dari klien adalah posisi lagu yang terdengar
  uint64_t frame = uint64_t(std::llround(std::max(0.0, sec) * sf_.rate));
  uint64_t total = dec_->totalFrames();
  if (total && frame >= total) frame = total - 1;
  dec_->seek(frame);
  {
    std::lock_guard<std::mutex> rl(ringMu_);
    rRead_ = rWrite_ = rFill_ = 0;
  }
  {
    std::lock_guard<std::mutex> ll(levelMu_);
    levels_.clear();
  }
  const int ch = df_.channels;
  analog_.init(sf_.rate, ch);
  if (resampling_) src_rs_.init(sf_.rate, df_.rate, ch, cfg_.phase);
  startSec_ = double(frame) / sf_.rate;
  outPushed_ = outPlayed_ = 0;
  setSegment(0, startSec_, true);
  eof_ = false;
  endedSent_ = false;
  drainTicks_ = -1;
  setRunning(true);
  feeder_ = std::thread([this] { feeder(); });
  {
    std::unique_lock<std::mutex> rl(ringMu_);
    size_t want = std::min(ring_.size() / 2, size_t(cfg_.bufferFrames) * 4 * df_.bytesPerFrame());
    ringCv_.wait_for(rl, 2s, [&] { return rFill_ >= want || eof_; });
  }
  playing_ = wasPlaying;
  monitor_ = std::thread([this] { monitor(); });
}

double Engine::positionSec() const {
  if (!df_.rate) return 0;
  double played = std::max(0.0, double(outPlayed_.load()) / df_.rate - backend_.latency());
  Segment s = segmentAt(played);
  return s.srcStartSec + std::max(0.0, played - double(s.startFrame) / df_.rate);
}

Engine::Segment Engine::segmentAt(double playedSec) const {
  std::lock_guard<std::mutex> sl(segMu_);
  if (segs_.empty()) return Segment{};
  Segment s = segs_.front();
  for (const Segment& x : segs_) {
    if (double(x.startFrame) / df_.rate > playedSec) break;
    s = x;
  }
  return s;
}

Engine::Segment Engine::makeSegment(uint64_t startFrame, double srcStartSec) const {
  Segment s;
  s.startFrame = startFrame;
  s.srcStartSec = srcStartSec;
  s.seq = advances_;
  uint64_t total = dec_ ? dec_->totalFrames() : 0;
  s.duration = total && sf_.rate ? double(total) / sf_.rate : 0.0;
  s.codec = sf_.codec;
  return s;
}

void Engine::setSegment(uint64_t startFrame, double srcStartSec, bool clear) {
  Segment s = makeSegment(startFrame, srcStartSec);
  std::lock_guard<std::mutex> sl(segMu_);
  if (clear) {
    segs_.clear();
    prevDec_.reset();  // awal baru: tidak ada lagu sebelumnya yang perlu dipegang
  }
  segs_.push_back(s);
}

bool Engine::preload(const FileRegion& src) {
  std::string err;
  std::unique_ptr<Decoder> d = openDecoder(src, err);  // di luar kunci: pembukaan file bisa lambat
  std::lock_guard<std::mutex> nl(nextMu_);
  next_ = std::move(d);
  return next_ != nullptr;
}

void Engine::setRunning(bool on) {
  // diubah di bawah kunci ring agar render/feeder yang sedang menunggu pasti melihatnya (tanpa lost wakeup)
  std::lock_guard<std::mutex> lk(ringMu_);
  running_ = on;
}

void Engine::rollbackToAudible(double latencySec) {
  // Feeder bisa sudah pindah ke lagu berikutnya sementara lagu sebelumnya masih terdengar (±1 dtk buffer).
  // Kembalikan dekoder ke lagu yang terdengar agar seek/ubah pengaturan memakai lagu yang benar.
  // Hanya dipanggil saat feeder & monitor sudah berhenti.
  double played = std::max(0.0, double(outPlayed_.load()) / df_.rate - latencySec);
  Segment cur = segmentAt(played);
  std::unique_ptr<Decoder> prev;
  {
    std::lock_guard<std::mutex> sl(segMu_);
    if (segs_.size() < 2 || !prevDec_ || cur.seq == advances_) return;
    prev = std::move(prevDec_);
    segs_.pop_back();  // segmen lagu yang dibatalkan
  }
  dec_ = std::move(prev);
  sf_ = dec_->format();
  advances_ = cur.seq;
  std::lock_guard<std::mutex> nl(nextMu_);
  next_.reset();  // lagu berikutnya ikut dibatalkan; klien mengirim ulang `preload` setelah seek
}

bool Engine::tryAdvance() {
  std::lock_guard<std::mutex> nl(nextMu_);
  // setelah `ended` terkirim, monitor sudah melepas aliran (playing_ = false): jangan pindah lagu lagi
  if (!next_ || endedSent_) return false;
  {
    // hanya satu lagu yang boleh mendahului lagu yang terdengar; selebihnya biarkan jatuh ke `ended`
    std::lock_guard<std::mutex> sl(segMu_);
    if (segs_.size() > 1) return false;
  }
  const SourceFormat& f = next_->format();
  // format keluaran tetap: hanya lagu dengan format sumber yang sama yang bisa menyambung tanpa membuka ulang perangkat
  if (f.rate != sf_.rate || f.channels != sf_.channels || f.bits != sf_.bits || f.isFloat != sf_.isFloat) return false;
  // lagu yang lebih pendek dari latensi perangkat (+ margin tick monitor 50 ms) tidak sempat dilaporkan `advanced`
  // sebelum drain selesai, sehingga klien akan membukanya lagi dan lagu itu terputar dua kali: biarkan jatuh ke `ended`
  const uint64_t nextFrames = next_->totalFrames();
  if (nextFrames && double(nextFrames) / f.rate < backend_.latency() + 0.2) return false;
  std::unique_ptr<Decoder> cur = std::move(dec_);
  dec_ = std::move(next_);
  sf_ = dec_->format();
  srcStartFrame_ = 0;
  // sisa tail resampler lagu sebelumnya sudah di-flush oleh decodeChunk; mulai bersih untuk lagu baru
  if (resampling_) src_rs_.init(sf_.rate, df_.rate, df_.channels, cfg_.phase);
  analog_.init(sf_.rate, df_.channels);  // state filter lagu sebelumnya tidak ikut ke lagu baru
  advances_++;
  Segment s = makeSegment(outPushed_, 0.0);  // frame pertama lagu baru = akhir frame yang sudah masuk ring
  // dekoder lagu yang masih terdengar dan segmen lagu baru dipublikasikan dalam satu kunci: monitor tidak boleh
  // melepas dekoder itu di antara keduanya (segs_ masih satu segmen dan rollbackToAudible membutuhkannya)
  {
    std::lock_guard<std::mutex> sl(segMu_);
    prevDec_ = std::move(cur);
    segs_.push_back(s);
  }
  // eof_ dibatalkan di bawah nextMu_: monitor memutuskan `ended` lewat kunci yang sama, jadi tidak ada celah di antaranya
  eof_ = false;
  return true;
}

// ------------------------------------------------------------------ thread audio
uint32_t Engine::render(uint8_t* dst, uint32_t frames) {
  const size_t bpf = df_.bytesPerFrame();
  const size_t bytes = size_t(frames) * bpf;
  if (!playing_) {
    memset(dst, 0, bytes);
    return 0;
  }
  std::unique_lock<std::mutex> lk(ringMu_, std::defer_lock);
  if (backend_.blocking()) {
    lk.lock();
    ringCv_.wait(lk, [&] { return !running_ || rFill_ >= bytes || eof_; });
  } else if (!lk.try_lock()) {
    memset(dst, 0, bytes);  // jangan pernah memblok thread audio sungguhan
    return 0;
  }
  size_t n = std::min(rFill_, bytes);
  n -= n % bpf;
  size_t first = std::min(n, ring_.size() - rRead_);
  memcpy(dst, &ring_[rRead_], first);
  if (n > first) memcpy(dst + first, &ring_[0], n - first);
  if (n < bytes) memset(dst + n, 0, bytes - n);
  if (muted_) memset(dst, 0, n);
  rRead_ = (rRead_ + n) % ring_.size();
  rFill_ -= n;
  outPlayed_ += n / bpf;
  lk.unlock();
  ringCv_.notify_all();
  return uint32_t(n / bpf);
}

// ------------------------------------------------------------------ dekode & DSP
void Engine::feeder() {
  while (running_) {
    bool eof = false;
    {
      std::unique_lock<std::mutex> lk(ringMu_);
      // cukup ruang untuk satu potongan (setelah SRC hingga 8,7× pada 44,1 → 384 kHz)
      size_t need = size_t(CHUNK) * 9 * df_.bytesPerFrame();
      need = std::min(need, ring_.size() / 2);
      ringCv_.wait_for(lk, 20ms, [&] { return !running_ || (!eof_ && ring_.size() - rFill_ >= need); });
      if (!running_) break;
      eof = eof_;
      if (!eof && ring_.size() - rFill_ < need) continue;
    }
    if (eof) {
      // `preload` bisa tiba sesudah EOF (mis. setelah config membuka ulang lagu yang hampir habis):
      // coba lagi selama ring masih berisi audio, supaya tetap gapless dan tidak jatuh ke `ended`
      tryAdvance();  // bila berhasil, tryAdvance sendiri membatalkan eof_
      continue;
    }
    decodeChunk();
  }
}

void Engine::writeRing(const uint8_t* data, size_t bytes) {
  size_t off = 0;
  while (off < bytes && running_) {
    std::unique_lock<std::mutex> lk(ringMu_);
    ringCv_.wait_for(lk, 20ms, [&] { return !running_ || rFill_ < ring_.size(); });
    if (!running_) return;
    size_t space = ring_.size() - rFill_;
    size_t n = std::min(space, bytes - off);
    size_t first = std::min(n, ring_.size() - rWrite_);
    memcpy(&ring_[rWrite_], data + off, first);
    if (n > first) memcpy(&ring_[0], data + off + first, n - first);
    rWrite_ = (rWrite_ + n) % ring_.size();
    rFill_ += n;
    off += n;
    lk.unlock();
    ringCv_.notify_all();
  }
}

void Engine::decodeChunk() {
  const int sch = sf_.channels, dch = df_.channels;
  std::vector<int32_t> ints(sf_.isFloat ? 0 : CHUNK * sch);
  std::vector<float> floats(sf_.isFloat ? CHUNK * sch : 0);
  size_t got = dec_->read(ints.data(), floats.data(), CHUNK);

  if (got == 0) {
    if (resampling_ && path_ == SignalPath::Processed) {
      std::vector<double> tail;
      src_rs_.flush(tail);
      if (!tail.empty()) pushDouble(tail, tail.size() / dch);
    }
    if (tryAdvance()) return;  // gapless: lanjut ke lagu berikutnya tanpa jeda
    {
      std::lock_guard<std::mutex> lk(ringMu_);
      eof_ = true;
    }
    ringCv_.notify_all();
    return;
  }

  if (path_ == SignalPath::BitPerfect) {
    // sampel integer dipindahkan apa adanya: hanya digeser ke container (16→24/32 dengan nol di LSB)
    const size_t bpf = df_.bytesPerFrame();
    const int bytesPer = df_.containerBits / 8;
    const int shift = df_.containerBits - sf_.bits;
    std::vector<uint8_t> out(got * bpf);
    double sL = 0, sM = 0, sH = 0;
    const double norm = 1.0 / std::ldexp(1.0, sf_.bits - 1);
    for (size_t i = 0; i < got; i++) {
      double mono = 0;
      for (int c = 0; c < dch; c++) {
        int32_t v = ints[i * sch + std::min(c, sch - 1)];
        int32_t packed = int32_t(uint32_t(v) << shift);
        if (df_.containerBits == 24) packed = v << (24 - sf_.bits);
        storeSample(&out[i * bpf + size_t(c) * bytesPer], packed, df_.containerBits);
        mono += v * norm;
      }
      mono /= dch;
      // meter level kasar (low < 200 Hz, high > 4 kHz)
      lpL_ += 0.028 * (mono - lpL_);
      lpH_ += 0.43 * (mono - lpH_);
      double hi = mono - lpH_, lo = lpL_, md = lpH_ - lpL_;
      sL += lo * lo;
      sM += md * md;
      sH += hi * hi;
    }
    uint64_t at = outPushed_ + got;
    {
      std::lock_guard<std::mutex> lk(levelMu_);
      levels_.push_back({at, std::sqrt(sL / got), std::sqrt(sM / got), std::sqrt(sH / got)});
      if (levels_.size() > 256) levels_.pop_front();
    }
    {
      // statistik true-peak tetap diukur (tanpa mengubah keluaran)
      std::vector<double> d(got * dch);
      for (size_t i = 0; i < got; i++)
        for (int c = 0; c < dch; c++) d[i * dch + c] = ints[i * sch + std::min(c, sch - 1)] * norm;
      std::lock_guard<std::mutex> sl(statsMu_);
      guard_.process(d.data(), got, false);
    }
    writeRing(out.data(), out.size());
    outPushed_ += got;
    return;
  }

  // ---- bus float64: kanal → Analog Stage (rate sumber) → SRC → Peak Guard → volume → dither/kuantisasi
  std::vector<double> buf(got * dch);
  const double norm = sf_.isFloat ? 1.0 : 1.0 / std::ldexp(1.0, sf_.bits - 1);
  for (size_t i = 0; i < got; i++)
    for (int c = 0; c < dch; c++) {
      int sc = std::min(c, sch - 1);
      buf[i * dch + c] = sf_.isFloat ? double(floats[i * sch + sc]) : ints[i * sch + sc] * norm;
    }
  if (cfg_.profile == Profile::Analog) analog_.process(buf.data(), got);
  if (resampling_) {
    std::vector<double> out;
    out.reserve(size_t(double(got) * df_.rate / sf_.rate + 8) * dch);
    src_rs_.process(buf.data(), got, out);
    if (!out.empty()) pushDouble(out, out.size() / dch);
  } else {
    pushDouble(buf, got);
  }
}

void Engine::pushDouble(std::vector<double>& buf, size_t frames) {
  const int ch = df_.channels;
  {
    std::lock_guard<std::mutex> sl(statsMu_);
    guard_.process(buf.data(), frames, cfg_.profile == Profile::Analog && cfg_.guard);
  }
  const double vol = std::max(0.0, std::min(1.0, cfg_.volume));
  const size_t bpf = df_.bytesPerFrame();
  const int bytesPer = df_.containerBits / 8;
  std::vector<uint8_t> out(frames * bpf);
  double sL = 0, sM = 0, sH = 0;
  const double scale = std::ldexp(1.0, df_.validBits - 1);
  const int shift = df_.containerBits - df_.validBits;
  for (size_t i = 0; i < frames; i++) {
    double mono = 0;
    for (int c = 0; c < ch; c++) {
      double x = buf[i * ch + c] * vol;
      mono += x;
      uint8_t* p = &out[i * bpf + size_t(c) * bytesPer];
      if (df_.isFloat) {
        float f = float(x);
        memcpy(p, &f, 4);
        continue;
      }
      int32_t q;
      if (cfg_.dither) q = dither_.quantize(x, c);
      else {
        double r = std::nearbyint(x * scale);  // pembulatan (bukan truncation)
        q = int32_t(std::max(-scale, std::min(scale - 1, r)));
      }
      storeSample(p, df_.containerBits == 24 ? q : int32_t(uint32_t(q) << shift), df_.containerBits);
    }
    if (!df_.isFloat && cfg_.dither) dither_.nextFrame();
    mono /= ch;
    lpL_ += 0.028 * (mono - lpL_);
    lpH_ += 0.43 * (mono - lpH_);
    double hi = mono - lpH_, lo = lpL_, md = lpH_ - lpL_;
    sL += lo * lo;
    sM += md * md;
    sH += hi * hi;
  }
  if (frames) {
    std::lock_guard<std::mutex> lk(levelMu_);
    levels_.push_back({outPushed_ + frames, std::sqrt(sL / frames), std::sqrt(sM / frames), std::sqrt(sH / frames)});
    if (levels_.size() > 256) levels_.pop_front();
  }
  writeRing(out.data(), out.size());
  outPushed_ += frames;
}

// ------------------------------------------------------------------ event
void Engine::monitor() {
  while (running_) {
    std::this_thread::sleep_for(50ms);
    if (!running_) break;
    size_t fill;
    {
      std::lock_guard<std::mutex> lk(ringMu_);
      fill = rFill_;
    }
    if (eof_ && fill == 0 && playing_ && !endedSent_) {
      // ring kosong ≠ sudah terdengar: tunggu latensi perangkat (buffer WASAPI/CoreAudio) dulu
      if (drainTicks_ < 0) drainTicks_ = int(backend_.latency() / 0.05 + 0.999);
      if (drainTicks_-- > 0) continue;
      drainTicks_ = -1;
      {
        // keputusan `ended` diambil di bawah nextMu_ (dan ringMu_ untuk isi ring): bila feeder sudah pindah
        // ke lagu berikutnya selama drain, `ended` dibatalkan dan aliran dilanjutkan
        std::lock_guard<std::mutex> nl(nextMu_);
        std::lock_guard<std::mutex> lk(ringMu_);
        if (!eof_ || rFill_ != 0) continue;
        endedSent_ = true;
      }
      playing_ = false;
      emit_(Writer().add("ev", "ended").str());
      std::lock_guard<std::mutex> lk(endedMu_);
      endedCv_.notify_all();
      continue;
    }
    drainTicks_ = -1;  // bukan lagi menunggu drain: eof_ bisa dibatalkan feeder bila lagu berikutnya tiba
    uint64_t played = outPlayed_;
    // lagu baru di aliran sudah terdengar: beri tahu klien sekali per perpindahan
    double playedSec = std::max(0.0, double(played) / df_.rate - backend_.latency());
    Segment cur = segmentAt(playedSec);
    {
      // segmen yang sudah lewat dibuang; dekoder lagu sebelumnya dilepas setelah lagu berikutnya terdengar
      std::lock_guard<std::mutex> sl(segMu_);
      while (segs_.size() > 1 && double(segs_[1].startFrame) / df_.rate <= playedSec) segs_.pop_front();
      if (segs_.size() == 1) prevDec_.reset();
    }
    if (cur.seq > announced_) {
      announced_ = cur.seq;
      emit_(Writer().add("ev", "advanced").add("n", cur.seq).add("duration", cur.duration).add("codec", cur.codec).str());
    }
    LevelMark lv = lastLevel_;
    {
      std::lock_guard<std::mutex> lk(levelMu_);
      while (!levels_.empty() && levels_.front().frame <= played) {
        lv = levels_.front();
        levels_.pop_front();
      }
      lastLevel_ = lv;
    }
    auto meter = [](double rms) { return std::min(1.0, rms * 3.2); };
    double lo = playing_ ? meter(lv.low) : 0, md = playing_ ? meter(lv.mid) : 0, hi = playing_ ? meter(lv.high) : 0;
    double tin, tout, tg;
    uint64_t tov;
    {
      std::lock_guard<std::mutex> sl(statsMu_);
      tin = guard_.inputTpDb();
      tout = guard_.outputTpDb();
      tg = guard_.gainDb();
      tov = guard_.overs();
    }
    emit_(Writer()
              .add("ev", "pos")
              .add("t", positionSec())
              .addBool("playing", playing_)
              .addNums("levels", {lo, lo, md, md, hi, hi})
              .raw("tp", Writer()
                             .add("in", tin)
                             .add("out", tout)
                             .add("gain", tg)
                             .add("overs", tov)
                             .str())
              .str());
  }
}

bool Engine::waitEnded(double timeoutSec) {
  std::unique_lock<std::mutex> lk(endedMu_);
  return endedCv_.wait_for(lk, std::chrono::duration<double>(timeoutSec), [&] { return endedSent_.load(); });
}

void Engine::emitLoaded() {
  std::string reasons = "[";
  for (size_t i = 0; i < reasons_.size(); i++) reasons += (i ? "," : "") + Writer::escape(reasons_[i]);
  reasons += "]";
  emit_(Writer()
            .add("ev", "loaded")
            .add("duration", loadedDuration_)
            .add("at", startSec_)
            .raw("source", Writer()
                               .add("codec", loadedSrc_.codec)
                               .add("rate", loadedSrc_.rate)
                               .add("bits", int(loadedSrc_.bits))
                               .add("channels", int(loadedSrc_.channels))
                               .addBool("float", loadedSrc_.isFloat)
                               .str())
            .raw("output", Writer()
                               .add("backend", backend_.name())
                               .add("mode", activeMode_ == OutputMode::Exclusive ? "exclusive" : "shared")
                               .add("rate", df_.rate)
                               .add("bits", int(df_.validBits))
                               .add("container", int(df_.containerBits))
                               .add("channels", int(df_.channels))
                               .addBool("float", df_.isFloat)
                               .add("latencyMs", backend_.latency() * 1000)
                               .add("bufferFrames", cfg_.bufferFrames)
                               .str())
            .add("path", pathName(path_))
            .raw("reasons", reasons)
            .raw("dsp", Writer()
                            .addBool("resampler", resampling_ && path_ == SignalPath::Processed)
                            .add("phase", cfg_.phase == FilterPhase::Linear ? "linear" : "minimum")
                            .addBool("dither", path_ == SignalPath::Processed && !df_.isFloat && cfg_.dither)
                            .addBool("shaping", path_ == SignalPath::Processed && !df_.isFloat && cfg_.dither && cfg_.noiseShaping)
                            .add("profile", cfg_.profile == Profile::Analog ? "analog" : "purist")
                            .addBool("guard", cfg_.profile == Profile::Analog && cfg_.guard)
                            .str())
            .addBool("playing", playing_)
            .str());
}

}  // namespace ritm
