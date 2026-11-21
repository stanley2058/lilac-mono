package main

import (
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func shortSocketPath(t *testing.T) string {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "worker.sock")
	if len(socket) <= maxSocketPath {
		return socket
	}
	dir, err := os.MkdirTemp("/tmp", "lt-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.RemoveAll(dir)
	})
	return filepath.Join(dir, "w.sock")
}

func TestHealthRequestDeadline(t *testing.T) {
	socket := shortSocketPath(t)
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		<-finished
	}()
	_, err = doWorkerRequest(socket, http.MethodGet, "/health", nil)
	timeout, ok := err.(net.Error)
	if !ok || !timeout.Timeout() {
		t.Fatalf("expected deadline, got %v", err)
	}
}
