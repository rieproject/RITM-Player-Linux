// Dekoder OS tidak tersedia di Linux (Media Foundation / AudioToolbox).
// Backend sistem Linux ada di backend/linux.cpp (+ alsa.cpp, pipewire.cpp).
#if !defined(_WIN32) && !defined(__APPLE__)
#include "backend/backend.hpp"
#include "decode/decoder.hpp"
namespace ritm {
#if !defined(__linux__)
std::unique_ptr<Backend> createSystemBackend() { return nullptr; }
#endif
std::unique_ptr<Decoder> openSystemDecoder(const FileRegion&, const std::string&, std::string&) { return nullptr; }
}  // namespace ritm
#endif
