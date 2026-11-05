// Resampler sinc presisi tinggi (SRC) — ditulis sendiri, tanpa pustaka luar.
// Kernel sinc berjendela Kaiser (β 12 ≈ 120 dB stopband), 80 zero-crossing per sisi, tabel 512 titik
// per zero-crossing dengan interpolasi linear antar-titik; rasio sembarang (44,1 ↔ 48 ↔ 88,2 ↔ 96 ↔ 192 kHz).
// Fase: Linear (transparan, simetris, ada pre-ringing) atau Minimum (tanpa pre-ringing, magnitudo sama),
// fase minimum dibuat dengan metode cepstrum dari kernel linear.
#pragma once
#include <complex>
#include <cstdint>
#include <vector>

#include "../common.hpp"
#include "dsp.hpp"

namespace ritm::dsp {

namespace detail {
inline void fft(std::vector<std::complex<double>>& a, bool inverse) {
  const size_t n = a.size();
  for (size_t i = 1, j = 0; i < n; i++) {
    size_t bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) std::swap(a[i], a[j]);
  }
  for (size_t len = 2; len <= n; len <<= 1) {
    double ang = 2 * PI / double(len) * (inverse ? 1 : -1);
    std::complex<double> wl(std::cos(ang), std::sin(ang));
    for (size_t i = 0; i < n; i += len) {
      std::complex<double> w(1);
      for (size_t k = 0; k < len / 2; k++) {
        auto u = a[i + k], v = a[i + k + len / 2] * w;
        a[i + k] = u + v;
        a[i + k + len / 2] = u - v;
        w *= wl;
      }
    }
  }
  if (inverse)
    for (auto& x : a) x /= double(n);
}

/** Ubah FIR menjadi fase minimum (respons magnitudo sama) lewat real cepstrum. */
inline std::vector<double> minimumPhase(const std::vector<double>& h) {
  size_t n = 1;
  while (n < h.size() * 8) n <<= 1;
  std::vector<std::complex<double>> X(n);
  for (size_t i = 0; i < h.size(); i++) X[i] = h[i];
  fft(X, false);
  for (auto& v : X) v = std::log(std::max(std::abs(v), 1e-10));  // lantai −200 dB
  fft(X, true);                                                    // real cepstrum
  for (size_t i = 1; i < n / 2; i++) X[i] *= 2.0;
  for (size_t i = n / 2 + 1; i < n; i++) X[i] = 0;
  fft(X, false);
  for (auto& v : X) v = std::exp(v);
  fft(X, true);
  std::vector<double> out(h.size());
  for (size_t i = 0; i < h.size(); i++) out[i] = X[i].real();
  return out;
}
}  // namespace detail

class Resampler {
 public:
  static constexpr int ZEROS = 80;     // zero-crossing per sisi
  static constexpr int OVERSAMPLE = 512;
  static constexpr double BETA = 12.0;
  static constexpr double CUTOFF = 0.94;  // relatif terhadap Nyquist yang lebih rendah

  void init(uint32_t inRate, uint32_t outRate, int channels, FilterPhase phase) {
    in_ = inRate;
    out_ = outRate;
    ch_ = channels;
    minPhase_ = phase == FilterPhase::Minimum;
    scale_ = std::min(1.0, double(outRate) / inRate) * CUTOFF;
    // kernel prototipe (domain zero-crossing): x ∈ [−Z, Z], OVERSAMPLE titik per satuan
    const size_t len = size_t(2 * ZEROS * OVERSAMPLE + 1);
    std::vector<double> proto(len);
    for (size_t j = 0; j < len; j++) {
      double x = double(j) / OVERSAMPLE - ZEROS;
      double s = x == 0 ? 1 : std::sin(PI * x) / (PI * x);
      double r = x / ZEROS;
      proto[j] = s * besselI0(BETA * std::sqrt(std::max(0.0, 1 - r * r))) / besselI0(BETA);
    }
    if (minPhase_) {
      // kernel kausal: diskalakan ke OVERSAMPLE, diubah ke fase minimum, lalu dinormalisasi
      table_ = detail::minimumPhase(proto);
      double sum = 0;
      for (double v : table_) sum += v;
      for (double& v : table_) v *= double(OVERSAMPLE) / sum;
    } else {
      table_ = proto;
    }
    table_.push_back(0.0);  // penjaga interpolasi
    reach_ = double(ZEROS) / scale_;  // jangkauan kernel dalam sampel input (per sisi)
    // riwayat input diawali nol agar keluaran pertama sejajar t = 0
    pad_ = minPhase_ ? 0 : size_t(std::ceil(reach_)) + 1;
    hist_.assign(pad_ * ch_, 0.0);
    base_ = 0;
    tInt_ = int64_t(pad_);
    tNum_ = 0;
    inCount_ = 0;
    flushed_ = false;
  }

  /** Masukkan frame interleaved, tambahkan frame keluaran yang sudah bisa dihitung ke `out`. */
  void process(const double* in, size_t frames, std::vector<double>& out) {
    hist_.insert(hist_.end(), in, in + frames * ch_);
    inCount_ += int64_t(frames);
    produce(out, false);
  }
  /** Akhir stream: dorong sisa kernel dengan nol. */
  void flush(std::vector<double>& out) {
    if (flushed_) return;
    flushed_ = true;
    std::vector<double> zeros(size_t(std::ceil(reach_ * 2) + 2) * ch_, 0.0);
    hist_.insert(hist_.end(), zeros.begin(), zeros.end());
    produce(out, true);
  }
  /** Latensi kernel dalam frame keluaran (0 untuk linear karena sudah dikompensasi). */
  double latencyFrames() const { return 0; }
  bool active() const { return in_ != out_; }

 private:
  // kernel kontinu di jarak τ (sampel input)
  double kernel(double tau) const {
    double x;  // posisi pada tabel
    if (minPhase_) {
      if (tau < 0) return 0;
      x = tau * scale_ * OVERSAMPLE;
    } else {
      x = (tau * scale_ + ZEROS) * OVERSAMPLE;
    }
    if (x < 0) return 0;
    size_t j = size_t(x);
    if (j + 1 >= table_.size()) return 0;
    double f = x - double(j);
    return table_[j] + f * (table_[j + 1] - table_[j]);
  }

  void produce(std::vector<double>& out, bool final) {
    const int64_t frames = int64_t(hist_.size() / ch_);
    const int64_t reachI = int64_t(std::ceil(reach_));
    std::vector<double> acc(ch_);
    for (;;) {
      double frac = double(tNum_) / out_;
      double t = double(tInt_) + frac;
      int64_t lo, hi;
      if (minPhase_) {
        lo = int64_t(std::ceil(t - 2 * reach_));
        hi = tInt_;
      } else {
        lo = int64_t(std::ceil(t - reach_));
        hi = tInt_ + reachI;
      }
      if (hi >= base_ + frames) break;  // butuh input lebih banyak
      if (final && t >= double(int64_t(pad_) + inCount_)) break;  // melewati akhir input asli
      std::fill(acc.begin(), acc.end(), 0.0);
      for (int64_t i = std::max(lo, base_); i <= hi; i++) {
        double w = kernel(t - double(i));
        if (w == 0) continue;
        const double* x = &hist_[size_t(i - base_) * ch_];
        for (int c = 0; c < ch_; c++) acc[c] += w * x[c];
      }
      for (int c = 0; c < ch_; c++) out.push_back(acc[c] * scale_);
      // langkah t += in/out secara eksak (pecahan bilangan bulat, tanpa drift)
      tNum_ += in_;
      tInt_ += tNum_ / out_;
      tNum_ %= out_;
    }
    // buang riwayat yang tak lagi dibutuhkan
    int64_t keepFrom = int64_t(std::floor(double(tInt_) - 2 * reach_)) - 2;
    if (keepFrom > base_ + 8192) {
      size_t drop = size_t(keepFrom - base_);
      hist_.erase(hist_.begin(), hist_.begin() + std::ptrdiff_t(drop * ch_));
      base_ += int64_t(drop);
    }
  }

  uint32_t in_ = 0, out_ = 0;
  int ch_ = 2;
  bool minPhase_ = false, flushed_ = false;
  double scale_ = 1, reach_ = 0;
  size_t pad_ = 0;
  std::vector<double> table_, hist_;
  int64_t base_ = 0, tInt_ = 0, tNum_ = 0, inCount_ = 0;
};

}  // namespace ritm::dsp
