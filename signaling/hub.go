package main

import (
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"
)

// mDNS UUID pattern: Chrome hides real IPs behind UUIDs like
// "a0defc08-459e-4a10-8444-..." for privacy. On machines without
// avahi/nss-mdns, GStreamer's libnice cannot resolve these,
// causing ICE to fail even on localhost.
var mdnsPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.local)?$`)

// Message represents a signaling message.
type Message struct {
	Type          string      `json:"type"`
	SenderID      string      `json:"sender_id,omitempty"`
	StreamID      string      `json:"stream_id,omitempty"`
	SDP           string      `json:"sdp,omitempty"`
	Candidate     string      `json:"candidate,omitempty"`
	SDPMLineIndex int         `json:"sdpMLineIndex,omitempty"`
	Role          string      `json:"role,omitempty"`
	ID            interface{} `json:"id,omitempty"`
	Streams       []string    `json:"streams,omitempty"`

	// ICE server configuration (STUN/TURN) - sent from sender to receivers
	IceServers json.RawMessage `json:"ice_servers,omitempty"`

	// Clock sync fields
	T1 float64 `json:"t1,omitempty"`
	T2 float64 `json:"t2,omitempty"`
	T3 float64 `json:"t3,omitempty"`
	T4 float64 `json:"t4,omitempty"`

	// Generic fields
	Message string          `json:"message,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// GetIDString returns the ID field as a string regardless of JSON type.
func (m *Message) GetIDString() string {
	switch v := m.ID.(type) {
	case string:
		return v
	case float64:
		return fmt.Sprintf("%d", int(v))
	default:
		return fmt.Sprintf("%v", v)
	}
}

// Hub manages all WebSocket clients and message routing.
type Hub struct {
	mu        sync.RWMutex
	senders   map[string]*Client // sender_id -> Client
	receivers map[string]*Client // receiver_id -> Client

	// Clock state for each connected client
	clockOffsets map[string]float64
}

// NewHub creates a new Hub.
func NewHub() *Hub {
	return &Hub{
		senders:      make(map[string]*Client),
		receivers:    make(map[string]*Client),
		clockOffsets: make(map[string]float64),
	}
}

// RegisterClient registers a new client with the hub.
func (h *Hub) RegisterClient(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if client.Role == "sender" {
		h.senders[client.ID] = client
		log.Printf("[Hub] Sender registered: %s", client.ID)

		// Notify all receivers that a sender joined (include ICE servers)
		for _, recv := range h.receivers {
			msg := Message{
				Type:       "sender_joined",
				SenderID:   client.ID,
				Streams:    client.Streams,
				IceServers: client.IceServers,
			}
			data, _ := json.Marshal(msg)
			recv.Send(data)
		}
	} else {
		h.receivers[client.ID] = client
		log.Printf("[Hub] Receiver registered: %s", client.ID)

		// Notify all senders that a receiver joined
		for _, sender := range h.senders {
			msg := Message{
				Type: "receiver_joined",
				ID:   client.ID,
			}
			data, _ := json.Marshal(msg)
			sender.Send(data)
		}

		// Send existing sender info to the new receiver (include ICE servers)
		for senderID, sender := range h.senders {
			msg := Message{
				Type:       "sender_joined",
				SenderID:   senderID,
				Streams:    sender.Streams,
				IceServers: sender.IceServers,
			}
			data, _ := json.Marshal(msg)
			client.Send(data)
		}
	}
}

// UnregisterClient removes a client from the hub.
func (h *Hub) UnregisterClient(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if client.Role == "sender" {
		delete(h.senders, client.ID)
		log.Printf("[Hub] Sender disconnected: %s", client.ID)

		// Notify receivers
		for _, recv := range h.receivers {
			msg := Message{
				Type:     "sender_left",
				SenderID: client.ID,
			}
			data, _ := json.Marshal(msg)
			recv.Send(data)
		}
	} else {
		delete(h.receivers, client.ID)
		log.Printf("[Hub] Receiver disconnected: %s", client.ID)

		// Notify all senders that this receiver left
		for _, sender := range h.senders {
			msg := Message{
				Type: "receiver_left",
				ID:   client.ID,
			}
			data, _ := json.Marshal(msg)
			sender.Send(data)
		}
	}
}

// RouteMessage routes a signaling message to the appropriate target.
func (h *Hub) RouteMessage(from *Client, rawMsg []byte) {
	var msg Message
	if err := json.Unmarshal(rawMsg, &msg); err != nil {
		log.Printf("[Hub] Invalid message from %s: %v", from.ID, err)
		return
	}

	switch msg.Type {
	case "register":
		from.Streams = msg.Streams
		if msg.IceServers != nil {
			from.IceServers = msg.IceServers
		}
		h.RegisterClient(from)

	case "offer":
		// Sender → all receivers
		h.routeToReceivers(rawMsg)

	case "answer":
		// Receiver → specific sender
		h.routeToSender(msg.SenderID, rawMsg)

	case "ice_candidate":
		if from.Role == "sender" {
			h.routeToReceivers(rawMsg)
		} else {
			// Replace mDNS addresses in browser ICE candidates with real IP.
			// Chrome hides local IPs behind mDNS UUIDs for privacy.
			// GStreamer's libnice can't resolve mDNS without avahi-daemon,
			// causing ICE to fail even on localhost.
			replaced := h.replaceMdnsCandidate(from, rawMsg)
			h.routeToSender(msg.SenderID, replaced)
		}

	case "clock_sync_request":
		h.handleClockSyncRequest(from, msg)

	case "clock_sync_browser":
		h.handleClockSyncBrowser(from, msg)

	default:
		log.Printf("[Hub] Unknown message type from %s: %s", from.ID, msg.Type)
	}
}

// handleClockSyncRequest handles NTP-style clock sync from sender.
func (h *Hub) handleClockSyncRequest(from *Client, msg Message) {
	now := float64(time.Now().UnixMilli())

	response := Message{
		Type: "clock_sync_response",
		T1:   msg.T1, // sender's send time
		T2:   now,    // server receive time
		T3:   now,    // server send time (immediate response)
	}

	data, _ := json.Marshal(response)
	from.Send(data)
}

// handleClockSyncBrowser handles clock sync requests from browser.
func (h *Hub) handleClockSyncBrowser(from *Client, msg Message) {
	now := float64(time.Now().UnixMilli())

	response := Message{
		Type: "clock_sync_browser_response",
		T1:   msg.T1, // browser's send time
		T2:   now,    // server receive time
		T3:   now,    // server send time
	}

	data, _ := json.Marshal(response)
	from.Send(data)
}

// routeToReceivers sends a message to all receivers.
func (h *Hub) routeToReceivers(rawMsg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, recv := range h.receivers {
		recv.Send(rawMsg)
	}
}

// routeToSender sends a message to a specific sender.
func (h *Hub) routeToSender(senderID string, rawMsg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if sender, ok := h.senders[senderID]; ok {
		sender.Send(rawMsg)
	} else {
		log.Printf("[Hub] Sender not found: %s", senderID)
	}
}

// replaceMdnsCandidate checks if an ICE candidate message contains an mDNS
// address and replaces it with the client's real IP from the WebSocket connection.
//
// Chrome hides local IPs behind mDNS UUIDs (e.g. "a0defc08-459e-4a10-8444-...")
// for privacy. GStreamer's libnice cannot resolve mDNS without avahi-daemon,
// so ICE fails even on localhost. The signaling server knows the real IP from
// the WebSocket TCP connection, so it can perform the replacement transparently.
//
// ICE candidate format:
//
//	candidate:<foundation> <component> <protocol> <priority> <ADDRESS> <port> typ <type> ...
//	Field index:                                               4         5
func (h *Hub) replaceMdnsCandidate(from *Client, rawMsg []byte) []byte {
	if from.RemoteIP == "" {
		return rawMsg
	}

	var msg Message
	if err := json.Unmarshal(rawMsg, &msg); err != nil {
		return rawMsg
	}

	if msg.Candidate == "" {
		return rawMsg
	}

	// Parse the candidate string into space-separated fields
	fields := strings.Fields(msg.Candidate)
	if len(fields) < 6 {
		return rawMsg
	}

	address := fields[4]

	// Check if the address is an mDNS UUID
	if !mdnsPattern.MatchString(address) {
		return rawMsg
	}

	// Replace mDNS address with real IP
	realIP := from.RemoteIP

	// For IPv6 loopback (::1), use 127.0.0.1 instead since the
	// sender may not have IPv6 candidate pairs to match.
	if realIP == "::1" || realIP == "[::1]" {
		realIP = "127.0.0.1"
	}

	fields[4] = realIP
	msg.Candidate = strings.Join(fields, " ")

	log.Printf("[Hub] mDNS replacement for %s: %s → %s (in candidate field)",
		from.ID, address, realIP)

	replaced, err := json.Marshal(msg)
	if err != nil {
		return rawMsg
	}
	return replaced
}
