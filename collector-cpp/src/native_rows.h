#pragma once
#include <stdint.h>
// Every pooled row owns its numeric value; no pointer into a temporary JSON
// message or a Job's mutable configuration survives queue handoff.
typedef struct {
    int32_t tag_index;
    int64_t timestamp_ns;
    int64_t signed_value;
    uint64_t unsigned_value;
    double floating_value;
    int32_t value_kind; /* 0=unsigned, 1=signed, 2=floating */
} collector_row_t;
