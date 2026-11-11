package main

import (
	"strings"
	"testing"
)

func TestMachcliConnectionUsesSelectedEndpointAndCredentials(t *testing.T) {
	got, err := machcliConnectionString(conn{Host: "plc-db.example", Port: 15656, User: "operator", Password: "caseSensitive_@:=Value"})
	if err != nil {
		t.Fatal(err)
	}
	want := "SERVER=plc-db.example;UID=OPERATOR;PWD=caseSensitive_@:=Value;CONNTYPE=1;PORT_NO=15656"
	if got != want {
		t.Fatal("native connection does not preserve the configured endpoint/credentials")
	}
}

func TestMachcliConnectionRejectsAmbiguousFieldsWithoutLeakingSecrets(t *testing.T) {
	for _, field := range []string{"host", "user", "password"} {
		for _, separator := range []string{";", "\r", "\n", "\x00"} {
			server := conn{Host: "127.0.0.1", Port: 5656, User: "sys", Password: "private-value"}
			switch field {
			case "host":
				server.Host += separator + "other"
			case "user":
				server.User += separator + "other"
			case "password":
				server.Password += separator + "other"
			}
			value, err := machcliConnectionString(server)
			if value != "" || err == nil || !strings.Contains(err.Error(), field) || strings.Contains(err.Error(), "private-value") {
				t.Fatalf("unsafe %s field was accepted or its error exposed a secret", field)
			}
		}
	}
	for _, server := range []conn{{Host: "host", User: "sys"}, {Host: "host", User: "sys", Port: 65536}, {User: "sys", Port: 5656}, {Host: "host", Port: 5656}} {
		if _, err := machcliConnectionString(server); err == nil {
			t.Fatal("incomplete native connection was accepted")
		}
	}
}
