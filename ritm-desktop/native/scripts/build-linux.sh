#!/bin/sh
# Bangun ritm-audio untuk Linux (ALSA + PipeWire backend).
set -e
cd "$(dirname "$0")/.."
mkdir -p build bin/linux-x64

DEPS_PREFIX="${RITM_DEPS_PREFIX:-$HOME/.local/ritm-native-deps}"
INCLUDES=""
LIBDIRS=""
if [ -d "$DEPS_PREFIX/usr/include" ]; then
  INCLUDES="-I$DEPS_PREFIX/usr/include -I$DEPS_PREFIX/usr/include/pipewire-0.3 -I$DEPS_PREFIX/usr/include/spa-0.2"
fi
if [ -d "$DEPS_PREFIX/usr/lib64" ]; then
  LIBDIRS="-L$DEPS_PREFIX/usr/lib64"
fi

g++ -std=c++17 -O2 -Wall -Wextra -pthread \
  $INCLUDES $LIBDIRS \
  src/main.cpp src/engine.cpp src/io.cpp src/decode/wav.cpp src/decode/flac.cpp \
  src/backend/file.cpp src/platform_stub.cpp \
  src/backend/linux.cpp src/backend/alsa.cpp src/backend/pipewire.cpp \
  -lasound -lpipewire-0.3 -lm \
  -o bin/linux-x64/ritm-audio

cp bin/linux-x64/ritm-audio build/ritm-audio

g++ -std=c++17 -O2 -Wall -Wextra -lm -o build/dsp_test tests/dsp_test.cpp

echo "OK bin/linux-x64/ritm-audio build/ritm-audio build/dsp_test"
