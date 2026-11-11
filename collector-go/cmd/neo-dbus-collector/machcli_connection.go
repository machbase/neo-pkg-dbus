package main

import (
	"fmt"
	"strings"
)

// The Go connector URI is not a SQLDriverConnect connection string. The C SDK
// can ignore its "server" key and connect with defaults instead, so native
// append must explicitly receive the selected host, port and credentials.
// Values containing CLI separators cannot be passed without changing meaning;
// reject them rather than accidentally selecting a different endpoint/account.
func machcliConnectionString(server conn) (string, error) {
	host, user := strings.TrimSpace(server.Host), strings.TrimSpace(server.User)
	if host == "" || user == "" || server.Port < 1 || server.Port > 65535 {
		return "", fmt.Errorf("native appender connection requires a host, user and valid port")
	}
	for _, field := range []struct{ name, value string }{
		{"host", host}, {"user", user}, {"password", server.Password},
	} {
		if strings.ContainsAny(field.value, ";\r\n\x00") {
			return "", fmt.Errorf("native appender %s contains an unsupported connection-string delimiter", field.name)
		}
	}
	return fmt.Sprintf("SERVER=%s;UID=%s;PWD=%s;CONNTYPE=1;PORT_NO=%d", host, strings.ToUpper(user), server.Password, server.Port), nil
}
