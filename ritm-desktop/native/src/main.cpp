// ritm-audio — mesin audio native RITM Player.
// Protokol: satu objek JSON per baris. Perintah lewat stdin, event lewat stdout.
//   {"cmd":"devices"} {"cmd":"config",...} {"cmd":"open","path":..,"entry":..,"at":0,"play":true}
//   {"cmd":"play"} {"cmd":"pause"} {"cmd":"seek","t":12.5} {"cmd":"stop"} {"cmd":"mute","on":true} {"cmd":"quit"}
// Mode uji: ritm-audio --sink "file:out.wav;rates=..;bits=.." --render in.wav [--entry audio/01.flac] [--config '{..}']
#include <cstdio>
#include <cstring>
#include <iostream>
#include <mutex>
#include <string>

#include "backend/backend.hpp"
#include "engine.hpp"
#include "io.hpp"
#include "json.hpp"

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

using namespace ritm;
using json::Writer;

static const char* VERSION = "1.0.0";

static std::mutex outMu;
static void emitLine(const std::string& line) {
  std::lock_guard<std::mutex> lk(outMu);
  fwrite(line.data(), 1, line.size(), stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static void applyConfig(EngineConfig& c, const json::Value& v) {
  if (v.has("mode")) c.mode = v["mode"].str() == "shared" ? OutputMode::Shared : OutputMode::Exclusive;
  if (v.has("device")) c.deviceId = v["device"].str();
  if (v.has("buffer")) c.bufferFrames = uint32_t(std::max(128.0, std::min(8192.0, v["buffer"].num(1024))));
  if (v.has("phase")) c.phase = v["phase"].str() == "minimum" ? FilterPhase::Minimum : FilterPhase::Linear;
  if (v.has("dither")) c.dither = v["dither"].boolean(true);
  if (v.has("shaping")) c.noiseShaping = v["shaping"].boolean(true);
  if (v.has("profile")) c.profile = v["profile"].str() == "analog" ? Profile::Analog : Profile::Purist;
  if (v.has("guard")) c.guard = v["guard"].boolean(true);
  if (v.has("volume")) c.volume = std::max(0.0, std::min(1.0, v["volume"].num(1)));
  if (v.has("backend")) c.api = v["backend"].str() == "pipewire" ? "pipewire" : "alsa";
}

static bool regionFor(const std::string& path, const std::string& entry, FileRegion& r, std::string& err) {
  if (!entry.empty()) {
    if (!findStoredEntry(path, entry, r, err)) return false;
    r.entry = entry;
    return true;
  }
  FILE* f = openUtf8(path, "rb");
  if (!f) return (err = "tidak bisa membuka file", false);
  r = FileRegion{path, 0, fileSize(f), {}, false};
  fclose(f);
  return true;
}

static std::string devicesJson(Backend& b) {
  std::string list = "[";
  bool first = true;
  for (auto& d : b.devices()) {
    if (!first) list += ",";
    first = false;
    list += Writer()
                .add("id", d.id)
                .add("name", d.name)
                .addBool("default", d.isDefault)
                .raw("mix", Writer().add("rate", d.mix.rate).add("bits", int(d.mix.validBits)).addBool("float", d.mix.isFloat).add("channels", int(d.mix.channels)).str())
                .str();
  }
  return list + "]";
}

int main(int argc, char** argv) {
#ifdef _WIN32
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stdin), _O_BINARY);
#endif
  std::string sink, render, entry, config, next;
  for (int i = 1; i + 1 < argc; i++) {
    std::string a = argv[i];
    if (a == "--sink") sink = argv[++i];
    else if (a == "--render") render = argv[++i];
    else if (a == "--entry") entry = argv[++i];
    else if (a == "--config") config = argv[++i];
    else if (a == "--next") next = argv[++i];
  }
  if (argc > 1 && std::string(argv[1]) == "--version") {
    printf("%s\n", VERSION);
    return 0;
  }

  std::unique_ptr<Backend> backend = sink.rfind("file:", 0) == 0 ? createFileBackend(sink) : createSystemBackend();
  if (!backend) {
    emitLine(Writer().add("ev", "error").add("code", "BACKEND").add("message", "backend audio tidak tersedia di platform ini").str());
    return 2;
  }
  Engine engine(*backend, emitLine);
  EngineConfig cfg;

  if (!render.empty()) {  // mode uji sekali jalan
    if (!config.empty()) {
      json::Value v;
      if (json::parse(config, v)) applyConfig(cfg, v);
    }
    engine.setConfig(cfg);
    FileRegion r;
    std::string err;
    if (!regionFor(render, entry, r, err)) {
      emitLine(Writer().add("ev", "error").add("code", "OPEN").add("message", err).str());
      return 1;
    }
    if (!engine.open(r, 0, true)) return 1;
    if (!next.empty()) {  // uji gapless: lagu kedua disiapkan selagi lagu pertama diputar
      FileRegion n;
      if (regionFor(next, "", n, err)) engine.preload(n);
    }
    bool ok = engine.waitEnded(600);
    engine.stop();
    return ok ? 0 : 3;
  }

  emitLine(Writer().add("ev", "ready").add("version", VERSION).add("backend", backend->name()).str());
  std::string line;
  while (std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty()) continue;
    json::Value v;
    if (!json::parse(line, v)) {
      emitLine(Writer().add("ev", "error").add("code", "PROTOCOL").add("message", "JSON tidak valid").str());
      continue;
    }
    std::string cmd = v["cmd"].str();
    if (cmd == "quit") break;
    if (cmd == "devices") emitLine(Writer().add("ev", "devices").raw("list", devicesJson(*backend)).str());
    else if (cmd == "config") {
      applyConfig(cfg, v);
      backend->setApi(cfg.api);
      engine.setConfig(cfg);
      emitLine(Writer().add("ev", "config").addBool("ok", true).str());
    } else if (cmd == "open") {
      FileRegion r;
      std::string err;
      if (!regionFor(v["path"].str(), v["entry"].str(), r, err)) {
        emitLine(Writer().add("ev", "error").add("code", "OPEN").add("message", err).str());
        continue;
      }
      r.scrambled = v["scramble"].str() == "xor-v1";
      engine.open(r, v["at"].num(0), v["play"].boolean(true));
    } else if (cmd == "preload") {
      // lagu berikutnya; gagal dibuka → tidak apa-apa, lagu itu nanti dibuka biasa lewat `open`
      FileRegion r;
      std::string err;
      if (regionFor(v["path"].str(), v["entry"].str(), r, err)) {
        r.scrambled = v["scramble"].str() == "xor-v1";
        engine.preload(r);
      }
    } else if (cmd == "play") engine.play();
    else if (cmd == "pause") engine.pause();
    else if (cmd == "seek") engine.seek(v["t"].num(0));
    else if (cmd == "stop") engine.stop();
    else if (cmd == "mute") engine.setMuted(v["on"].boolean(true));
    else emitLine(Writer().add("ev", "error").add("code", "PROTOCOL").add("message", "perintah tidak dikenal: " + cmd).str());
  }
  engine.stop();
  return 0;
}
