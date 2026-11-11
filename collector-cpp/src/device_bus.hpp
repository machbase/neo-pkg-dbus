#pragma once
#include "model.hpp"
#include "native_bridge.h"
namespace collector {
class DeviceBus {
    void *handle_ = nullptr;

  public:
    explicit DeviceBus(Cancellation &cancel) {
        const char *configured = getenv("DBUS_SYSTEM_BUS_ADDRESS");
        const char *address =
            configured && *configured ? configured : "unix:path=/run/dbus/system_bus_socket";
        char error[512]{};
        handle_ = collector_bus_create(address, cancel.fd(), error);
        require(handle_, error);
    }
    ~DeviceBus() {
        if (handle_)
            collector_bus_destroy(handle_);
    }
    DeviceBus(const DeviceBus &) = delete;
    bool connected() const { return collector_bus_is_connected(handle_); }
    // The pointer is owned by sd_bus_message until this object's next read or
    // destruction. The reader parses synchronously, never enqueues this pointer,
    // and never shares a DeviceBus between reader OS threads.
    const char *read(const JobConfig &job, const Call &call) {
        const char *body = collector_bus_call(handle_, job.destination.c_str(), job.prefix.c_str(),
                                              uint16_t(call.count), call.address.c_str());
        if (!body)
            throw std::runtime_error(collector_bus_last_error(handle_));
        return body;
    }
};
} // namespace collector
