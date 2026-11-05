#include "io.hpp"

#include <atomic>
#include <chrono>
#include <cstring>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace ritm {

#ifdef _WIN32
static std::wstring widen(const std::string& s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), w.data(), n);
  return w;
}
FILE* openUtf8(const std::string& path, const char* mode) {
  std::wstring m(mode, mode + strlen(mode));
  return _wfopen(widen(path).c_str(), m.c_str());
}
int64_t fileSize(FILE* f) {
  int64_t cur = _ftelli64(f);
  _fseeki64(f, 0, SEEK_END);
  int64_t s = _ftelli64(f);
  _fseeki64(f, cur, SEEK_SET);
  return s;
}
bool seekTo(FILE* f, int64_t pos) { return _fseeki64(f, pos, SEEK_SET) == 0; }
void removeFile(const std::string& path) { _wremove(widen(path).c_str()); }
static std::string tempDir() {
  wchar_t buf[MAX_PATH + 1];
  DWORD n = GetTempPathW(MAX_PATH, buf);
  std::wstring w(buf, n);
  int len = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(len, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), s.data(), len, nullptr, nullptr);
  return s;
}
static unsigned long pid() { return GetCurrentProcessId(); }
#else
FILE* openUtf8(const std::string& path, const char* mode) { return fopen(path.c_str(), mode); }
int64_t fileSize(FILE* f) {
  off_t cur = ftello(f);
  fseeko(f, 0, SEEK_END);
  off_t s = ftello(f);
  fseeko(f, cur, SEEK_SET);
  return s;
}
bool seekTo(FILE* f, int64_t pos) { return fseeko(f, pos, SEEK_SET) == 0; }
void removeFile(const std::string& path) { remove(path.c_str()); }
static std::string tempDir() {
  const char* t = getenv("TMPDIR");
  return std::string(t ? t : "/tmp") + "/";
}
static unsigned long pid() { return (unsigned long)getpid(); }
#endif

static uint16_t le16(const uint8_t* p) { return uint16_t(p[0] | (p[1] << 8)); }
static uint32_t le32(const uint8_t* p) { return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24); }
static uint64_t le64(const uint8_t* p) { return uint64_t(le32(p)) | (uint64_t(le32(p + 4)) << 32); }

bool findStoredEntry(const std::string& zipPath, const std::string& entry, FileRegion& out, std::string& err) {
  FILE* f = openUtf8(zipPath, "rb");
  if (!f) {
    err = "tidak bisa membuka file";
    return false;
  }
  struct Closer {
    FILE* f;
    ~Closer() { fclose(f); }
  } closer{f};
  int64_t size = fileSize(f);
  // End Of Central Directory ada di 22 + ≤ 65535 byte terakhir
  int64_t tail = std::min<int64_t>(size, 22 + 65535 + 20);
  std::vector<uint8_t> buf(static_cast<size_t>(tail));
  if (!seekTo(f, size - tail) || fread(buf.data(), 1, buf.size(), f) != buf.size()) {
    err = "arsip tidak terbaca";
    return false;
  }
  int64_t eocd = -1;
  for (int64_t i = tail - 22; i >= 0; i--) {
    if (le32(&buf[size_t(i)]) == 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    err = "bukan arsip zip";
    return false;
  }
  uint64_t cdCount = le16(&buf[size_t(eocd + 10)]);
  uint64_t cdSize = le32(&buf[size_t(eocd + 12)]);
  uint64_t cdOffset = le32(&buf[size_t(eocd + 16)]);
  // ZIP64: locator 20 byte sebelum EOCD
  if ((cdOffset == 0xFFFFFFFFu || cdCount == 0xFFFF) && eocd >= 20 && le32(&buf[size_t(eocd - 20)]) == 0x07064b50) {
    uint64_t z64 = le64(&buf[size_t(eocd - 20 + 8)]);
    uint8_t r[56];
    if (!seekTo(f, int64_t(z64)) || fread(r, 1, 56, f) != 56 || le32(r) != 0x06064b50) {
      err = "zip64 rusak";
      return false;
    }
    cdCount = le64(r + 32);
    cdSize = le64(r + 40);
    cdOffset = le64(r + 48);
  }
  std::vector<uint8_t> cd(static_cast<size_t>(cdSize));
  if (!seekTo(f, int64_t(cdOffset)) || fread(cd.data(), 1, cd.size(), f) != cd.size()) {
    err = "direktori zip tidak terbaca";
    return false;
  }
  size_t p = 0;
  for (uint64_t k = 0; k < cdCount && p + 46 <= cd.size(); k++) {
    if (le32(&cd[p]) != 0x02014b50) break;
    uint16_t method = le16(&cd[p + 10]);
    uint64_t csize = le32(&cd[p + 20]);
    uint64_t usize = le32(&cd[p + 24]);
    uint16_t nlen = le16(&cd[p + 28]);
    uint16_t xlen = le16(&cd[p + 30]);
    uint16_t clen = le16(&cd[p + 32]);
    uint64_t lho = le32(&cd[p + 42]);
    std::string name(reinterpret_cast<const char*>(&cd[p + 46]), nlen);
    // field extra ZIP64 (0x0001) bila ukuran/offset 0xFFFFFFFF
    size_t x = p + 46 + nlen, xe = x + xlen;
    while (x + 4 <= xe && x + 4 <= cd.size()) {
      uint16_t id = le16(&cd[x]), len = le16(&cd[x + 2]);
      if (id == 0x0001) {
        size_t q = x + 4;
        if (usize == 0xFFFFFFFFu) usize = le64(&cd[q]), q += 8;
        if (csize == 0xFFFFFFFFu) csize = le64(&cd[q]), q += 8;
        if (lho == 0xFFFFFFFFu) lho = le64(&cd[q]);
      }
      x += 4 + len;
    }
    if (name == entry) {
      if (method != 0) {
        err = "entry terkompresi (bukan stored)";
        return false;
      }
      uint8_t lh[30];
      if (!seekTo(f, int64_t(lho)) || fread(lh, 1, 30, f) != 30 || le32(lh) != 0x04034b50) {
        err = "header lokal rusak";
        return false;
      }
      out.path = zipPath;
      out.offset = int64_t(lho) + 30 + le16(lh + 26) + le16(lh + 28);
      out.size = int64_t(csize);
      if (out.offset + out.size > size) {
        err = "entry melewati ukuran file";
        return false;
      }
      return true;
    }
    p += 46 + nlen + xlen + clen;
  }
  err = "entry tidak ditemukan: " + entry;
  return false;
}

std::string extractToTemp(const FileRegion& r, const std::string& ext, std::string& err) {
  static std::atomic<int> seq{0};
  auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
  std::string path = tempDir() + "ritm-audio-" + std::to_string(pid()) + "-" + std::to_string(stamp % 1000000) + "-" +
                     std::to_string(seq++) + "." + ext;
  FILE* in = openUtf8(r.path, "rb");
  if (!in) {
    err = "tidak bisa membuka sumber";
    return {};
  }
  FILE* out = openUtf8(path, "wb");
  if (!out) {
    fclose(in);
    err = "tidak bisa membuat file sementara";
    return {};
  }
  seekTo(in, r.offset);
  std::vector<char> buf(1 << 20);
  int64_t left = r.size;
  bool ok = true;
  const bool unscramble = r.scrambled && !r.entry.empty();
  XorStream xs(r.entry);
  while (left > 0) {
    size_t n = size_t(std::min<int64_t>(left, int64_t(buf.size())));
    if (fread(buf.data(), 1, n, in) != n) {
      ok = false;
      break;
    }
    if (unscramble) xs.apply(buf.data(), n);
    if (fwrite(buf.data(), 1, n, out) != n) {
      ok = false;
      break;
    }
    left -= int64_t(n);
  }
  fclose(in);
  fclose(out);
  if (!ok) {
    removeFile(path);
    err = "gagal menyalin audio";
    return {};
  }
  return path;
}

}  // namespace ritm
