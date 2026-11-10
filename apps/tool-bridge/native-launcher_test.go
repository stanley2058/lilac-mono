package main

import (
	"net"
	"net/http"
	"path/filepath"
	"testing"
)

func TestHealthRequestDeadline(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "worker.sock")
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
