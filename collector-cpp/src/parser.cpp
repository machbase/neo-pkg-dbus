#include "model.hpp"

namespace collector {
static uint64_t raw_integer(const Json &value) {
    require(value.is_number_unsigned() || (value.is_number_integer() && value.get<int64_t>() >= 0),
            "PLC data must contain unsigned integers");
    return value.get<uint64_t>();
}
void decode_rows_dom(std::string_view body, const Call &call, std::vector<Row> &rows) {
    auto data = Json::parse(body.begin(), body.end());
    require(data.is_object() && data.contains("rtn") && data.contains("data-count") &&
                data.contains("time-stamp-us"),
            "DBus result fields are missing");
    require(raw_integer(data["rtn"]) == 1 && raw_integer(data["data-count"]) == uint64_t(call.count),
            "DBus GetDeviceData result count mismatch");
    auto &values = data.at("data");
    require(values.is_array() && values.size() == size_t(call.count),
            "DBus GetDeviceData result count mismatch");
    auto micros = raw_integer(data["time-stamp-us"]);
    require(micros > 0 && micros <= uint64_t(INT64_MAX / 1000),
            "DBus result timestamp is missing or invalid");
    require(call.offset <= rows.size() && size_t(call.count) <= rows.size() - call.offset,
            "LS read buffer does not match prepared layout");
    for (int i = 0; i < call.count; ++i) {
        auto &row = rows[call.offset + size_t(i)];
        row = {};
        row.tag_index = int32_t(call.tags[size_t(i)].index);
        row.timestamp_ns = int64_t(micros) * 1000;
        convert_raw(raw_integer(values[size_t(i)]), call.bits, call.tags[size_t(i)], row);
    }
}

// Avoid a per-cycle JSON DOM and temporary numeric array. The parser writes
// directly into the Call's owned segment. No string/message pointer is retained.
// Timestamp may follow data in the PLC JSON, so it is assigned after validation.
class DeviceSax final : public nlohmann::json_sax<Json> {
    enum Field { Unknown, Result, Count, Timestamp, Data } field_ = Unknown;
    const Call &call_;
    std::vector<Row> &rows_;
    int depth_ = 0, data_depth_ = -1;
    size_t index_ = 0;
    uint64_t result_ = 0, count_ = 0, micros_ = 0;
    bool root_object_ = false, complete_ = false, has_data_ = false;
    bool reject(const std::string &reason) {
        error = reason;
        return false;
    }
    bool number(uint64_t value) {
        if (depth_ == 1) {
            if (field_ == Result)
                result_ = value;
            else if (field_ == Count)
                count_ = value;
            else if (field_ == Timestamp)
                micros_ = value;
            else if (field_ == Data)
                return reject("PLC data must be an array");
            return true;
        }
        if (data_depth_ == 2 && depth_ == 2) {
            if (index_ >= size_t(call_.count))
                return reject("DBus GetDeviceData result count mismatch");
            auto &row = rows_[call_.offset + index_];
            row = {};
            row.tag_index = int32_t(call_.tags[index_].index);
            try {
                convert_raw(value, call_.bits, call_.tags[index_], row);
            } catch (const std::exception &e) {
                return reject(e.what());
            }
            ++index_;
        }
        return true;
    }
    bool noninteger() {
        if ((depth_ == 1 && field_ != Unknown) || (data_depth_ == 2 && depth_ == 2))
            return reject("PLC result fields and data must be unsigned integers");
        return true;
    }

  public:
    std::string error;
    DeviceSax(const Call &call, std::vector<Row> &rows) : call_(call), rows_(rows) {}
    bool null() override { return noninteger(); }
    bool boolean(bool) override { return noninteger(); }
    bool number_integer(number_integer_t value) override {
        return value < 0 ? noninteger() : number(uint64_t(value));
    }
    bool number_unsigned(number_unsigned_t value) override { return number(value); }
    bool number_float(number_float_t, const string_t &) override { return noninteger(); }
    bool string(string_t &) override { return noninteger(); }
    bool binary(binary_t &) override { return reject("binary JSON is not supported"); }
    bool start_object(std::size_t) override {
        if (depth_ == 0)
            root_object_ = true;
        else if ((depth_ == 1 && field_ != Unknown) || (data_depth_ == 2 && depth_ == 2))
            return reject("unexpected PLC JSON object");
        if (++depth_ > 256)
            return reject("PLC JSON nesting is too deep");
        return true;
    }
    bool key(string_t &key) override {
        if (depth_ == 1) {
            field_ = key == "rtn"             ? Result
                     : key == "data-count"    ? Count
                     : key == "time-stamp-us" ? Timestamp
                     : key == "data"          ? Data
                                              : Unknown;
        }
        return true;
    }
    bool end_object() override {
        if (--depth_ == 0)
            complete_ = true;
        return true;
    }
    bool start_array(std::size_t) override {
        if (depth_ == 0 || (depth_ == 1 && field_ != Data && field_ != Unknown) ||
            (data_depth_ == 2 && depth_ == 2))
            return reject("unexpected PLC JSON array");
        if (depth_ == 1 && field_ == Data) {
            data_depth_ = 2;
            index_ = 0;
            has_data_ = true;
        }
        if (++depth_ > 256)
            return reject("PLC JSON nesting is too deep");
        return true;
    }
    bool end_array() override {
        if (depth_ == data_depth_)
            data_depth_ = -1;
        --depth_;
        return true;
    }
    bool parse_error(std::size_t, const std::string &, const nlohmann::detail::exception &) override {
        return reject("invalid PLC JSON");
    }
    void finish() {
        require(root_object_ && complete_ && has_data_ && result_ == 1 && count_ == uint64_t(call_.count) &&
                    index_ == size_t(call_.count),
                "DBus GetDeviceData result count mismatch");
        require(micros_ > 0 && micros_ <= uint64_t(INT64_MAX / 1000),
                "DBus result timestamp is missing or invalid");
        for (int i = 0; i < call_.count; ++i)
            rows_[call_.offset + size_t(i)].timestamp_ns = int64_t(micros_) * 1000;
    }
};
void decode_rows(std::string_view body, const Call &call, std::vector<Row> &rows) {
    require(call.offset <= rows.size() && size_t(call.count) <= rows.size() - call.offset,
            "LS read buffer does not match prepared layout");
    DeviceSax sax(call, rows);
    bool parsed = Json::sax_parse(body.begin(), body.end(), &sax);
    require(parsed, sax.error.empty() ? "invalid PLC JSON" : sax.error);
    sax.finish();
}
} // namespace collector
