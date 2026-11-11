#include "native_db.hpp"
#include <cmath>
#include <iostream>
using namespace collector;
static int checks = 0;
static void check(bool good, const char *what) {
    ++checks;
    require(good, what);
}
int main(int argc, char **argv) {
    if (argc != 2) {
        std::cerr << "usage: native-tests CGI_ROOT\n";
        return 2;
    }
    try {
        auto secrets = read_json(fs::path(argv[1]) / "conf.d/go-collector-secrets.json");
        auto value = secrets.at("servers").at("localhost");
        Server server{value.at("host"), value.at("user"), value.at("password"), "", "", "", value.at("port")};
        struct Case {
            const char *type;
            int code;
            int kind;
            int64_t signed_value;
            uint64_t unsigned_value;
            double floating;
            bool null;
        };
        std::vector<Case> cases = {{"SHORT", 4, 1, -123, 0, 0, false},
                                   {"USHORT", 104, 0, 0, 65000, 0, false},
                                   {"INTEGER", 8, 1, -1234567, 0, 0, false},
                                   {"UINTEGER", 108, 0, 0, 4000000000ULL, 0, false},
                                   {"LONG", 12, 1, INT64_C(9223372036854775806), 0, 0, false},
                                   {"ULONG", 112, 0, 0, UINT64_C(18446744073709551614), 0, false},
                                   {"FLOAT", 16, 2, 0, 0, 1.25, false},
                                   {"DOUBLE", 20, 2, 0, 0, -1.25, false},
                                   {"SHORT", 4, 1, INT16_MIN, 0, 0, true}};
        for (auto &test : cases) {
            std::cout << "checking " << test.type << "\n" << std::flush;
            JobConfig job;
            job.server = server;
            job.database = {"localhost", "CPP_TYPE_20261105", "READING", ""};
            NativeSql sql(server);
            bool created = false;
            try {
                check(sql.query("SELECT NAME FROM M$SYS_TABLES WHERE NAME='CPP_TYPE_20261105'").empty(),
                      "owned test table already exists; inspect before replacing");
                sql.exec("CREATE TAG TABLE CPP_TYPE_20261105 (SENSOR VARCHAR(100) PRIMARY KEY,CLOCK DATETIME "
                         "BASETIME,READING " +
                         std::string(test.type) +
                         " SUMMARIZED,OPTIONAL VARCHAR(20),EXTRA INTEGER) TAG_PARTITION_COUNT=1");
                created = true;
                auto schema = table_schema(sql, job);
                check(schema.primary == "SENSOR" && schema.primary_index == 0 && schema.basetime_index == 1 &&
                          schema.value_index == 2 && schema.value_type == test.code,
                      "schema/mapping mismatch");
                Cancellation cancel;
                auto preparation = register_tags(job, schema, {"native-test"}, cancel);
                check(preparation.registered == 1 && preparation.missing == 1,
                      "new metadata tag was not registered");
                auto again = register_tags(job, schema, {"native-test"}, cancel);
                check(again.registered == 0 && again.existing == 1, "existing tag not reused");
                NativeAppender app(job, schema);
                app.cache_tags({"native-test"});
                Row row{};
                row.tag_index = 0;
                row.timestamp_ns = clock_ns(CLOCK_REALTIME);
                row.value_kind = test.kind;
                row.signed_value = test.signed_value;
                row.unsigned_value = test.unsigned_value;
                row.floating_value = test.floating;
                std::vector<Row> rows{row};
                app.append(rows);
                app.flush();
                bool reserved_rejected = false;
                try {
                    app.close();
                } catch (const std::exception &error) {
                    if (!test.null || std::string(error.what()).find("failed rows: 1") == std::string::npos)
                        throw;
                    reserved_rejected = true;
                }
                if (reserved_rejected) {
                    // The engine rejects NULL in a SUMMARIZED VALUE column.
                    // Preserve its reserved-value semantics; do not remap data.
                    auto count = sql.query("SELECT TO_CHAR(COUNT(*)) FROM CPP_TYPE_20261105");
                    check(count.size() == 1 && count[0][0] && *count[0][0] == "0",
                          "reserved NULL record was partially stored");
                    sql.exec("DROP TABLE CPP_TYPE_20261105");
                    created = false;
                    std::cout << test.type << " reserved NULL rejected by engine (expected)\n";
                    continue;
                }
                std::vector<SqlRow> result;
                auto deadline = clock_ns() + 5'000'000'000;
                while (result.empty() && clock_ns() < deadline) {
                    result =
                        sql.query("SELECT TO_CHAR(READING),OPTIONAL,EXTRA,TO_CHAR(TO_TIMESTAMP(CLOCK)) FROM "
                                  "CPP_TYPE_20261105 WHERE SENSOR='native-test' AND CLOCK>=FROM_TIMESTAMP(" +
                                  std::to_string(row.timestamp_ns) + ")");
                    if (result.empty())
                        std::this_thread::sleep_for(50ms);
                }
                check(result.size() == 1 && result[0].size() == 4, "stored record not visible");
                std::cout << "readingHex=";
                if (result[0][0])
                    for (unsigned char c : *result[0][0]) {
                        char hex[3];
                        snprintf(hex, sizeof(hex), "%02x", c);
                        std::cout << hex;
                    }
                else
                    std::cout << "NULL";
                std::cout << "\n" << std::flush;
                check(!result[0][1] && !result[0][2], "unused columns were not NULL");
                check(result[0][3] && *result[0][3] == std::to_string(row.timestamp_ns),
                      "nanosecond timestamp changed");
                if (test.null)
                    check(!result[0][0], "reserved short NULL value semantics changed");
                else {
                    check(bool(result[0][0]), "numeric value unexpectedly NULL");
                    if (test.kind == 0)
                        check(std::stoull(*result[0][0]) == test.unsigned_value,
                              "unsigned integer precision changed");
                    else if (test.kind == 1)
                        check(std::stoll(*result[0][0]) == test.signed_value,
                              "signed integer precision changed");
                    else
                        check(std::abs(std::stod(*result[0][0]) - test.floating) < 1e-6,
                              "float value changed");
                }
                if (std::string(test.type) == "INTEGER") {
                    NativeAppender validation(job, schema);
                    validation.cache_tags({"native-test"});
                    Row good = row, bad = row;
                    good.value_kind = 1;
                    good.signed_value = 7;
                    bad.value_kind = 2;
                    bad.floating_value = 1.5;
                    std::vector<Row> mixed{good, bad};
                    bool rejected = false;
                    try {
                        validation.append(mixed);
                    } catch (const std::exception &error) {
                        rejected = std::string(error.what()).find("fractional") != std::string::npos;
                    }
                    check(rejected, "fractional INTEGER batch was not rejected before append");
                    validation.flush();
                    validation.close();
                    auto count = sql.query("SELECT TO_CHAR(COUNT(*)) FROM CPP_TYPE_20261105");
                    check(count.size() == 1 && count[0][0] && *count[0][0] == "1",
                          "invalid batch partially wrote its earlier valid row");
                }
                sql.exec("DROP TABLE CPP_TYPE_20261105");
                created = false;
                std::cout << test.type << (test.null ? " NULL-reserved" : "") << " passed\n";
            } catch (...) {
                if (created)
                    try {
                        sql.exec("DROP TABLE CPP_TYPE_20261105");
                    } catch (...) {
                    }
                throw;
            }
        }
        std::cout << "native assertions=" << checks << " passed\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "FAIL " << error.what() << "\n";
        return 1;
    }
}
