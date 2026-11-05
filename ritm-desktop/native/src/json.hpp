// JSON minimal untuk protokol perintah/event (satu objek per baris).
// Mendukung: objek, array, string (escape standar + \uXXXX → UTF-8), angka, true/false/null.
#pragma once
#include <cmath>
#include <cstdio>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

namespace ritm::json {

struct Value {
  enum Type { Null, Bool, Number, String, Array, Object } type = Null;
  bool b = false;
  double n = 0;
  std::string s;
  std::vector<Value> a;
  std::map<std::string, Value> o;

  bool has(const std::string& k) const { return type == Object && o.count(k) > 0; }
  const Value& operator[](const std::string& k) const {
    static const Value none;
    auto it = o.find(k);
    return type == Object && it != o.end() ? it->second : none;
  }
  std::string str(const std::string& def = "") const { return type == String ? s : def; }
  double num(double def = 0) const { return type == Number ? n : def; }
  bool boolean(bool def = false) const { return type == Bool ? b : def; }
};

class Parser {
 public:
  explicit Parser(const std::string& t) : t_(t) {}
  bool parse(Value& out) {
    try {
      ws();
      out = value();
      ws();
      return i_ == t_.size();
    } catch (...) {
      return false;
    }
  }

 private:
  const std::string& t_;
  size_t i_ = 0;
  void ws() {
    while (i_ < t_.size() && (t_[i_] == ' ' || t_[i_] == '\t' || t_[i_] == '\n' || t_[i_] == '\r')) i_++;
  }
  char peek() { return i_ < t_.size() ? t_[i_] : '\0'; }
  void expect(char c) {
    if (peek() != c) throw 1;
    i_++;
  }
  Value value() {
    ws();
    char c = peek();
    if (c == '{') return object();
    if (c == '[') return array();
    if (c == '"') {
      Value v;
      v.type = Value::String;
      v.s = string();
      return v;
    }
    if (t_.compare(i_, 4, "true") == 0) {
      i_ += 4;
      Value v;
      v.type = Value::Bool;
      v.b = true;
      return v;
    }
    if (t_.compare(i_, 5, "false") == 0) {
      i_ += 5;
      Value v;
      v.type = Value::Bool;
      return v;
    }
    if (t_.compare(i_, 4, "null") == 0) {
      i_ += 4;
      return Value{};
    }
    return number();
  }
  Value object() {
    Value v;
    v.type = Value::Object;
    expect('{');
    ws();
    if (peek() == '}') {
      i_++;
      return v;
    }
    for (;;) {
      ws();
      std::string k = string();
      ws();
      expect(':');
      v.o[k] = value();
      ws();
      if (peek() == ',') {
        i_++;
        continue;
      }
      expect('}');
      return v;
    }
  }
  Value array() {
    Value v;
    v.type = Value::Array;
    expect('[');
    ws();
    if (peek() == ']') {
      i_++;
      return v;
    }
    for (;;) {
      v.a.push_back(value());
      ws();
      if (peek() == ',') {
        i_++;
        continue;
      }
      expect(']');
      return v;
    }
  }
  static void utf8(std::string& out, uint32_t cp) {
    if (cp < 0x80) out += char(cp);
    else if (cp < 0x800) {
      out += char(0xC0 | (cp >> 6));
      out += char(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out += char(0xE0 | (cp >> 12));
      out += char(0x80 | ((cp >> 6) & 0x3F));
      out += char(0x80 | (cp & 0x3F));
    } else {
      out += char(0xF0 | (cp >> 18));
      out += char(0x80 | ((cp >> 12) & 0x3F));
      out += char(0x80 | ((cp >> 6) & 0x3F));
      out += char(0x80 | (cp & 0x3F));
    }
  }
  uint32_t hex4() {
    if (i_ + 4 > t_.size()) throw 1;
    uint32_t v = std::stoul(t_.substr(i_, 4), nullptr, 16);
    i_ += 4;
    return v;
  }
  std::string string() {
    expect('"');
    std::string out;
    while (i_ < t_.size()) {
      char c = t_[i_++];
      if (c == '"') return out;
      if (c != '\\') {
        out += c;
        continue;
      }
      char e = t_[i_++];
      switch (e) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'u': {
          uint32_t cp = hex4();
          if (cp >= 0xD800 && cp < 0xDC00 && t_.compare(i_, 2, "\\u") == 0) {
            i_ += 2;
            uint32_t lo = hex4();
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          }
          utf8(out, cp);
          break;
        }
        default: out += e;
      }
    }
    throw 1;
  }
  Value number() {
    size_t start = i_;
    while (i_ < t_.size() && (isdigit((unsigned char)t_[i_]) || t_[i_] == '-' || t_[i_] == '+' || t_[i_] == '.' || t_[i_] == 'e' || t_[i_] == 'E')) i_++;
    if (start == i_) throw 1;
    Value v;
    v.type = Value::Number;
    v.n = std::stod(t_.substr(start, i_ - start));
    return v;
  }
};

inline bool parse(const std::string& text, Value& out) { return Parser(text).parse(out); }

/** Penulis objek JSON satu baris: Writer().add("ev","pos").add("t",1.5).str() */
class Writer {
 public:
  Writer& add(const std::string& k, const std::string& v) {
    key(k);
    quote(v);
    return *this;
  }
  Writer& add(const std::string& k, const char* v) { return add(k, std::string(v)); }
  Writer& add(const std::string& k, double v) {
    key(k);
    num(v);
    return *this;
  }
  Writer& add(const std::string& k, int v) { return add(k, double(v)); }
  Writer& add(const std::string& k, uint32_t v) { return add(k, double(v)); }
  Writer& add(const std::string& k, uint64_t v) { return add(k, double(v)); }
  Writer& addBool(const std::string& k, bool v) {
    key(k);
    s_ += v ? "true" : "false";
    return *this;
  }
  Writer& raw(const std::string& k, const std::string& json) {
    key(k);
    s_ += json;
    return *this;
  }
  Writer& addNums(const std::string& k, const std::vector<double>& v) {
    key(k);
    s_ += '[';
    for (size_t i = 0; i < v.size(); i++) {
      if (i) s_ += ',';
      num(v[i]);
    }
    s_ += ']';
    return *this;
  }
  std::string str() const { return s_ + "}"; }

  static std::string escape(const std::string& v) {
    std::string out = "\"";
    for (unsigned char c : v) {
      switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
          if (c < 0x20) {
            char b[8];
            snprintf(b, sizeof b, "\\u%04x", c);
            out += b;
          } else out += char(c);
      }
    }
    return out + "\"";
  }

 private:
  std::string s_ = "{";
  void key(const std::string& k) {
    if (s_.size() > 1) s_ += ',';
    s_ += escape(k);
    s_ += ':';
  }
  void quote(const std::string& v) { s_ += escape(v); }
  void num(double v) {
    if (!std::isfinite(v)) {
      s_ += "null";
      return;
    }
    char b[32];
    snprintf(b, sizeof b, "%.10g", v);
    s_ += b;
  }
};

}  // namespace ritm::json
