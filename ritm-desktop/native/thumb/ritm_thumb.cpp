// ritm_thumb.cpp — Windows Shell thumbnail provider untuk file .ritm.
//
// Menampilkan foto sampul (booklet/cover.*) dengan logo RITM resmi di pojok kiri atas.
//  - Sampul terang  → logo hitam
//  - Sampul gelap   → logo putih
//  - Tanpa sampul   → GetThumbnail mengembalikan E_FAIL, Explorer memakai ikon file (basic, file-icon.ico)
//
// Format .ritm adalah ZIP. Sampul ditulis tanpa kompresi (method 0) oleh packager, jadi cukup
// dibaca langsung dari offset entry. Tidak ada pustaka pihak ketiga; dekoding memakai WIC.
//
// CLSID: {7C3A9E21-5B4D-4F8A-9E0C-2D1B6A8F4C37}
// Registrasi (dilakukan installer NSIS, lihat build/installer.nsh):
//   HKCR\CLSID\{CLSID}\InprocServer32 = <path dll>, ThreadingModel = Apartment
//   HKCR\.ritm\ShellEx\{E357FCCD-A995-4576-B01F-234630154E96} = {CLSID}

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objbase.h>
#include <shlwapi.h>
#include <shobjidl.h>
#include <thumbcache.h>
#include <wincodec.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <new>
#include <string>
#include <vector>

// {7C3A9E21-5B4D-4F8A-9E0C-2D1B6A8F4C37}
static const CLSID CLSID_RitmThumbnail = {
    0x7c3a9e21, 0x5b4d, 0x4f8a, {0x9e, 0x0c, 0x2d, 0x1b, 0x6a, 0x8f, 0x4c, 0x37}};

static std::atomic<long> g_locks{0};
static std::atomic<long> g_objects{0};

static uint16_t rd16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static uint32_t rd32(const uint8_t* p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static bool readAt(IStream* s, uint64_t off, void* buf, ULONG n) {
  LARGE_INTEGER li;
  li.QuadPart = (LONGLONG)off;
  if (FAILED(s->Seek(li, STREAM_SEEK_SET, nullptr))) return false;
  ULONG got = 0;
  if (FAILED(s->Read(buf, n, &got)) || got != n) return false;
  return true;
}

// Mencari entry "booklet/cover.*" di central directory ZIP dan membaca isinya (hanya method 0).
static bool extractCover(IStream* s, std::vector<uint8_t>& out) {
  STATSTG st{};
  if (FAILED(s->Stat(&st, STATFLAG_NONAME))) return false;
  const uint64_t size = st.cbSize.QuadPart;
  if (size < 22) return false;

  // End of central directory: dicari dari belakang (komentar ZIP maksimal 65535 byte).
  const ULONG tailLen = (ULONG)std::min<uint64_t>(size, 22 + 65535);
  std::vector<uint8_t> tail(tailLen);
  if (!readAt(s, size - tailLen, tail.data(), tailLen)) return false;
  int eocd = -1;
  for (int i = (int)tailLen - 22; i >= 0; --i) {
    if (rd32(&tail[i]) == 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return false;

  const uint16_t entries = rd16(&tail[eocd + 10]);
  const uint32_t cdSize = rd32(&tail[eocd + 12]);
  const uint32_t cdOff = rd32(&tail[eocd + 16]);
  if (cdSize == 0 || cdSize > 8u * 1024 * 1024) return false;

  std::vector<uint8_t> cd(cdSize);
  if (!readAt(s, cdOff, cd.data(), cdSize)) return false;

  size_t p = 0;
  for (uint16_t i = 0; i < entries && p + 46 <= cd.size(); ++i) {
    const uint8_t* e = &cd[p];
    if (rd32(e) != 0x02014b50) break;
    const uint16_t method = rd16(e + 10);
    const uint32_t csize = rd32(e + 20);
    const uint16_t nlen = rd16(e + 28);
    const uint16_t xlen = rd16(e + 30);
    const uint16_t clen = rd16(e + 32);
    const uint32_t localOff = rd32(e + 42);
    if (p + 46 + nlen > cd.size()) break;
    const std::string name((const char*)e + 46, nlen);
    p += 46u + nlen + xlen + clen;

    if (name.rfind("booklet/cover.", 0) != 0) continue;
    if (method != 0 || csize == 0 || csize > 32u * 1024 * 1024) return false;

    uint8_t lh[30];
    if (!readAt(s, localOff, lh, 30) || rd32(lh) != 0x04034b50) return false;
    const uint64_t dataOff = (uint64_t)localOff + 30 + rd16(lh + 26) + rd16(lh + 28);
    out.resize(csize);
    return readAt(s, dataOff, out.data(), csize);
  }
  return false;
}

// Pointer COM sederhana: Release otomatis saat keluar scope.
template <class T>
class Ptr {
 public:
  T* p = nullptr;
  ~Ptr() {
    if (p) p->Release();
  }
  T** put() { return &p; }
  T* operator->() const { return p; }
};

// ID resource logo RITM resmi (PNG transparan, lihat ritm_thumb.rc).
#define IDR_BADGE_DARK 101
#define IDR_BADGE_LIGHT 102

static HINSTANCE g_hinst = nullptr;

// Menempelkan logo RITM resmi (tanpa latar) di pojok kiri atas sampul.
// Sampul terang → logo hitam (IDR_BADGE_DARK); sampul gelap → logo putih (IDR_BADGE_LIGHT).
static HRESULT drawBadge(IWICImagingFactory* f, uint8_t* px, UINT size, bool bright) {
  HRSRC res = FindResourceW(g_hinst, MAKEINTRESOURCEW(bright ? IDR_BADGE_DARK : IDR_BADGE_LIGHT), MAKEINTRESOURCEW(10) /* RT_RCDATA */);
  if (!res) return E_FAIL;
  HGLOBAL mem = LoadResource(g_hinst, res);
  const void* data = mem ? LockResource(mem) : nullptr;
  const DWORD len = SizeofResource(g_hinst, res);
  if (!data || len == 0) return E_FAIL;

  HRESULT hr;
  Ptr<IWICStream> stream;
  if (FAILED(hr = f->CreateStream(stream.put()))) return hr;
  if (FAILED(hr = stream->InitializeFromMemory(static_cast<BYTE*>(const_cast<void*>(data)), len))) return hr;

  Ptr<IWICBitmapDecoder> decoder;
  if (FAILED(hr = f->CreateDecoderFromStream(stream.p, nullptr, WICDecodeMetadataCacheOnDemand, decoder.put())))
    return hr;
  Ptr<IWICBitmapFrameDecode> frame;
  if (FAILED(hr = decoder->GetFrame(0, frame.put()))) return hr;

  Ptr<IWICFormatConverter> conv;
  if (FAILED(hr = f->CreateFormatConverter(conv.put()))) return hr;
  if (FAILED(hr = conv->Initialize(frame.p, GUID_WICPixelFormat32bppPBGRA, WICBitmapDitherTypeNone, nullptr, 0.0,
                                   WICBitmapPaletteTypeCustom)))
    return hr;

  // Lebar logo 36% sisi sampul; tinggi mengikuti rasio asli logo.
  UINT iw = 0, ih = 0;
  if (FAILED(hr = frame->GetSize(&iw, &ih)) || iw == 0) return E_FAIL;
  const UINT bw = std::max<UINT>(1, (UINT)(size * 0.36));
  const UINT bh = std::max<UINT>(1, (UINT)((double)bw * ih / iw));
  const int left = (int)(size * 0.10);
  const int top = (int)(size * 0.10);  // pojok kiri atas, tanpa panel

  Ptr<IWICBitmapScaler> scaler;
  if (FAILED(hr = f->CreateBitmapScaler(scaler.put()))) return hr;
  if (FAILED(hr = scaler->Initialize(conv.p, bw, bh, WICBitmapInterpolationModeFant))) return hr;
  std::vector<uint8_t> tmp((size_t)bw * bh * 4);
  if (FAILED(hr = scaler->CopyPixels(nullptr, bw * 4, (UINT)tmp.size(), tmp.data()))) return hr;

  // Komposit premultiplied: dst = src + dst * (255 - a) / 255.
  for (UINT y = 0; y < bh; ++y) {
    const int dy = top + (int)y;
    if (dy < 0 || dy >= (int)size) continue;
    for (UINT x = 0; x < bw; ++x) {
      const int dx = left + (int)x;
      if (dx < 0 || dx >= (int)size) continue;
      const uint8_t* sp = &tmp[((size_t)y * bw + x) * 4];
      uint8_t* dp = px + ((size_t)dy * size + dx) * 4;
      const uint32_t inv = 255u - sp[3];
      dp[0] = (uint8_t)(sp[0] + (dp[0] * inv) / 255u);
      dp[1] = (uint8_t)(sp[1] + (dp[1] * inv) / 255u);
      dp[2] = (uint8_t)(sp[2] + (dp[2] * inv) / 255u);
    }
  }
  return S_OK;
}

// Mendekode sampul, memotong persegi di tengah, lalu menggambar logo RITM.
static HRESULT renderRitmThumb(const std::vector<uint8_t>& cover, UINT size, HBITMAP* out) {
  Ptr<IWICImagingFactory> f;
  HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(f.put()));
  if (FAILED(hr)) return hr;

  Ptr<IWICStream> stream;
  if (FAILED(hr = f->CreateStream(stream.put()))) return hr;
  if (FAILED(hr = stream->InitializeFromMemory(const_cast<BYTE*>(cover.data()), (DWORD)cover.size()))) return hr;

  Ptr<IWICBitmapDecoder> decoder;
  if (FAILED(hr = f->CreateDecoderFromStream(stream.p, nullptr, WICDecodeMetadataCacheOnDemand, decoder.put())))
    return hr;
  Ptr<IWICBitmapFrameDecode> frame;
  if (FAILED(hr = decoder->GetFrame(0, frame.put()))) return hr;

  UINT w = 0, h = 0;
  if (FAILED(hr = frame->GetSize(&w, &h))) return hr;
  const UINT sq = std::min(w, h);
  if (sq == 0) return E_FAIL;

  Ptr<IWICBitmapClipper> clip;
  if (FAILED(hr = f->CreateBitmapClipper(clip.put()))) return hr;
  WICRect rc{(INT)((w - sq) / 2), (INT)((h - sq) / 2), (INT)sq, (INT)sq};
  if (FAILED(hr = clip->Initialize(frame.p, &rc))) return hr;

  Ptr<IWICFormatConverter> conv;
  if (FAILED(hr = f->CreateFormatConverter(conv.put()))) return hr;
  if (FAILED(hr = conv->Initialize(clip.p, GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, nullptr, 0.0,
                                   WICBitmapPaletteTypeCustom)))
    return hr;

  Ptr<IWICBitmapScaler> scaler;
  if (FAILED(hr = f->CreateBitmapScaler(scaler.put()))) return hr;
  if (FAILED(hr = scaler->Initialize(conv.p, size, size, WICBitmapInterpolationModeFant))) return hr;

  BITMAPINFO bmi{};
  bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bmi.bmiHeader.biWidth = (LONG)size;
  bmi.bmiHeader.biHeight = -(LONG)size;  // top-down
  bmi.bmiHeader.biPlanes = 1;
  bmi.bmiHeader.biBitCount = 32;
  bmi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HBITMAP hbm = CreateDIBSection(nullptr, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!hbm || !bits) return E_OUTOFMEMORY;

  if (FAILED(hr = scaler->CopyPixels(nullptr, size * 4, size * size * 4, (BYTE*)bits))) {
    DeleteObject(hbm);
    return hr;
  }

  // Luminansi rata-rata sampul untuk memilih warna logo.
  uint8_t* px = (uint8_t*)bits;
  const size_t n = (size_t)size * size;
  double sum = 0;
  for (size_t i = 0; i < n; ++i) {
    const uint8_t b = px[i * 4], g = px[i * 4 + 1], r = px[i * 4 + 2];
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const bool bright = (sum / (double)n / 255.0) > 0.5;

  drawBadge(f.p, px, size, bright);

  // Semua piksel dibuat opaque (sampul sudah opaque; logo ditempel dengan alpha).
  for (size_t i = 0; i < n; ++i) px[i * 4 + 3] = 0xFF;

  *out = hbm;
  return S_OK;
}

class RitmThumb final : public IInitializeWithStream, public IThumbnailProvider {
 public:
  RitmThumb() { g_objects++; }
  ~RitmThumb() { g_objects--; }

  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IInitializeWithStream) {
      *ppv = static_cast<IInitializeWithStream*>(this);
    } else if (riid == __uuidof(IThumbnailProvider)) {
      *ppv = static_cast<IThumbnailProvider*>(this);
    } else {
      *ppv = nullptr;
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++ref_; }
  STDMETHODIMP_(ULONG) Release() override {
    const ULONG r = --ref_;
    if (r == 0) delete this;
    return r;
  }

  STDMETHODIMP Initialize(IStream* stream, DWORD) override {
    cover_.clear();
    if (!stream) return E_INVALIDARG;
    // Gagal membaca sampul bukan error fatal: GetThumbnail akan mengembalikan E_FAIL → ikon basic.
    extractCover(stream, cover_);
    return S_OK;
  }

  STDMETHODIMP GetThumbnail(UINT cx, HBITMAP* phbmp, WTS_ALPHATYPE* pdwAlpha) override {
    if (!phbmp || !pdwAlpha) return E_POINTER;
    *phbmp = nullptr;
    *pdwAlpha = WTSAT_RGB;
    if (cover_.empty() || cx == 0) return E_FAIL;
    return renderRitmThumb(cover_, std::min<UINT>(cx, 1024), phbmp);
  }

 private:
  std::atomic<ULONG> ref_{1};
  std::vector<uint8_t> cover_;
};

class Factory final : public IClassFactory {
 public:
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IClassFactory) {
      *ppv = static_cast<IClassFactory*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++ref_; }
  STDMETHODIMP_(ULONG) Release() override {
    const ULONG r = --ref_;
    if (r == 0) delete this;
    return r;
  }
  STDMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (outer) return CLASS_E_NOAGGREGATION;
    RitmThumb* t = new (std::nothrow) RitmThumb();
    if (!t) return E_OUTOFMEMORY;
    const HRESULT hr = t->QueryInterface(riid, ppv);
    t->Release();
    return hr;
  }
  STDMETHODIMP LockServer(BOOL lock) override {
    if (lock)
      g_locks++;
    else
      g_locks--;
    return S_OK;
  }

 private:
  std::atomic<ULONG> ref_{1};
};

BOOL APIENTRY DllMain(HINSTANCE h, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_hinst = h;
    DisableThreadLibraryCalls(h);
  }
  return TRUE;
}

extern "C" __declspec(dllexport) HRESULT __stdcall DllGetClassObject(REFCLSID rclsid, REFIID riid, void** ppv) {
  if (!ppv) return E_POINTER;
  *ppv = nullptr;
  if (!IsEqualCLSID(rclsid, CLSID_RitmThumbnail)) return CLASS_E_CLASSNOTAVAILABLE;
  Factory* f = new (std::nothrow) Factory();
  if (!f) return E_OUTOFMEMORY;
  const HRESULT hr = f->QueryInterface(riid, ppv);
  f->Release();
  return hr;
}

extern "C" __declspec(dllexport) HRESULT __stdcall DllCanUnloadNow() {
  return (g_locks == 0 && g_objects == 0) ? S_OK : S_FALSE;
}
