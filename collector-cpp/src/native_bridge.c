#include "native_bridge.h"
#include "append_impl.inc"
#include "bus_impl.inc"

void *collector_native_open(const char *dsn, const char *table, int columns, int primary, int basetime,
                            int value, const int *kinds, char *error) {
    return collector_open(dsn, table, columns, primary, basetime, value, kinds, error, 1024);
}
int collector_native_add_tag(void *app, const char *name) { return collector_add_tag(app, name); }
int collector_native_append(void *app, const collector_row_t *rows, int count) {
    return collector_append(app, rows, count, NULL);
}
int collector_native_flush(void *app) { return collector_flush(app); }
int collector_native_close(void *app, char *error) { return collector_close(app, error, 1024); }
const char *collector_native_error(void *app) { return collector_error(app); }
void collector_native_clear_tags(void *handle) {
    collector_appender_t *app = handle;
    int i;
    for (i = 0; i < app->tag_count; ++i)
        free(app->tags[i]);
    free(app->tags);
    app->tags = NULL;
    app->tag_count = 0;
    app->tag_capacity = 0;
    set_null(&app->params[app->primary_index], COL_VARYING);
}
void *collector_bus_create(const char *address, int cancel_fd, char *error) {
    return collector_bus_open(address, cancel_fd, error);
}
const char *collector_bus_call(void *bus, const char *destination, const char *prefix, uint16_t count,
                               const char *address) {
    char interface[256];
    if (snprintf(interface, sizeof(interface), "%s.device", prefix) >= (int)sizeof(interface))
        return NULL;
    return collector_bus_read(bus, destination, interface, count, address);
}
const char *collector_bus_last_error(void *bus) { return ((collector_bus *)bus)->error; }
int collector_bus_is_connected(void *bus) { return collector_bus_connected(bus); }
void collector_bus_destroy(void *bus) { collector_bus_close(bus); }
