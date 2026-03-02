package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for development
	},
}

var hub *Hub

// handleWebSocket handles incoming WebSocket connections.
func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	role := r.URL.Query().Get("role")
	id := r.URL.Query().Get("id")

	if role == "" {
		role = "receiver"
	}
	if id == "" {
		id = fmt.Sprintf("%s_%d", role, time.Now().UnixNano())
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[Server] WebSocket upgrade error: %v", err)
		return
	}

	log.Printf("[Server] New %s connection: %s (from %s)", role, id, r.RemoteAddr)

	client := NewClient(hub, conn, id, role)

	// Auto-register receivers immediately
	if role == "receiver" {
		hub.RegisterClient(client)
	}

	// Start read/write pumps
	go client.WritePump()
	go client.ReadPump()
}

// handleHealth returns server health status.
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	hub.mu.RLock()
	senderCount := len(hub.senders)
	receiverCount := len(hub.receivers)
	hub.mu.RUnlock()

	fmt.Fprintf(w, `{"status":"ok","senders":%d,"receivers":%d,"time":%d}`,
		senderCount, receiverCount, time.Now().UnixMilli())
}

// serveStaticFiles serves the browser client.
func serveStaticFiles(dir string) http.Handler {
	return http.FileServer(http.Dir(dir))
}

func main() {
	port := flag.Int("port", 8089, "Server port")
	browserDir := flag.String("browser", "../browser", "Path to browser client files")
	flag.Parse()

	hub = NewHub()

	// WebSocket endpoint
	http.HandleFunc("/ws", handleWebSocket)

	// Health check
	http.HandleFunc("/health", handleHealth)

	// Serve browser client static files
	http.Handle("/", serveStaticFiles(*browserDir))

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("============================================")
	log.Printf("  WebRTC Signaling Server")
	log.Printf("  Listening on %s", addr)
	log.Printf("  Browser client: http://localhost%s", addr)
	log.Printf("  WebSocket: ws://localhost%s/ws", addr)
	log.Printf("  Health: http://localhost%s/health", addr)
	log.Printf("============================================")

	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
