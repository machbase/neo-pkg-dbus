//go:build machcli && cgo

package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "github.com/machbase/neo-client/v2"
)

func TestMachcliAppenderValueTypeCompatibility(t *testing.T) {
	if os.Getenv("NEO_DBUS_CGO_INTEGRATION") != "1" {
		t.Skip("set NEO_DBUS_CGO_INTEGRATION=1 to use a local Machbase server")
	}
	db := openIntegrationDB(t)
	defer db.Close()
	root := integrationConfigRoot(t)

	tests := []struct {
		name    string
		sqlType string
		value   any
		literal string
	}{
		{name: "double-cgo", sqlType: "DOUBLE", value: 123.25, literal: "123.25"},
		{name: "short-near-min", sqlType: "SHORT", value: int64(-32767), literal: "-32767"},
		{name: "ushort-max", sqlType: "USHORT", value: uint64(65534), literal: "65534"},
		{name: "integer-near-min", sqlType: "INTEGER", value: int64(-2147483647), literal: "-2147483647"},
		{name: "uinteger-max", sqlType: "UINTEGER", value: uint64(4294967294), literal: "4294967294"},
		{name: "long-exact", sqlType: "LONG", value: int64(-9007199254740991), literal: "-9007199254740991"},
		{name: "ulong-exact", sqlType: "ULONG", value: uint64(9007199254740991), literal: "9007199254740991"},
		{name: "float", sqlType: "FLOAT", value: 1.25, literal: "1.25"},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			table := fmt.Sprintf("DBUS_CGO_TYPE_%d_%d", os.Getpid(), index)
			createIntegrationTable(t, db, table, test.sqlType)
			defer dropIntegrationTable(t, db, table)

			stream, err := openAppender(root, database{
				Server: "localhost", Table: table, ValueColumn: "MEASURE", StringValueColumn: "TEXT_VALUE",
			}, 8192)
			if err != nil {
				t.Fatal(err)
			}
			_, isMachcli := stream.(*machcliAppender)
			if !isMachcli {
				_ = stream.close()
				t.Fatal("numeric VALUE column did not select the machcli backend")
			}
			registry, rows := testTagRegistry(t, "TYPE_TAG")
			rows[0].Value = test.value
			if err := stream.prepareRegistry(context.Background(), registry, registry.count()); err != nil {
				_ = stream.close()
				t.Fatal(err)
			}
			if err := stream.append(rows, registry); err != nil {
				_ = stream.close()
				t.Fatal(err)
			}
			if err := stream.close(); err != nil {
				t.Fatal(err)
			}
			query := fmt.Sprintf(
				"SELECT COUNT(*) FROM %s WHERE MEASURE = %s AND TEXT_VALUE IS NULL AND EXTRA_VALUE IS NULL",
				table, test.literal,
			)
			var count int
			if err := db.QueryRowContext(context.Background(), query).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 1 {
				t.Fatalf("stored matching rows=%d, want 1", count)
			}
		})
	}
}

func TestIntegerAppenderRejectsFractionBeforeWritingBatch(t *testing.T) {
	if os.Getenv("NEO_DBUS_CGO_INTEGRATION") != "1" {
		t.Skip("set NEO_DBUS_CGO_INTEGRATION=1 to use a local Machbase server")
	}
	db := openIntegrationDB(t)
	defer db.Close()
	root := integrationConfigRoot(t)
	table := fmt.Sprintf("DBUS_CGO_REJECT_%d", os.Getpid())
	createIntegrationTable(t, db, table, "INTEGER")
	defer dropIntegrationTable(t, db, table)

	stream, err := openAppender(root, database{Server: "localhost", Table: table, ValueColumn: "MEASURE"}, 8192)
	if err != nil {
		t.Fatal(err)
	}
	registry, rows := testTagRegistry(t, "VALID", "INVALID")
	rows[0].Value = float64(7)
	rows[1].Value = 1.5
	if err := stream.prepareRegistry(context.Background(), registry, registry.count()); err != nil {
		_ = stream.close()
		t.Fatal(err)
	}
	err = stream.append(rows, registry)
	if err == nil || !strings.Contains(err.Error(), "fractional") {
		_ = stream.close()
		t.Fatalf("fractional INTEGER error=%v", err)
	}
	if err := stream.close(); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM "+table).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("partial invalid batch stored %d rows", count)
	}
}

func openIntegrationDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("machbase", "server=tcp://sys:manager@127.0.0.1:5656")
	if err != nil {
		t.Fatal(err)
	}
	return db
}

func integrationConfigRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "conf.d"), 0o755); err != nil {
		t.Fatal(err)
	}
	secret := struct {
		SchemaVersion int             `json:"schemaVersion"`
		Servers       map[string]conn `json:"servers"`
	}{
		SchemaVersion: 1,
		Servers: map[string]conn{
			"localhost": {Host: "127.0.0.1", Port: 5656, User: "sys", Password: "manager"},
		},
	}
	encoded, err := json.Marshal(secret)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "conf.d", secretFileName), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func createIntegrationTable(t *testing.T, db *sql.DB, table, valueType string) {
	t.Helper()
	ddl := fmt.Sprintf(
		"CREATE TAG TABLE %s (TAG_ID VARCHAR(100) PRIMARY KEY, TS DATETIME BASE TIME, MEASURE %s, TEXT_VALUE VARCHAR(128), EXTRA_VALUE INTEGER)",
		table, valueType,
	)
	if _, err := db.ExecContext(context.Background(), ddl); err != nil {
		t.Fatal(err)
	}
}

func dropIntegrationTable(t *testing.T, db *sql.DB, table string) {
	t.Helper()
	if _, err := db.ExecContext(context.Background(), "DROP TABLE "+table+" CASCADE"); err != nil {
		t.Errorf("drop %s: %v", table, err)
	}
}
