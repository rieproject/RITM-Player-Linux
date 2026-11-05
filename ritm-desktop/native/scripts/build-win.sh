#!/bin/sh
# Kompilasi silang ritm-audio.exe (Windows x64) dari Linux dengan mingw-w64 (paket g++-mingw-w64-x86-64-posix).
# Di Windows bisa juga lewat MSYS2 (UCRT64): ganti CXX=g++.
set -e
cd "$(dirname "$0")/.."
CXX=${CXX:-x86_64-w64-mingw32-g++-posix}
mkdir -p bin/win-x64
$CXX -std=c++17 -O2 -Wall -Wextra -static -DUNICODE -D_WIN32_WINNT=0x0A00 -o bin/win-x64/ritm-audio.exe \
  src/main.cpp src/engine.cpp src/io.cpp src/decode/wav.cpp src/decode/flac.cpp src/decode/mf.cpp \
  src/backend/file.cpp src/backend/wasapi.cpp src/platform_stub.cpp \
  -lole32 -loleaut32 -lavrt -lmfplat -lmfreadwrite -lmfuuid -luuid
echo "OK bin/win-x64/ritm-audio.exe"
