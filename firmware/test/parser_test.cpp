// Host test for frame_parser.h:
//   clang++ -std=c++17 -I firmware/eink_webserial firmware/test/parser_test.cpp -o build/parser_test && build/parser_test
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "frame_parser.h"

using frame::Event;

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                  \
    }                                                              \
  } while (0)

static std::vector<uint8_t> makeFrame(uint8_t seed, bool corrupt = false) {
  std::vector<uint8_t> f = {'E', 'P', 'D', '1'};
  uint16_t sum = 0;
  for (size_t i = 0; i < frame::kImageBytes; i++) {
    uint8_t b = static_cast<uint8_t>(i * 31 + seed);
    f.push_back(b);
    sum += b;
  }
  if (corrupt) sum ^= 0x0101;
  f.push_back(sum & 0xFF);
  f.push_back(sum >> 8);
  return f;
}

// Feeds bytes, returns every non-None event in order.
static std::vector<Event> feedAll(frame::Parser& p, const std::vector<uint8_t>& bytes, uint32_t t = 0) {
  std::vector<Event> out;
  for (uint8_t b : bytes) {
    Event e = p.feed(b, t);
    if (e != Event::None) out.push_back(e);
  }
  return out;
}

int main() {
  {  // valid frame round-trips byte for byte
    frame::Parser p;
    auto f = makeFrame(7);
    auto ev = feedAll(p, f);
    CHECK(ev.size() == 1 && ev[0] == Event::Complete);
    bool same = true;
    for (size_t i = 0; i < frame::kImageBytes; i++) same &= p.image()[i] == f[4 + i];
    CHECK(same);
  }
  {  // bad checksum is reported, parser recovers for the next frame
    frame::Parser p;
    auto ev = feedAll(p, makeFrame(3, true));
    CHECK(ev.size() == 1 && ev[0] == Event::BadChecksum);
    ev = feedAll(p, makeFrame(4));
    CHECK(ev.size() == 1 && ev[0] == Event::Complete);
  }
  {  // leading garbage, including partial magic and boot noise, is skipped
    frame::Parser p;
    std::vector<uint8_t> bytes = {'x', 'E', 'P', 'E', 'E', 'P', 'D', 'x', 'E'};
    auto f = makeFrame(9);
    bytes.insert(bytes.end(), f.begin(), f.end());
    auto ev = feedAll(p, bytes);
    CHECK(ev.size() == 1 && ev[0] == Event::Complete);
    CHECK(p.image()[0] == f[4] && p.image()[frame::kImageBytes - 1] == f[f.size() - 3]);
  }
  {  // '?' pings only while idle; a '?' inside image data is just data
    frame::Parser p;
    auto ev = feedAll(p, {'?'});
    CHECK(ev.size() == 1 && ev[0] == Event::Ping);
    std::vector<uint8_t> f = {'E', 'P', 'D', '1'};
    uint16_t sum = 0;
    for (size_t i = 0; i < frame::kImageBytes; i++) {
      f.push_back('?');
      sum += '?';
    }
    f.push_back(sum & 0xFF);
    f.push_back(sum >> 8);
    ev = feedAll(p, f);
    CHECK(ev.size() == 1 && ev[0] == Event::Complete);
  }
  {  // a stalled partial frame times out, then a fresh frame still works
    frame::Parser p;
    auto f = makeFrame(1);
    std::vector<uint8_t> half(f.begin(), f.begin() + 1000);
    feedAll(p, half, 100);
    CHECK(p.poll(100 + frame::kStallMs) == Event::None);
    CHECK(p.poll(100 + frame::kStallMs + 1) == Event::Timeout);
    CHECK(p.poll(100 + frame::kStallMs + 2) == Event::None);
    auto ev = feedAll(p, f, 5000);
    CHECK(ev.size() == 1 && ev[0] == Event::Complete);
  }
  {  // idle parser never times out, even across millis() wraparound
    frame::Parser p;
    CHECK(p.poll(0xFFFFFFF0u) == Event::None);
    feedAll(p, {'E', 'P', 'D', '1', 0x00}, 0xFFFFFFF0u);
    CHECK(p.poll(0x00000010u) == Event::None);       // 32 ms later, wrapped
    CHECK(p.poll(0x00000010u + 3000) == Event::Timeout);
  }
  {  // two frames back to back
    frame::Parser p;
    auto a = makeFrame(1), b = makeFrame(2);
    a.insert(a.end(), b.begin(), b.end());
    auto ev = feedAll(p, a);
    CHECK(ev.size() == 2 && ev[0] == Event::Complete && ev[1] == Event::Complete);
  }

  if (failures == 0) std::printf("parser_test: all 7 cases passed\n");
  return failures == 0 ? 0 : 1;
}
