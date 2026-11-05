// Modul DSP mesin native (double precision). Port dari ritm-player/src/audio (TypeScript),
// angka & perilaku identik agar Jalur A dan Jalur B terdengar sama.
#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <vector>

namespace ritm::dsp {

constexpr double PI = 3.14159265358979323846;
inline double toDb(double lin) { return lin > 0 ? 20 * std::log10(lin) : -INFINITY; }
inline double fromDb(double db) { return std::pow(10.0, db / 20); }

inline double besselI0(double x) {
  double sum = 1, term = 1;
  for (int k = 1; k < 40; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

// ------------------------------------------------------------------ True-peak 4×
class TruePeak {
 public:
  static constexpr int L = 4, TAPS = 48, PER = TAPS / L;
  TruePeak() {
    static const auto phases = design();
    ph_ = &phases;
  }
  void reset() {
    hist_.fill(0);
    pos_ = 0;
  }
  double push(double x) {
    pos_ = (pos_ + 1) % PER;
    hist_[pos_] = x;
    double peak = 0;
    for (int p = 0; p < L; p++) {
      const auto& c = (*ph_)[p];
      double acc = 0;
      int i = pos_;
      for (int m = 0; m < PER; m++) {
        acc += c[m] * hist_[i];
        i = i == 0 ? PER - 1 : i - 1;
      }
      peak = std::max(peak, std::fabs(acc));
    }
    return peak;
  }

 private:
  using Phases = std::array<std::array<double, PER>, L>;
  static Phases design() {
    Phases out{};
    const double beta = 7, mid = (TAPS - 1) / 2.0;
    double h[TAPS];
    for (int n = 0; n < TAPS; n++) {
      double t = (n - mid) / L;
      double s = t == 0 ? 1 : std::sin(PI * t) / (PI * t);
      double r = 2.0 * n / (TAPS - 1) - 1;
      h[n] = s * besselI0(beta * std::sqrt(std::max(0.0, 1 - r * r))) / besselI0(beta);
    }
    for (int p = 0; p < L; p++) {
      double sum = 0;
      for (int m = 0; m < PER; m++) sum += (out[p][m] = h[p + L * m]);
      for (int m = 0; m < PER; m++) out[p][m] /= sum;
    }
    return out;
  }
  const Phases* ph_;
  std::array<double, PER> hist_{};
  int pos_ = 0;
};

// ------------------------------------------------------------------ Peak Guard
/** Pre-gain statis per lagu: true-peak > 0 dBTP → turun (overshoot + 0,3) dB, dibatasi 0,3–0,5 dB, ditahan. */
class PeakGuard {
 public:
  static constexpr double MIN_DB = 0.3, MAX_DB = 0.5;
  static constexpr int LOOKAHEAD = 64;
  void init(int channels) {
    ch_ = channels;
    det_.assign(ch_, TruePeak());
    outDet_.assign(ch_, TruePeak());
    delay_.assign(size_t(ch_) * LOOKAHEAD, 0.0);
    w_ = 0;
    gain_ = target_ = 1;
    step_ = 0;
    inPeak_ = outPeak_ = 0;
    overs_ = 0;
  }
  /**
   * Proses blok interleaved di tempat. enabled=false → hanya mengukur, sampel tidak diubah & tidak ditunda
   * (di mesin native status guard tetap selama satu stream; mengubahnya membuka ulang stream).
   */
  void process(double* x, size_t frames, bool enabled) {
    if (!enabled) {
      for (size_t i = 0; i < frames; i++) {
        double peak = 0;
        for (int c = 0; c < ch_; c++) peak = std::max(peak, det_[c].push(x[i * ch_ + c]));
        inPeak_ = std::max(inPeak_, peak);
        outPeak_ = inPeak_;
        if (peak > 1) overs_++;
      }
      return;
    }
    for (size_t i = 0; i < frames; i++) {
      double* f = x + i * ch_;
      double peak = 0;
      for (int c = 0; c < ch_; c++) peak = std::max(peak, det_[c].push(f[c]));
      inPeak_ = std::max(inPeak_, peak);
      if (enabled && peak > 1) {
        double need = std::min(MAX_DB, std::max(MIN_DB, toDb(peak) + MIN_DB));
        double t = fromDb(-need);
        if (t < target_) {
          target_ = t;
          step_ = (target_ - gain_) / LOOKAHEAD;
        }
      }
      if (!enabled && target_ != 1) {
        target_ = 1;
        step_ = (1 - gain_) / LOOKAHEAD;
      }
      if (step_ != 0) {
        gain_ += step_;
        if ((step_ < 0 && gain_ <= target_) || (step_ > 0 && gain_ >= target_)) {
          gain_ = target_;
          step_ = 0;
        }
      }
      double outPk = 0;
      for (int c = 0; c < ch_; c++) {
        double& slot = delay_[size_t(c) * LOOKAHEAD + w_];
        double delayed = slot;
        slot = f[c];
        double y = enabled ? delayed * gain_ : delayed;
        f[c] = y;
        outPk = std::max(outPk, outDet_[c].push(y));
      }
      outPeak_ = std::max(outPeak_, outPk);
      if (outPk > 1) overs_++;
      w_ = (w_ + 1) % LOOKAHEAD;
    }
  }
  double inputTpDb() const { return toDb(inPeak_); }
  double outputTpDb() const { return toDb(outPeak_); }
  double gainDb() const { return toDb(gain_); }
  uint64_t overs() const { return overs_; }

 private:
  int ch_ = 0, w_ = 0;
  std::vector<TruePeak> det_, outDet_;
  std::vector<double> delay_;
  double gain_ = 1, target_ = 1, step_ = 0, inPeak_ = 0, outPeak_ = 0;
  uint64_t overs_ = 0;
};

// ------------------------------------------------------------------ Analog Stage
/** H2 (y = x + k·x²) → DC blocker 2 Hz → all-pass orde-2 80 Hz Q 0,5. */
class AnalogStage {
 public:
  static constexpr double K = 0.0035, AP_HZ = 80, AP_Q = 0.5, DC_HZ = 2;
  void init(double fs, int channels) {
    ch_ = channels;
    st_.assign(ch_, {});
    double w0 = 2 * PI * AP_HZ / fs, alpha = std::sin(w0) / (2 * AP_Q), a0 = 1 + alpha;
    b0_ = (1 - alpha) / a0;
    b1_ = (-2 * std::cos(w0)) / a0;
    b2_ = 1;
    a1_ = b1_;
    a2_ = b0_;
    r_ = std::exp(-2 * PI * DC_HZ / fs);
  }
  void process(double* x, size_t frames) {
    for (size_t i = 0; i < frames; i++) {
      for (int c = 0; c < ch_; c++) {
        auto& s = st_[c];
        double v = x[i * ch_ + c];
        double sat = v + K * v * v;
        double dc = sat - s.dcX + r_ * s.dcY;
        s.dcX = sat;
        s.dcY = dc;
        double ap = b0_ * dc + b1_ * s.x1 + b2_ * s.x2 - a1_ * s.y1 - a2_ * s.y2;
        s.x2 = s.x1;
        s.x1 = dc;
        s.y2 = s.y1;
        s.y1 = ap;
        x[i * ch_ + c] = ap;
      }
    }
  }

 private:
  struct St {
    double dcX = 0, dcY = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  };
  int ch_ = 0;
  std::vector<St> st_;
  double b0_ = 1, b1_ = 0, b2_ = 0, a1_ = 0, a2_ = 0, r_ = 0;
};

// ------------------------------------------------------------------ Dither TPDF + noise shaping
/**
 * Kuantisasi float → integer `bits` dengan dither TPDF (±1 LSB, segitiga) — tidak pernah truncation.
 * Noise shaping (opsional): error feedback; di 44,1/48 kHz pakai kurva F-weighted 9 koefisien (Wannamaker)
 * yang menekan noise di 2–15 kHz dan memindahkannya ke > 18 kHz; di ≥ 88,2 kHz pakai orde-2 sederhana.
 */
class Ditherer {
 public:
  void init(int bits, int channels, double rate, bool shaping) {
    bits_ = bits;
    ch_ = channels;
    scale_ = std::ldexp(1.0, bits - 1);
    maxQ_ = scale_ - 1;
    minQ_ = -scale_;
    shaping_ = shaping;
    if (rate <= 50000) coef_ = {2.412, -3.370, 3.937, -4.174, 3.353, -2.205, 1.281, -0.569, 0.0847};
    else coef_ = {2.0, -1.0};
    err_.assign(size_t(ch_) * coef_.size(), 0.0);
    pos_ = 0;
  }
  int32_t quantize(double x, int c) {
    double v = x * scale_;
    const size_t n = coef_.size();
    double* e = &err_[size_t(c) * n];
    if (shaping_) {
      double fb = 0;
      for (size_t k = 0; k < n; k++) fb += coef_[k] * e[(pos_ + n - k) % n];
      v -= fb;
    }
    double d = uniform() - uniform();  // TPDF ±1 LSB
    double q = std::nearbyint(v + d);
    if (q > maxQ_) q = maxQ_;
    if (q < minQ_) q = minQ_;
    if (shaping_) {
      double err = q - v;
      // batasi error agar loop umpan balik tidak berosilasi saat clipping
      e[(pos_ + 1) % n] = std::max(-4.0, std::min(4.0, err));
    }
    return int32_t(q);
  }
  /** Panggil setelah semua kanal satu frame dikuantisasi. */
  void nextFrame() {
    if (shaping_) pos_ = (pos_ + 1) % coef_.size();
  }

 private:
  double uniform() {
    rng_ ^= rng_ << 13;
    rng_ ^= rng_ >> 7;
    rng_ ^= rng_ << 17;
    return double(rng_ >> 11) * (1.0 / 9007199254740992.0);
  }
  int bits_ = 16, ch_ = 2;
  double scale_ = 32768, maxQ_ = 32767, minQ_ = -32768;
  bool shaping_ = true;
  std::vector<double> coef_, err_;
  size_t pos_ = 0;
  uint64_t rng_ = 0x9E3779B97F4A7C15ull;
};

}  // namespace ritm::dsp
