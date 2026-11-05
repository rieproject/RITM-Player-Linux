// Backend Windows: WASAPI Exclusive (bit-perfect, event-driven, MMCSS "Pro Audio") & Shared.
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <initguid.h>
#include <propsys.h>
#include <audioclient.h>
#include <avrt.h>
#include <functiondiscoverykeys_devpkey.h>
#include <mmdeviceapi.h>

#include <atomic>
#include <cstring>
#include <mutex>
#include <thread>

#include "backend.hpp"

namespace ritm {
namespace {

const GUID SUB_PCM = {0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
const GUID SUB_FLOAT = {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

template <class T>
void release(T*& p) {
  if (p) {
    p->Release();
    p = nullptr;
  }
}

std::string narrow(const wchar_t* w) {
  if (!w) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}
std::wstring widen(const std::string& s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  std::wstring w(n > 0 ? n - 1 : 0, L'\0');
  if (n > 1) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n);
  return w;
}

struct ComInit {
  bool ok;
  ComInit() { ok = SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED)); }
  ~ComInit() {
    if (ok) CoUninitialize();
  }
};

std::string hrText(HRESULT hr) {
  switch (hr) {
    case AUDCLNT_E_DEVICE_IN_USE: return "perangkat sedang dipakai aplikasi lain dalam mode exclusive";
    case AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED:
      return "mode exclusive dimatikan — aktifkan 'Allow applications to take exclusive control' di Properti perangkat suara";
    case AUDCLNT_E_UNSUPPORTED_FORMAT: return "format tidak didukung perangkat";
    case AUDCLNT_E_DEVICE_INVALIDATED: return "perangkat dicabut atau dinonaktifkan";
    case AUDCLNT_E_ENDPOINT_CREATE_FAILED: return "gagal membuka endpoint audio";
    default: {
      char b[32];
      snprintf(b, sizeof b, "HRESULT 0x%08lx", (unsigned long)hr);
      return b;
    }
  }
}

WAVEFORMATEXTENSIBLE makeFormat(uint32_t rate, uint16_t ch, uint16_t container, uint16_t valid, bool isFloat) {
  WAVEFORMATEXTENSIBLE w{};
  w.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  w.Format.nChannels = ch;
  w.Format.nSamplesPerSec = rate;
  w.Format.wBitsPerSample = container;
  w.Format.nBlockAlign = WORD(ch * container / 8);
  w.Format.nAvgBytesPerSec = rate * w.Format.nBlockAlign;
  w.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
  w.Samples.wValidBitsPerSample = valid;
  w.dwChannelMask = ch == 1 ? SPEAKER_FRONT_CENTER : ch == 2 ? (SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT) : 0;
  w.SubFormat = isFloat ? SUB_FLOAT : SUB_PCM;
  return w;
}

DeviceFormat fromWave(const WAVEFORMATEX* w) {
  DeviceFormat f;
  f.rate = w->nSamplesPerSec;
  f.channels = w->nChannels;
  f.containerBits = w->wBitsPerSample;
  f.validBits = w->wBitsPerSample;
  f.isFloat = w->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
  if (w->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
    auto* x = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(w);
    f.validBits = x->Samples.wValidBitsPerSample ? x->Samples.wValidBitsPerSample : w->wBitsPerSample;
    f.isFloat = IsEqualGUID(x->SubFormat, SUB_FLOAT);
  }
  return f;
}

class WasapiBackend final : public Backend {
 public:
  ~WasapiBackend() override { close(); }
  std::string name() const override { return "wasapi"; }

  std::vector<DeviceInfo> devices() override {
    ComInit com;
    std::vector<DeviceInfo> out;
    IMMDeviceEnumerator* en = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&en))) return out;
    std::string defId;
    IMMDevice* def = nullptr;
    if (SUCCEEDED(en->GetDefaultAudioEndpoint(eRender, eConsole, &def))) {
      LPWSTR id = nullptr;
      if (SUCCEEDED(def->GetId(&id))) defId = narrow(id), CoTaskMemFree(id);
      release(def);
    }
    IMMDeviceCollection* col = nullptr;
    if (SUCCEEDED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &col))) {
      UINT n = 0;
      col->GetCount(&n);
      for (UINT i = 0; i < n; i++) {
        IMMDevice* d = nullptr;
        if (FAILED(col->Item(i, &d))) continue;
        DeviceInfo info;
        LPWSTR id = nullptr;
        if (SUCCEEDED(d->GetId(&id))) info.id = narrow(id), CoTaskMemFree(id);
        IPropertyStore* ps = nullptr;
        if (SUCCEEDED(d->OpenPropertyStore(STGM_READ, &ps))) {
          PROPVARIANT v;
          PropVariantInit(&v);
          if (SUCCEEDED(ps->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) info.name = narrow(v.pwszVal);
          PropVariantClear(&v);
          release(ps);
        }
        IAudioClient* c = nullptr;
        if (SUCCEEDED(d->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&c))) {
          WAVEFORMATEX* mix = nullptr;
          if (SUCCEEDED(c->GetMixFormat(&mix))) info.mix = fromWave(mix), CoTaskMemFree(mix);
          release(c);
        }
        info.isDefault = info.id == defId;
        out.push_back(info);
        release(d);
      }
      release(col);
    }
    release(en);
    return out;
  }

  bool open(const OpenRequest& req, DeviceFormat& out, std::string& err) override {
    close();
    ComInit com;
    mode_ = req.mode;
    IMMDeviceEnumerator* en = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&en);
    if (FAILED(hr)) return (err = "MMDeviceEnumerator: " + hrText(hr), false);
    if (!req.deviceId.empty()) hr = en->GetDevice(widen(req.deviceId).c_str(), &dev_);
    if (req.deviceId.empty() || FAILED(hr)) hr = en->GetDefaultAudioEndpoint(eRender, eConsole, &dev_);
    release(en);
    if (FAILED(hr)) return (err = "tidak ada perangkat keluaran: " + hrText(hr), false);
    if (FAILED(hr = activate())) return (err = hrText(hr), false);

    WAVEFORMATEXTENSIBLE chosen{};
    if (req.mode == OutputMode::Shared) {
      WAVEFORMATEX* mix = nullptr;
      if (FAILED(hr = client_->GetMixFormat(&mix))) return (err = hrText(hr), false);
      memcpy(&chosen, mix, std::min<size_t>(sizeof chosen, sizeof(WAVEFORMATEX) + mix->cbSize));
      fmt_ = fromWave(mix);
      REFERENCE_TIME dur = std::max<REFERENCE_TIME>(REFERENCE_TIME(1e7 * req.bufferFrames / fmt_.rate), 100000);
      hr = client_->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, dur * 2, 0, mix, nullptr);
      CoTaskMemFree(mix);
      if (FAILED(hr)) return (err = "Shared: " + hrText(hr), false);
    } else {
      // Negosiasi: rate sumber → keluarga sama → lainnya; bit: persis → container lebih besar
      const uint16_t ch = req.channels == 1 ? 2 : std::min<uint16_t>(req.channels, 8);
      bool found = false;
      for (uint32_t r : rateCandidates(req.rate)) {
        for (auto [c, v] : bitCandidates(req.bits, req.srcFloat)) {
          auto w = makeFormat(r, ch, c, v, false);
          if (client_->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &w.Format, nullptr) == S_OK) {
            chosen = w;
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (!found) {
        // sebagian driver hanya menerima float 32 di exclusive
        auto w = makeFormat(req.rate, ch, 32, 32, true);
        if (client_->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &w.Format, nullptr) == S_OK) chosen = w, found = true;
      }
      if (!found) return (err = "perangkat tidak menerima format exclusive apa pun (coba mode Shared)", false);
      fmt_ = fromWave(&chosen.Format);
      REFERENCE_TIME defP = 0, minP = 0;
      client_->GetDevicePeriod(&defP, &minP);
      REFERENCE_TIME period = std::max<REFERENCE_TIME>(minP, REFERENCE_TIME(1e7 * req.bufferFrames / fmt_.rate + 0.5));
      hr = client_->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, period, period, &chosen.Format, nullptr);
      if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
        UINT32 frames = 0;
        client_->GetBufferSize(&frames);
        period = REFERENCE_TIME(1e7 * frames / fmt_.rate + 0.5);
        release(client_);
        if (FAILED(hr = activate())) return (err = hrText(hr), false);
        hr = client_->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, period, period, &chosen.Format, nullptr);
      }
      if (FAILED(hr)) return (err = "Exclusive: " + hrText(hr), false);
    }
    event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (FAILED(hr = client_->SetEventHandle(event_))) return (err = hrText(hr), false);
    if (FAILED(hr = client_->GetBufferSize(&bufferFrames_))) return (err = hrText(hr), false);
    if (FAILED(hr = client_->GetService(__uuidof(IAudioRenderClient), (void**)&render_))) return (err = hrText(hr), false);
    REFERENCE_TIME lat = 0;
    client_->GetStreamLatency(&lat);
    latency_ = double(bufferFrames_) / fmt_.rate + double(lat) / 1e7;
    out = fmt_;
    healthy_ = true;
    return true;
  }

  bool start(RenderCallback cb, std::string& err) override {
    cb_ = std::move(cb);
    // isi buffer pertama sebelum Start agar tidak ada glitch awal
    if (!fill(true)) return (err = "gagal mengisi buffer awal", false);
    HRESULT hr = client_->Start();
    if (FAILED(hr)) return (err = hrText(hr), false);
    running_ = true;
    thread_ = std::thread([this] { loop(); });
    return true;
  }

  void close() override {
    running_ = false;
    if (event_) SetEvent(event_);
    if (thread_.joinable()) thread_.join();
    if (client_) client_->Stop();
    release(render_);
    release(client_);
    release(dev_);
    if (event_) CloseHandle(event_), event_ = nullptr;
  }

  double latency() const override { return latency_; }

 private:
  HRESULT activate() { return dev_->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client_); }

  bool fill(bool initial) {
    UINT32 frames = bufferFrames_;
    if (mode_ == OutputMode::Shared) {
      UINT32 pad = 0;
      if (FAILED(client_->GetCurrentPadding(&pad))) return false;
      frames = bufferFrames_ - pad;
      if (frames == 0) return true;
    }
    BYTE* data = nullptr;
    HRESULT hr = render_->GetBuffer(frames, &data);
    if (FAILED(hr)) {
      if (hr == AUDCLNT_E_DEVICE_INVALIDATED) healthy_ = false;
      return false;
    }
    if (initial) memset(data, 0, size_t(frames) * fmt_.bytesPerFrame());
    else cb_(data, frames);
    render_->ReleaseBuffer(frames, 0);
    return true;
  }

  void loop() {
    ComInit com;
    DWORD task = 0;
    HANDLE mm = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
    while (running_) {
      DWORD w = WaitForSingleObject(event_, 2000);
      if (!running_) break;
      if (w != WAIT_OBJECT_0) continue;  // timeout: perangkat berhenti meminta data
      if (!fill(false) && !healthy_) break;
    }
    if (mm) AvRevertMmThreadCharacteristics(mm);
  }

  OutputMode mode_ = OutputMode::Exclusive;
  IMMDevice* dev_ = nullptr;
  IAudioClient* client_ = nullptr;
  IAudioRenderClient* render_ = nullptr;
  HANDLE event_ = nullptr;
  UINT32 bufferFrames_ = 0;
  DeviceFormat fmt_;
  double latency_ = 0;
  RenderCallback cb_;
  std::atomic<bool> running_{false}, healthy_{true};
  std::thread thread_;
};

}  // namespace

std::unique_ptr<Backend> createSystemBackend() { return std::make_unique<WasapiBackend>(); }

}  // namespace ritm
#endif
