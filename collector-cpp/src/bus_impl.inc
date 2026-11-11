/* Same cancellable native transport as the Go candidate. No Go callback. */

#include <systemd/sd-bus.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <poll.h>
#include <errno.h>
#include <unistd.h>
#include <time.h>
typedef struct {
    sd_bus *bus;
    sd_bus_message *reply;
    int cancel_fd;
    char error[512];
} collector_bus;
typedef struct {
    int done, status;
    sd_bus_message *reply;
    char error[512];
} collector_reply;
static uint64_t collector_now_us(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint64_t)t.tv_sec * 1000000 + t.tv_nsec / 1000;
}
static void collector_bus_close(collector_bus *b) {
    if (!b)
        return;
    sd_bus_message_unref(b->reply);
    sd_bus_close_unref(b->bus);
    free(b);
}
static collector_bus *collector_bus_open(const char *address, int cancel_fd, char *error) {
    collector_bus *b = calloc(1, sizeof(*b));
    if (!b) {
        snprintf(error, 512, "calloc failed");
        return NULL;
    }
    b->cancel_fd = cancel_fd;
    int r = sd_bus_new(&b->bus);
    if (r >= 0)
        r = sd_bus_set_address(b->bus, address);
    if (r >= 0)
        r = sd_bus_set_bus_client(b->bus, 1);
    if (r >= 0)
        r = sd_bus_set_method_call_timeout(b->bus, UINT64_MAX);
    if (r >= 0)
        r = sd_bus_start(b->bus);
    if (r < 0) {
        snprintf(error, 512, "DBUS setup: %s", strerror(-r));
        collector_bus_close(b);
        return NULL;
    }
    return b;
}
static int collector_reply_ready(sd_bus_message *m, void *userdata, sd_bus_error *error) {
    (void)error;
    collector_reply *r = userdata;
    r->done = 1;
    r->status = 0;
    r->reply = sd_bus_message_ref(m);
    if (sd_bus_message_is_method_error(m, NULL) > 0) {
        const sd_bus_error *e = sd_bus_message_get_error(m);
        r->status = -EIO;
        snprintf(r->error, sizeof(r->error), "%s: %s", e && e->name ? e->name : "DBUS method error",
                 e && e->message ? e->message : "");
    }
    return 1;
}
static const char *collector_bus_read(collector_bus *b, const char *destination, const char *iface,
                                      uint16_t count, const char *address) {
    sd_bus_message *request = NULL;
    sd_bus_slot *slot = NULL;
    collector_reply reply = {0};
    const char *body = NULL;
    sd_bus_message_unref(b->reply);
    b->reply = NULL;
    b->error[0] = 0;
    int r = sd_bus_message_new_method_call(b->bus, &request, destination, "/ls/plc/device", iface,
                                           "GetDeviceData");
    if (r >= 0)
        r = sd_bus_message_append(request, "qs", count, address);
    if (r >= 0)
        r = sd_bus_call_async(b->bus, &slot, request, collector_reply_ready, &reply, UINT64_MAX);
    while (r >= 0 && !reply.done) {
        struct pollfd cancellation = {b->cancel_fd, POLLIN, 0};
        if (poll(&cancellation, 1, 0) > 0) {
            r = -ECANCELED;
            break;
        }
        r = sd_bus_process(b->bus, NULL);
        if (r < 0 || reply.done)
            break;
        if (r > 0)
            continue;
        int fd = sd_bus_get_fd(b->bus), events = sd_bus_get_events(b->bus);
        uint64_t deadline = UINT64_MAX;
        if (fd < 0 || events < 0) {
            r = fd < 0 ? fd : events;
            break;
        }
        r = sd_bus_get_timeout(b->bus, &deadline);
        if (r < 0)
            break;
        int wait_ms = -1;
        if (deadline != UINT64_MAX) {
            uint64_t now = collector_now_us();
            uint64_t ms = deadline <= now ? 0 : (deadline - now + 999) / 1000;
            wait_ms = ms > INT32_MAX ? INT32_MAX : (int)ms;
        }
        struct pollfd fds[2] = {{fd, (short)events, 0}, {b->cancel_fd, POLLIN, 0}};
        int waited = poll(fds, 2, wait_ms);
        if (waited < 0) {
            if (errno == EINTR) {
                r = 0;
                continue;
            }
            r = -errno;
            break;
        }
        if (fds[1].revents) {
            r = -ECANCELED;
            break;
        }
        r = 0;
    }
    // Unregister BEFORE the stack callback state ceases to exist. No other thread
    // ever touches this bus object; cancellation only writes the separate pipe.
    sd_bus_slot_unref(slot);
    sd_bus_message_unref(request);
    if (r >= 0 && reply.done) {
        r = reply.status;
        if (r >= 0)
            r = sd_bus_message_read(reply.reply, "s", &body);
        if (r >= 0 && sd_bus_message_at_end(reply.reply, 1) <= 0)
            r = -EBADMSG;
    }
    if (r < 0) {
        snprintf(b->error, sizeof(b->error), "%s", reply.error[0] ? reply.error : strerror(-r));
        body = NULL;
    }
    b->reply = reply.reply;
    return body;
}
static int collector_bus_connected(collector_bus *b) { return b && sd_bus_is_open(b->bus) > 0; }
