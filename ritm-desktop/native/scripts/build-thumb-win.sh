#!/bin/sh
# Membangun ritm_thumb.dll (Shell thumbnail provider untuk file .ritm) untuk Windows x64 lewat mingw-w64.
# Lencana RITM (res/logo-on-*.png) ikut dimasukkan sebagai resource.
# Keluaran: bin/win-x64/ritm_thumb.dll (dipaketkan electron-builder ke resources/thumb/).
set -e
cd "$(dirname "$0")/../thumb"
OUT=../bin/win-x64
mkdir -p "$OUT"
CXX=${CXX:-x86_64-w64-mingw32-g++}
RC=${RC:-x86_64-w64-mingw32-windres}
"$RC" -O coff ritm_thumb.rc -o ritm_thumb_res.o
"$CXX" -std=c++17 -O2 -Wall -Wextra -shared -static-libgcc -static-libstdc++ \
  -o "$OUT/ritm_thumb.dll" ritm_thumb.cpp ritm_thumb_res.o \
  -lwindowscodecs -lole32 -loleaut32 -lshlwapi -lgdi32 -luuid
rm -f ritm_thumb_res.o
echo "ok: $OUT/ritm_thumb.dll"
