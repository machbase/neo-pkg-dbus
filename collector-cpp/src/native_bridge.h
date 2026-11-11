#pragma once
#include "native_rows.h"
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
void *collector_native_open(const char *dsn, const char *table, int columns, int primary, int basetime,
                            int value, const int *kinds, char *error);
int collector_native_add_tag(void *app, const char *name);
int collector_native_append(void *app, const collector_row_t *rows, int count);
int collector_native_flush(void *app);
int collector_native_close(void *app, char *error);
const char *collector_native_error(void *app);
void collector_native_clear_tags(void *app);
void *collector_bus_create(const char *address, int cancel_fd, char *error);
const char *collector_bus_call(void *bus, const char *destination, const char *prefix, uint16_t count,
                               const char *address);
const char *collector_bus_last_error(void *bus);
int collector_bus_is_connected(void *bus);
void collector_bus_destroy(void *bus);
#ifdef __cplusplus
}
#endif
