#!/bin/sh
# Bangun ritm-audio untuk macOS (universal arm64 + x86_64). Jalankan di Mac dengan Xcode Command Line Tools.
# STATUS: backend CoreAudio & dekoder AudioToolbox belum pernah dikompilasi/diuji — laporkan error build-nya.
set -e
cd "$(dirname "$0")/.."
mkdir -p bin/mac
clang++ -std=c++17 -O2 -Wall -Wextra -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 -o bin/mac/ritm-audio \
  src/main.cpp src/engine.cpp src/io.cpp src/decode/wav.cpp src/decode/flac.cpp src/decode/audiotoolbox.cpp \
  src/backend/file.cpp src/backend/coreaudio.cpp src/platform_stub.cpp \
  -framework CoreAudio -framework AudioToolbox -framework CoreFoundation
echo "OK bin/mac/ritm-audio"
