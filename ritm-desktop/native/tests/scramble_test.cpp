// Uji pembalik acakan xor-v1. Vektor harus sama dengan ritm-player/tests/scramble.test.ts.
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include "../src/io.hpp"

using ritm::XorStream;

int main() {
  int fails = 0;
  auto check = [&](bool ok, const char* what) {
    std::printf("%s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) ++fails;
  };

  // seed: fnv1a32("audio/01.flac") ^ 0x5249544D = 0x68042F9A
  check(XorStream::seedOf("audio/01.flac") == 0x68042F9Au, "seed audio/01.flac");

  // vektor: bytes 0..9 diacak dengan entry audio/01.flac
  const uint8_t expect[10] = {0x41, 0x34, 0x16, 0x50, 0x7b, 0x89, 0x35, 0x65, 0x89, 0xd8};
  std::vector<char> d(10);
  for (int i = 0; i < 10; ++i) d[size_t(i)] = char(i);
  XorStream xs("audio/01.flac");
  xs.apply(d.data(), d.size());
  bool same = true;
  for (int i = 0; i < 10; ++i) same = same && uint8_t(d[size_t(i)]) == expect[i];
  check(same, "vektor tetap cocok dengan TypeScript");

  // potongan: memanggil apply per potongan (tidak kelipatan 4) harus sama dengan sekaligus
  std::vector<char> a(37), b(37);
  for (size_t i = 0; i < a.size(); ++i) a[i] = b[i] = char(i * 3 + 1);
  XorStream whole("karaoke/01.wav");
  whole.apply(a.data(), a.size());
  XorStream parts("karaoke/01.wav");
  parts.apply(b.data(), 5);
  parts.apply(b.data() + 5, 11);
  parts.apply(b.data() + 16, 21);
  check(std::memcmp(a.data(), b.data(), a.size()) == 0, "potongan berurutan = sekaligus");

  // simetris
  XorStream again("karaoke/01.wav");
  again.apply(a.data(), a.size());
  bool back = true;
  for (size_t i = 0; i < a.size(); ++i) back = back && a[i] == char(i * 3 + 1);
  check(back, "acak dua kali = asli");

  std::printf("%s: %d gagal\n", fails ? "GAGAL" : "SEMUA LULUS", fails);
  return fails ? 1 : 0;
}
