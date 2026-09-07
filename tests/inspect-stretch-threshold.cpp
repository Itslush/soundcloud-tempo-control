#define _USE_MATH_DEFINES
#include "signalsmith-stretch.h"
#include <cmath>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <vector>

double frequency(const std::vector<float>& samples, int end) {
  double first = 0, last = 0;
  int count = 0;
  for (int i = end - 16384 + 1; i < end; ++i) {
    if (samples[i - 1] <= 0 && samples[i] > 0) {
      double position = i - 1 - double(samples[i - 1]) / (double(samples[i]) - samples[i - 1]);
      if (!count) first = position;
      last = position;
      ++count;
    }
  }
  if (count < 2) throw std::runtime_error("Missing output crossings");
  return (count - 1) * 48000.0 / (last - first);
}

void render(int seed, bool chirp) {
  constexpr int sampleRate = 48000, quantum = 128;
  const double rate = double(0.025f);
  signalsmith::stretch::SignalsmithStretch<float> stretch(seed);
  stretch.configure(2, 5760, 1440, true);
  stretch.reset();
  stretch.setTransposeFactor(1, 8000.0f / sampleRate);
  stretch.setFormantSemitones(0, false);
  stretch.setFormantBase(0);
  const int history = stretch.inputLatency() + stretch.outputLatency();
  std::vector<std::vector<float>> input(2, std::vector<float>(history));
  std::vector<std::vector<float>> block(2, std::vector<float>(quantum));
  std::vector<float> output(65536);
  for (int frame = -(stretch.outputLatency() / quantum) * quantum; frame < int(output.size()); frame += quantum) {
    const int end = int(std::round(sampleRate + (frame + stretch.outputLatency()) * rate + stretch.inputLatency()));
    for (int channel = 0; channel < 2; ++channel) {
      for (int i = 0; i < history; ++i) {
        double time = double(end - history + i) / sampleRate;
        double relative = time - 1;
        double phase = chirp ? 2400 * relative + 50 / rate * relative * relative : 960 * time;
        input[channel][i] = float(0.2 * std::sin(2 * M_PI * phase));
      }
    }
    stretch.seek(input, history, rate);
    stretch.process(input, 0, block, quantum);
    if (frame < 0) continue;
    for (int i = 0; i < quantum; ++i) {
      if (!std::isfinite(block[0][i])) throw std::runtime_error("Nonfinite output");
      output[frame + i] = block[0][i];
    }
  }
  const int early = (36000 / quantum) * quantum, late = (60000 / quantum) * quantum;
  const double earlyHz = frequency(output, early), lateHz = frequency(output, late);
  const double slope = (lateHz - earlyHz) * sampleRate / (late - early);
  std::cout << "{\"seed\":" << seed << ",\"chirp\":" << (chirp ? "true" : "false")
    << ",\"earlyHz\":" << earlyHz << ",\"lateHz\":" << lateHz << ",\"slope\":" << slope
    << ",\"withinOriginalThreshold\":" << ((chirp ? slope >= 75 && slope <= 125 : std::abs(lateHz - 960) < 8) ? "true" : "false") << "}";
}

int main() {
  std::cout << std::setprecision(12) << "{\"status\":\"OBSERVED\",\"cases\":[";
  for (int seed = 1; seed <= 4; ++seed) {
    if (seed > 1) std::cout << ',';
    render(seed, false);
    std::cout << ',';
    render(seed, true);
  }
  std::cout << "]}\n";
}
