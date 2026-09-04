//go:build linux

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	workerArg     = "--__lilac-tools-worker"
	directArg     = "--__lilac-tools-direct"
	capturedArg   = "--__lilac-tools-captured"
	workerName    = "tools-worker"
	maxSocketPath = 107
)

var buildID = "dev"

var forwardedEnvironment = [...]string{
	"TOOL_SERVER_BACKEND_URL",
	"TOOL_SERVER_BACKEND_SOCKET",
	"LILAC_REQUEST_ID",
	"LILAC_REQUEST_DELIVERY_ID",
	"LILAC_SESSION_ID",
	"LILAC_REQUEST_CLIENT",
	"LILAC_TOOL_CALL_ID",
	"LILAC_CONTROL_CAPABILITY",
	"LILAC_SUBAGENT_PROFILE",
	"LILAC_CURRENT_TURN_USER_ID",
	"LILAC_OPERATOR_TOKEN_FILE",
	"HOME",
	"NO_COLOR",
	"TERM",
}

type invocationRequest struct {
	BuildID       string            `json:"buildId"`
	Args          []string          `json:"args"`
	Cwd           string            `json:"cwd"`
	Environment   map[string]string `json:"env"`
	Stdin         string            `json:"stdin"`
	StdinIsTTY    *bool             `json:"stdinIsTTY,omitempty"`
	StdoutIsTTY   bool              `json:"stdoutIsTTY"`
	StdoutColumns *int              `json:"stdoutColumns,omitempty"`
}

type invocationResponse struct {
	exitCode int
	stdout   []byte
	stderr   []byte
}

type workerResponse struct {
	status int
	header http.Header
	body   []byte
}

type workerHealth struct {
	BuildID    string `json:"buildId"`
	Executable string `json:"executable"`
}

type invokeStatus int

const (
	invokeComplete invokeStatus = iota
	invokeUnavailable
	invokeDefect
)

func terminalState(file *os.File) *bool {
	target, err := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", file.Fd()))
	if err != nil {
		return nil
	}
	isTerminal := target == "/dev/console" || strings.HasPrefix(target, "/dev/pts/") ||
		strings.HasPrefix(target, "/dev/tty")
	if isTerminal {
		return &isTerminal
	}
	if target == os.DevNull {
		return nil
	}
	return &isTerminal
}

func terminalColumns(stdoutIsTTY bool) *int {
	if !stdoutIsTTY {
		return nil
	}
	columns, err := strconv.Atoi(os.Getenv("COLUMNS"))
	if err != nil || columns <= 0 {
		command := exec.Command("stty", "size")
		command.Stdin = os.Stdout
		output, commandErr := command.Output()
		if commandErr != nil {
			return nil
		}
		fields := strings.Fields(string(output))
		if len(fields) != 2 {
			return nil
		}
		columns, err = strconv.Atoi(fields[1])
		if err != nil || columns <= 0 {
			return nil
		}
	}
	return &columns
}

func firstCommandArgument(args []string) string {
	optionsEnded := false
	for _, argument := range args {
		if argument == "--" {
			optionsEnded = true
		}
		if !optionsEnded && (argument == "--operator" || argument == "--op") {
			continue
		}
		return argument
	}
	return ""
}

func commandIgnoresStdin(args []string) bool {
	command := firstCommandArgument(args)
	return command == "" || command == "onboard" || strings.HasPrefix(command, "--")
}

func booleanFlagEnabled(argument, name string) bool {
	if argument == name {
		return true
	}
	prefix := name + "="
	if !strings.HasPrefix(argument, prefix) {
		return false
	}
	return strings.ToLower(strings.TrimSpace(strings.TrimPrefix(argument, prefix))) != "false"
}

func argumentEnablesStdin(argument string) bool {
	if booleanFlagEnabled(argument, "--stdin") {
		return true
	}
	separator := strings.IndexByte(argument, '=')
	if separator < 0 {
		return false
	}
	name, value := argument[:separator], argument[separator+1:]
	if name == "--input" {
		return value == "@-" || value == "-"
	}
	return strings.HasPrefix(name, "--") && strings.HasSuffix(name, ":json") &&
		(value == "@-" || value == "-")
}

func consumesStdin(args []string) bool {
	if commandIgnoresStdin(args) {
		return false
	}
	for _, argument := range args {
		if argument == "--" {
			break
		}
		if booleanFlagEnabled(argument, "--help") {
			return false
		}
	}
	for _, argument := range args {
		if argument == "--" {
			return false
		}
		if argumentEnablesStdin(argument) {
			return true
		}
	}
	return false
}

func createRequest(args []string, stdinIsTTY *bool, stdoutIsTTY bool) ([]byte, error) {
	var input []byte
	if stdinIsTTY != nil && !*stdinIsTTY && consumesStdin(args) {
		var err error
		input, err = io.ReadAll(os.Stdin)
		if err != nil {
			return nil, err
		}
	}
	cwd, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	environment := make(map[string]string, len(forwardedEnvironment))
	for _, name := range forwardedEnvironment {
		if value, present := os.LookupEnv(name); present {
			environment[name] = value
		}
	}
	request := invocationRequest{
		BuildID:       buildID,
		Args:          args,
		Cwd:           cwd,
		Environment:   environment,
		Stdin:         string(input),
		StdoutIsTTY:   stdoutIsTTY,
		StdoutColumns: terminalColumns(stdoutIsTTY),
	}
	request.StdinIsTTY = stdinIsTTY
	return json.Marshal(request)
}

func ensureDirectory(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	current := string(filepath.Separator)
	created := false
	for _, part := range strings.Split(strings.TrimPrefix(filepath.Clean(absolute), current), current) {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		info, inspectErr := os.Lstat(current)
		switch {
		case errors.Is(inspectErr, os.ErrNotExist):
			createErr := os.Mkdir(current, 0o700)
			if createErr != nil && !errors.Is(createErr, os.ErrExist) {
				return createErr
			}
			created = createErr == nil && current == absolute
		case inspectErr != nil:
			return inspectErr
		case !info.IsDir() || info.Mode()&os.ModeSymlink != 0:
			return fmt.Errorf("runtime path is not a directory")
		}
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("invalid runtime directory")
	}
	status, valid := info.Sys().(*syscall.Stat_t)
	if !valid || status.Uid != uint32(os.Geteuid()) {
		return fmt.Errorf("runtime directory has the wrong owner")
	}
	if created {
		return os.Chmod(absolute, 0o700)
	}
	if info.Mode().Perm() != 0o700 {
		return fmt.Errorf("runtime directory permissions must be 0700")
	}
	return nil
}

func workerSocketPath() (string, error) {
	runtimeDirectory := os.Getenv("LILAC_TOOL_WORKER_DIR")
	if runtimeDirectory == "" {
		runtimeDirectory = filepath.Join(os.TempDir(), fmt.Sprintf("lilac-tools-%d", os.Geteuid()))
	} else {
		runtimeDirectory = filepath.Join(runtimeDirectory, strconv.Itoa(os.Geteuid()))
	}
	if err := ensureDirectory(runtimeDirectory); err != nil {
		return "", err
	}
	absolute, err := filepath.Abs(runtimeDirectory)
	if err != nil {
		return "", err
	}
	path := filepath.Join(absolute, buildID+".sock")
	if len(path) > maxSocketPath {
		return "", fmt.Errorf("worker socket path is too long")
	}
	return path, nil
}

func workerExecutablePath() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(executable), workerName), nil
}

func doWorkerRequest(socketPath, method, path string, body []byte) (workerResponse, error) {
	connection, err := net.Dial("unix", socketPath)
	if err != nil {
		return workerResponse{}, err
	}
	defer connection.Close()
	request, err := http.NewRequest(method, "http://localhost"+path, bytes.NewReader(body))
	if err != nil {
		return workerResponse{}, err
	}
	request.Header.Set("content-type", "application/json")
	request.Close = true
	if err := request.Write(connection); err != nil {
		return workerResponse{}, err
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), request)
	if err != nil {
		return workerResponse{}, err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		return workerResponse{}, err
	}
	return workerResponse{status: response.StatusCode, header: response.Header, body: responseBody}, nil
}

func workerIsHealthy(socketPath string) bool {
	response, err := doWorkerRequest(socketPath, http.MethodGet, "/health", nil)
	if err != nil {
		return false
	}
	return response.status == http.StatusOK
}

func waitForWorker(socketPath string) bool {
	delay := time.Millisecond
	for attempt := 0; attempt < 10; attempt++ {
		if workerIsHealthy(socketPath) {
			return true
		}
		time.Sleep(delay)
		delay *= 2
	}
	return false
}

func startWorker(socketPath string) error {
	workerPath, err := workerExecutablePath()
	if err != nil {
		return err
	}
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer null.Close()
	command := exec.Command(workerPath, workerArg, socketPath)
	command.Stdin = null
	command.Stdout = null
	command.Stderr = null
	command.Env = environmentWithValue("LILAC_TOOL_WORKER_EXECUTABLE", workerPath)
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}

func environmentWithValue(name, value string) []string {
	prefix := name + "="
	environment := make([]string, 0, len(os.Environ())+1)
	for _, entry := range os.Environ() {
		if strings.HasPrefix(entry, prefix) {
			continue
		}
		environment = append(environment, entry)
	}
	return append(environment, prefix+value)
}

func openWorkerLock(socketPath string) (*os.File, error) {
	path := socketPath + ".lock"
	fd, err := syscall.Open(path, syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}

func ensureWorker(socketPath string) bool {
	if workerIsHealthy(socketPath) {
		return true
	}
	lock, err := openWorkerLock(socketPath)
	if err != nil {
		return false
	}
	defer lock.Close()
	for {
		err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX)
		if !errors.Is(err, syscall.EINTR) {
			break
		}
	}
	if err != nil {
		return false
	}
	if workerIsHealthy(socketPath) {
		return true
	}
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false
	}
	if startWorker(socketPath) != nil || !waitForWorker(socketPath) {
		return false
	}
	return true
}

func cleanupObsoleteWorkers(currentSocketPath string) {
	workerPath, err := workerExecutablePath()
	if err != nil {
		return
	}
	entries, err := os.ReadDir(filepath.Dir(currentSocketPath))
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".sock") {
			continue
		}
		path := filepath.Join(filepath.Dir(currentSocketPath), name)
		if path == currentSocketPath {
			continue
		}
		response, requestErr := doWorkerRequest(path, http.MethodGet, "/health", nil)
		if requestErr != nil || response.status != http.StatusOK {
			continue
		}
		var health workerHealth
		if json.Unmarshal(response.body, &health) != nil || health.BuildID == buildID ||
			health.Executable != workerPath {
			continue
		}
		_, _ = doWorkerRequest(path, http.MethodPost, "/shutdown", nil)
	}
}

func unavailable(errorValue error) bool {
	return errors.Is(errorValue, syscall.ENOENT) || errors.Is(errorValue, syscall.ECONNREFUSED)
}

func invokeWorker(socketPath string, payload []byte) (invokeStatus, invocationResponse) {
	response, err := doWorkerRequest(socketPath, http.MethodPost, "/invoke", payload)
	if err != nil {
		if unavailable(err) {
			return invokeUnavailable, invocationResponse{}
		}
		return invokeDefect, invocationResponse{}
	}
	if response.status != http.StatusOK {
		return invokeDefect, invocationResponse{}
	}
	exitCode, err := strconv.Atoi(response.header.Get("x-lilac-exit-code"))
	if err != nil || exitCode < 0 || exitCode > 255 {
		return invokeDefect, invocationResponse{}
	}
	stdoutBytes, err := strconv.Atoi(response.header.Get("x-lilac-stdout-bytes"))
	if err != nil || stdoutBytes < 0 || stdoutBytes > len(response.body) {
		return invokeDefect, invocationResponse{}
	}
	return invokeComplete, invocationResponse{
		exitCode: exitCode,
		stdout:   response.body[:stdoutBytes],
		stderr:   response.body[stdoutBytes:],
	}
}

func writeResponse(response invocationResponse) error {
	if _, err := os.Stdout.Write(response.stdout); err != nil {
		return err
	}
	_, err := os.Stderr.Write(response.stderr)
	return err
}

func interactiveOnboarding(args []string, stdinIsTTY bool) bool {
	if !stdinIsTTY {
		return false
	}
	command := ""
	hasHelp := false
	hasYes := false
	for _, argument := range args {
		if argument == "--operator" || argument == "--op" {
			continue
		}
		if command == "" {
			command = argument
		}
		hasHelp = hasHelp || argument == "--help"
		hasYes = hasYes || argument == "--yes" || argument == "-y" ||
			strings.HasPrefix(argument, "--yes=")
	}
	return command == "onboard" && !hasHelp && !hasYes
}

func runDirect(args []string) error {
	workerPath, err := workerExecutablePath()
	if err != nil {
		return err
	}
	directArgs := append([]string{workerPath, directArg}, args...)
	return syscall.Exec(workerPath, directArgs, os.Environ())
}

func runCapturedDirect(payload []byte) error {
	workerPath, err := workerExecutablePath()
	if err != nil {
		return err
	}
	input, err := os.CreateTemp("", "lilac-tools-stdin-*")
	if err != nil {
		return err
	}
	defer input.Close()
	defer os.Remove(input.Name())
	if _, err := input.Write(payload); err != nil {
		return err
	}
	if _, err := input.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err := os.Remove(input.Name()); err != nil {
		return err
	}
	if err := syscall.Dup2(int(input.Fd()), int(os.Stdin.Fd())); err != nil {
		return err
	}
	return syscall.Exec(workerPath, []string{workerPath, capturedArg}, os.Environ())
}

func startAndInvokeWorker(socketPath string, payload []byte) (int, error) {
	cleanupObsoleteWorkers(socketPath)
	if !ensureWorker(socketPath) {
		return 1, runCapturedDirect(payload)
	}
	status, response := invokeWorker(socketPath, payload)
	if status != invokeComplete {
		return 1, fmt.Errorf("resident worker retry failed")
	}
	return response.exitCode, writeResponse(response)
}

func run() (int, error) {
	args := os.Args[1:]
	stdinIsTTY := terminalState(os.Stdin)
	stdoutState := terminalState(os.Stdout)
	stdoutIsTTY := stdoutState != nil && *stdoutState
	if interactiveOnboarding(args, stdinIsTTY != nil && *stdinIsTTY) {
		return 1, runDirect(args)
	}
	payload, err := createRequest(args, stdinIsTTY, stdoutIsTTY)
	if err != nil {
		return 1, err
	}
	socketPath, err := workerSocketPath()
	if err != nil {
		return 1, err
	}
	status, response := invokeWorker(socketPath, payload)
	switch status {
	case invokeComplete:
		return response.exitCode, writeResponse(response)
	case invokeDefect:
		return 1, fmt.Errorf("resident worker request failed")
	case invokeUnavailable:
		return startAndInvokeWorker(socketPath, payload)
	}
	return 1, fmt.Errorf("resident worker returned unknown invocation status")
}

func main() {
	exitCode, err := run()
	if err != nil {
		fmt.Fprintln(os.Stderr, `{"status":"error","error":{"kind":"internal","code":"bridge_launcher_defect","message":"Internal tool launcher failure","retryable":false}}`)
		os.Exit(1)
	}
	os.Exit(exitCode)
}
