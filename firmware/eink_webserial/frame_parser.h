// Serial frame parser for the e-ink uploader. Pure C++ (no Arduino headers)
// so it can be unit-tested on the host: see firmware/test/parser_test.cpp.
//
// Host -> device:
//   '?'                         handshake ping (only while idle)
//   "EPD1" + 5000 bytes + sum   image frame; sum = uint16 LE of all image bytes
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace frame {

constexpr size_t kImageBytes = 200 * 200 / 8;  // 1 bit per pixel
constexpr uint8_t kMagic[4] = {'E', 'P', 'D', '1'};
constexpr uint32_t kStallMs = 2000;  // partial frame older than this is dropped

enum class Event { None, Ping, Complete, BadChecksum, Timeout };

class Parser {
 public:
  Event feed(uint8_t b, uint32_t nowMs) {
    lastMs_ = nowMs;
    switch (state_) {
      case State::Hunting:
        if (b == kMagic[match_]) {
          if (++match_ == sizeof(kMagic)) {
            state_ = State::Body;
            pos_ = 0;
            sum_ = 0;
          }
          return Event::None;
        }
        match_ = (b == kMagic[0]) ? 1 : 0;
        return (match_ == 0 && b == '?') ? Event::Ping : Event::None;

      case State::Body:
        buf_[pos_++] = b;
        sum_ += b;
        if (pos_ == kImageBytes) state_ = State::Sum0;
        return Event::None;

      case State::Sum0:
        rxSum_ = b;
        state_ = State::Sum1;
        return Event::None;

      case State::Sum1:
        rxSum_ |= static_cast<uint16_t>(b) << 8;
        reset();
        return rxSum_ == sum_ ? Event::Complete : Event::BadChecksum;
    }
    return Event::None;
  }

  // Call regularly; drops a frame that stopped arriving mid-way.
  Event poll(uint32_t nowMs) {
    if (state_ != State::Hunting && nowMs - lastMs_ > kStallMs) {
      reset();
      return Event::Timeout;
    }
    return Event::None;
  }

  const uint8_t* image() const { return buf_; }

 private:
  enum class State { Hunting, Body, Sum0, Sum1 };

  void reset() {
    state_ = State::Hunting;
    match_ = 0;
  }

  State state_ = State::Hunting;
  uint8_t match_ = 0;
  size_t pos_ = 0;
  uint16_t sum_ = 0;
  uint16_t rxSum_ = 0;
  uint32_t lastMs_ = 0;
  uint8_t buf_[kImageBytes];
};

}  // namespace frame
