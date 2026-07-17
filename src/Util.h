#pragma once
#include <filesystem>
#include <variant>
#include <fstream>
#include <functional>
#include "emscripten/console.h"

namespace fs = std::filesystem;

enum UntarStatus
{
  Successful,
  IncorrectFormat,
  IncorrectFiletype,
  FailedOpen,
  FailedWrite,
  FailedClose
};

extern "C" void fireEv(int idx, const char *content = nullptr);

int untar(unsigned char *tar, int tarSize, const char *storepath);
