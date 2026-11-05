// Uji numerik modul DSP native: resampler, dither, peak guard, analog stage.
// Bangun & jalankan: native/build-linux.sh test
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <string>
#include <vector>

#include "../src/dsp/dsp.hpp"
#include "../src/dsp/resampler.hpp"

using namespace ritm;
using namespace ritm::dsp;

static int failures = 0, passes = 0;
#define CHECK(cond, ...)                         \
  do {                                           \
    if (cond) {                                  \
      passes++;                                  \
    } else {                                     \
      failures++;                                \
      printf("  GAGAL %s:%d  ", __FILE__, __LINE__); \
      printf(__VA_ARGS__);                       \
      printf("\n");                              \
    }                                            \
  } while (0)

static std::vector<double> sine(double f, double amp, double fs, size_t n, double phase = 0) {
  std::vector<double> x(n);
  for (size_t i = 0; i < n; i++) x[i] = amp * std::sin(2 * PI * f * i / fs + phase);
  return x;
}
/** Amplitudo komponen f (DFT tunggal, jendela Blackman-Harris 4-term agar kebocoran < −90 dB). */
static double amp(const std::vector<double>& x, double f, double fs, size_t from, size_t len) {
  double re = 0, im = 0, wsum = 0;
  for (size_t i = 0; i < len; i++) {
    double r = double(i) / (len - 1);
    double w = 0.35875 - 0.48829 * std::cos(2 * PI * r) + 0.14128 * std::cos(4 * PI * r) - 0.01168 * std::cos(6 * PI * r);
    double v = x[from + i] * w;
    double a = 2 * PI * f * (from + i) / fs;
    re += v * std::cos(a);
    im -= v * std::sin(a);
    wsum += w;
  }
  return 2 * std::hypot(re, im) / wsum;
}
/** Daya noise rata-rata (dB relatif 1 LSB²/bin) pada pita [f0, f1] via DFT kasar. */
static double bandPower(const std::vector<double>& x, double fs, double f0, double f1) {
  size_t n = 8192;
  std::vector<std::complex<double>> X(n);
  double total = 0;
  int count = 0;
  for (size_t blk = 0; blk + n <= x.size(); blk += n) {
    for (size_t i = 0; i < n; i++) {
      double w = 0.5 - 0.5 * std::cos(2 * PI * i / (n - 1));
      X[i] = x[blk + i] * w;
    }
    detail::fft(X, false);
    for (size_t k = 1; k < n / 2; k++) {
      double f = k * fs / n;
      if (f >= f0 && f <= f1) {
        total += std::norm(X[k]);
        count++;
      }
    }
  }
  return 10 * std::log10(total / std::max(1, count));
}

static std::vector<double> resample(const std::vector<double>& x, uint32_t in, uint32_t out, FilterPhase ph) {
  Resampler r;
  r.init(in, out, 1, ph);
  std::vector<double> y;
  for (size_t o = 0; o < x.size(); o += 4096) r.process(&x[o], std::min<size_t>(4096, x.size() - o), y);
  r.flush(y);
  return y;
}

int main() {
  printf("resampler\n");
  for (auto ph : {FilterPhase::Linear, FilterPhase::Minimum}) {
    const char* name = ph == FilterPhase::Linear ? "linear" : "minimum";
    struct Case {
      uint32_t in, out;
    };
    for (Case c : {Case{96000, 44100}, Case{44100, 48000}, Case{48000, 44100}, Case{44100, 96000}, Case{192000, 48000}}) {
      // panjang keluaran sesuai rasio
      auto x = sine(1000, 0.5, c.in, c.in * 2);
      auto y = resample(x, c.in, c.out, ph);
      double expectLen = double(x.size()) * c.out / c.in;
      CHECK(std::fabs(double(y.size()) - expectLen) <= 2, "%s %u→%u panjang %zu vs %.1f", name, c.in, c.out, y.size(), expectLen);
      // respons rata di passband (1 kHz & 19 kHz)
      for (double f : {1000.0, 19000.0}) {
        auto xs = sine(f, 0.5, c.in, c.in * 2);
        auto ys = resample(xs, c.in, c.out, ph);
        double g = toDb(amp(ys, f, c.out, c.out / 4, c.out) / 0.5);
        CHECK(std::fabs(g) < 0.05, "%s %u→%u gain %.0f Hz = %.4f dB", name, c.in, c.out, f, g);
      }
      // distorsi/noise: semua selain nada 1 kHz < −110 dB
      auto ys = resample(sine(1000, 0.5, c.in, c.in * 2), c.in, c.out, ph);
      for (double f : {2000.0, 3000.0, 7000.0, 15000.0}) {
        double h = toDb(amp(ys, f, c.out, c.out / 4, c.out) / 0.5);
        CHECK(h < -110, "%s %u→%u komponen palsu %.0f Hz = %.1f dB", name, c.in, c.out, f, h);
      }
      // aliasing: nada di atas Nyquist keluaran harus diredam
      if (c.out < c.in) {
        double fa = c.out * 0.5 + 3000;  // 3 kHz di atas Nyquist keluaran
        auto ya = resample(sine(fa, 0.5, c.in, c.in * 2), c.in, c.out, ph);
        double alias = c.out - fa;
        double a = toDb(amp(ya, alias, c.out, c.out / 4, c.out) / 0.5);
        CHECK(a < -100, "%s %u→%u alias %.0f Hz = %.1f dB", name, c.in, c.out, alias, a);
      }
    }
    // pre-ringing: impuls → linear simetris (ada energi sebelum puncak), minimum hampir tidak ada
    std::vector<double> imp(48000, 0.0);
    imp[24000] = 1;
    auto yi = resample(imp, 48000, 44100, ph);
    size_t peak = 0;
    for (size_t i = 0; i < yi.size(); i++)
      if (std::fabs(yi[i]) > std::fabs(yi[peak])) peak = i;
    double pre = 0, total = 0;
    for (size_t i = 0; i < yi.size(); i++) {
      total += yi[i] * yi[i];
      if (i + 2 < peak) pre += yi[i] * yi[i];
    }
    double preDb = 10 * std::log10(pre / total + 1e-30);
    if (ph == FilterPhase::Linear) {
      CHECK(preDb > -20, "linear: energi pre-ringing %.1f dB (harus ada)", preDb);
      CHECK(std::fabs(double(peak) - 24000.0 * 44100 / 48000) < 2, "linear: puncak tidak bergeser (%zu)", peak);
    } else {
      CHECK(preDb < -40, "minimum: energi pre-ringing %.1f dB (harus kecil)", preDb);
    }
  }

  printf("dither\n");
  {
    // sinyal sangat pelan (−100 dBFS, < 1 LSB 16-bit): tanpa dither hilang total; dengan TPDF tetap terdengar
    const double fs = 44100;
    auto x = sine(1000, std::ldexp(1.0, -15) * 0.45, fs, 44100 * 4);
    Ditherer d;
    d.init(16, 1, fs, false);
    std::vector<double> q(x.size()), trunc(x.size());
    for (size_t i = 0; i < x.size(); i++) {
      q[i] = d.quantize(x[i], 0);
      d.nextFrame();
      trunc[i] = std::nearbyint(x[i] * 32768);
    }
    double sig = amp(q, 1000, fs, 0, q.size()) / 32768;
    double ref = std::ldexp(1.0, -15) * 0.45;
    CHECK(std::fabs(toDb(sig / ref)) < 1.5, "TPDF mempertahankan sinyal di bawah 1 LSB (%.2f dB)", toDb(sig / ref));
    bool allZero = true;
    for (double v : trunc) allZero &= v == 0;
    CHECK(allZero, "tanpa dither sinyal hilang (sebagai pembanding)");
    // noise shaping: noise 1–10 kHz turun, > 18 kHz naik dibanding TPDF datar
    auto quiet = sine(1000, 0.25, fs, 44100 * 6);
    Ditherer flat, shaped;
    flat.init(16, 1, fs, false);
    shaped.init(16, 1, fs, true);
    std::vector<double> ef(quiet.size()), es(quiet.size());
    for (size_t i = 0; i < quiet.size(); i++) {
      ef[i] = flat.quantize(quiet[i], 0) - quiet[i] * 32768;
      flat.nextFrame();
      es[i] = shaped.quantize(quiet[i], 0) - quiet[i] * 32768;
      shaped.nextFrame();
    }
    for (double f0 : {500.0, 2000.0, 4000.0, 8000.0, 12000.0, 16000.0, 19000.0})
      printf("  %5.0f–%5.0f Hz: datar %.1f dB, shaped %.1f dB\n", f0, f0 * 1.25, bandPower(ef, fs, f0, f0 * 1.25), bandPower(es, fs, f0, f0 * 1.25));
    double flatLow = bandPower(ef, fs, 2000, 6000), shapedLow = bandPower(es, fs, 2000, 6000);
    double flatHigh = bandPower(ef, fs, 18500, 21500), shapedHigh = bandPower(es, fs, 18500, 21500);
    printf("  noise 2–6 kHz: datar %.1f dB, shaped %.1f dB | 18,5–21,5 kHz: datar %.1f, shaped %.1f\n", flatLow, shapedLow, flatHigh, shapedHigh);
    CHECK(shapedLow < flatLow - 8, "noise shaping menurunkan noise 2–6 kHz (pita paling peka telinga) ≥ 8 dB");
    CHECK(shapedHigh > flatHigh + 6, "noise shaping memindahkan noise ke > 18 kHz");
    // tidak pernah truncation: rata-rata error ≈ 0 (tanpa bias)
    double mean = 0;
    for (double v : ef) mean += v;
    mean /= ef.size();
    CHECK(std::fabs(mean) < 0.02, "dither tanpa bias DC (%.4f LSB)", mean);
  }

  printf("peak guard & analog\n");
  {
    PeakGuard g;
    g.init(1);
    std::vector<double> x(4000);
    for (size_t i = 0; i < x.size(); i++) x[i] = ((i >> 1) % 2) ? -1.0 : 1.0;  // +3 dBTP
    g.process(x.data(), x.size(), true);
    CHECK(std::fabs(g.gainDb() + 0.5) < 1e-9, "guard maks 0,5 dB (%.3f)", g.gainDb());
    CHECK(g.inputTpDb() > 2 && g.inputTpDb() < 3.5, "true-peak +3 dBTP terdeteksi (%.2f)", g.inputTpDb());
    AnalogStage a;
    a.init(48000, 1);
    auto s = sine(1000, 1.0, 48000, 48000 * 2);
    a.process(s.data(), s.size());
    double h1 = amp(s, 1000, 48000, 48000, 48000), h2 = amp(s, 2000, 48000, 48000, 48000);
    CHECK(h2 / h1 < 0.002 && h2 / h1 > 0.0005, "analog THD H2 = %.4f%%", 100 * h2 / h1);
  }

  printf("\n%d lulus, %d gagal\n", passes, failures);
  return failures ? 1 : 0;
}
