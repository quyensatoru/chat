package controller

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"chat/auth"
	"chat/model"
	"chat/socket"
	"chat/store"

	"github.com/coder/websocket"
)

// Mã đóng kết nối riêng (4000–4999 dành cho ứng dụng).
// Client gặp 4001 thì không kết nối lại mà quay về màn đăng nhập.
const closeUnauthorized websocket.StatusCode = 4001

const maxMessageRunes = 4000

// Yêu cầu client gửi lên. Mọi yêu cầu đều có "type".
//
//	message.send  {channel_id, content, client_id, parent_id?, embed?}   gửi tin (parent_id: trả lời trong luồng;
//	              embed: sticker/GIF, khi đó content để trống)
//	typing        {channel_id}                       đang gõ (client tự giới hạn tần suất)
//	read          {channel_id, message_id}           đã đọc tới tin message_id
//	ping          {}                                 kiểm tra kết nối, server trả "pong"
type clientRequest struct {
	Type      string       `json:"type"`
	ChannelID int64        `json:"channel_id"`
	MessageID int64        `json:"message_id"`
	Content   string       `json:"content"`
	ClientID  string       `json:"client_id"`
	ParentID  int64        `json:"parent_id"` // khác 0: trả lời trong luồng của tin này
	Embed     *model.Embed `json:"embed"`
	Cipher    string       `json:"cipher"`      // tin mã hoá đầu cuối (chỉ trong tin nhắn riêng)
	ReplyToID int64        `json:"reply_to_id"` // trả lời trích dẫn tin này
	Forwarded bool         `json:"forwarded"`
	// Gọi điện
	CallID string          `json:"call_id"`
	Video  bool            `json:"video"`
	Data   json.RawMessage `json:"data"` // SDP / ICE (máy chủ chuyển nguyên văn)
	To     string          `json:"to"`   // gọi nhóm: id kết nối nhận tín hiệu
}

// serveSocket: GET /ws?token=<token>
// Trình duyệt không cho đặt header Authorization khi mở websocket nên token đi qua query.
func (a *API) serveSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: a.originPatterns,
	})
	if err != nil {
		// Accept đã tự trả HTTP response lỗi, chỉ cần log.
		log.Printf("ws accept %s: %v", r.RemoteAddr, err)
		return
	}
	// Tin nhắn tối đa 4000 ký tự ~ 16KB UTF-8, cộng phần JSON.
	conn.SetReadLimit(maxCipherBytes + 8<<10) // tin mã hoá + phần JSON

	ctx := r.Context()

	// Xác thực sau khi Accept để gửi được mã đóng 4001 (client đọc được mã này,
	// còn HTTP 401 trước khi upgrade thì trình duyệt giấu mất).
	token := r.URL.Query().Get("token")
	user, err := a.userFromToken(ctx, token)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			log.Printf("ws auth: %v", err)
		}
		conn.Close(closeUnauthorized, "unauthorized")
		return
	}

	channelIDs, err := a.store.ChannelIDsForUser(ctx, user.ID)
	if err != nil {
		log.Printf("ws load channels: %v", err)
		conn.Close(websocket.StatusInternalError, "internal error")
		return
	}

	client := socket.NewClient(user.ID, auth.HashToken(token), conn)
	firstConn, ok := a.hub.Add(client, channelIDs)
	if !ok {
		conn.Close(websocket.StatusGoingAway, "server shutting down")
		return
	}

	writerDone := make(chan struct{})
	go func() {
		client.WritePump(ctx)
		close(writerDone)
	}()

	a.hub.ToClient(client, mustJSON(readyEvent{
		Type: "ready", User: user, OnlineUserIDs: a.hub.OnlineUserIDs(), UIBuild: a.uiBuild,
		GroupCalls: a.groups.statesFor(channelIDs), AI: a.aiInfo(),
	}))
	if firstConn {
		a.hub.ToAll(mustJSON(presenceEvent{Type: "presence", UserID: user.ID, Online: true}))
	}

	defer func() {
		a.calls.clientGone(a, client) // kết thúc cuộc gọi đang dùng kết nối này
		a.leaveGroup(0, client)
		a.spectatorClientGone(client)
		if lastConn := a.hub.Remove(client); lastConn {
			a.hub.ToAll(mustJSON(presenceEvent{Type: "presence", UserID: user.ID, Online: false}))
		}
		<-writerDone
		conn.Close(websocket.StatusNormalClosure, "")
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			if !isNormalClose(err) {
				log.Printf("ws read user=%d: %v", user.ID, err)
			}
			return
		}
		var req clientRequest
		if err := json.Unmarshal(data, &req); err != nil {
			a.hub.ToClient(client, mustJSON(errorEvent{Type: "error", Message: "Yêu cầu không phải JSON hợp lệ."}))
			continue
		}
		a.handleRequest(ctx, client, user, req)
	}
}

func (a *API) handleRequest(ctx context.Context, client *socket.Client, user model.User, req clientRequest) {
	reply := func(msg string) {
		a.hub.ToClient(client, mustJSON(errorEvent{Type: "error", Message: msg, ClientID: req.ClientID}))
	}

	switch req.Type {
	case "ping":
		a.hub.ToClient(client, []byte(`{"type":"pong"}`))

	case "message.send":
		content := strings.TrimSpace(req.Content)
		var embed *model.Embed
		cipher := ""
		if req.Cipher != "" {
			if msg := validateCipher(req.Cipher); msg != "" {
				reply(msg)
				return
			}
			cipher, content = req.Cipher, "" // nội dung thật nằm trong cipher
		} else if req.Embed != nil && req.Embed.Type == "share" {
			// thẻ chia sẻ: máy chủ tự dựng bản tóm tắt từ tin gốc (không tin dữ liệu client gửi)
			var msg string
			var err error
			if embed, msg, err = a.buildShareEmbed(ctx, user, req.Embed.ID); err != nil {
				log.Printf("ws share: %v", err)
				reply("Server gặp lỗi, thử gửi lại.")
				return
			} else if msg != "" {
				reply(msg)
				return
			}
			content = ""
		} else if req.Embed != nil {
			var msg string
			if embed, msg = validateEmbed(req.Embed); msg != "" {
				reply(msg)
				return
			}
			content = "" // sticker/GIF đi một mình
		} else if content == "" {
			reply("Tin nhắn đang trống.")
			return
		}
		if utf8.RuneCountInString(content) > maxMessageRunes {
			reply("Tin nhắn dài tối đa 4000 ký tự.")
			return
		}
		if len(req.ClientID) > 64 {
			req.ClientID = req.ClientID[:64]
		}
		// Kiểm tra lại trong DB: Hub có thể chưa kịp cập nhật nếu vừa bị xoá khỏi kênh.
		member, err := a.store.IsMember(ctx, req.ChannelID, user.ID)
		if err != nil {
			log.Printf("ws is member: %v", err)
			reply("Server gặp lỗi, thử gửi lại.")
			return
		}
		if !member {
			reply("Bạn chưa tham gia kênh này.")
			return
		}
		if cipher != "" {
			msg, err := a.cipherAllowed(ctx, req.ChannelID)
			if err != nil {
				log.Printf("ws cipher channel: %v", err)
				reply("Server gặp lỗi, thử gửi lại.")
				return
			}
			if msg != "" {
				reply(msg)
				return
			}
		}
		var parentID *int64
		if req.ParentID > 0 {
			msg, err := a.validateParent(ctx, req.ChannelID, req.ParentID)
			if err != nil {
				log.Printf("ws validate parent: %v", err)
				reply("Server gặp lỗi, thử gửi lại.")
				return
			}
			if msg != "" {
				reply(msg)
				return
			}
			parentID = &req.ParentID
		}
		var replyRaw string
		if req.ReplyToID > 0 {
			replyRaw = strconv.FormatInt(req.ReplyToID, 10)
		}
		replyTo, msg, err := a.validateReplyTo(ctx, req.ChannelID, replyRaw)
		if err != nil {
			log.Printf("ws validate reply: %v", err)
			reply("Server gặp lỗi, thử gửi lại.")
			return
		}
		if msg != "" {
			reply(msg)
			return
		}
		if _, err := a.createAndBroadcast(ctx, user, req.ChannelID, outgoing{
			Content: content, ClientID: req.ClientID, ParentID: parentID, Embed: embed, Cipher: cipher,
			ReplyToID: replyTo, Forwarded: req.Forwarded,
		}); err != nil {
			log.Printf("ws create message: %v", err)
			reply("Server gặp lỗi, thử gửi lại.")
			return
		}

	case "call.invite", "call.accept", "call.decline", "call.hangup", "call.signal":
		a.handleCall(ctx, client, user, req)

	case "groupcall.join", "groupcall.leave", "groupcall.signal":
		a.handleGroupCall(ctx, client, user, req)

	case "game.watch", "game.unwatch", "game.pos", "game.spectate", "game.unspectate":
		a.handleGameSocket(ctx, client, user, req)

	case "typing":
		if a.hub.IsSubscribed(client, req.ChannelID) {
			a.hub.ToChannel(req.ChannelID, mustJSON(typingEvent{
				Type: "typing", ChannelID: req.ChannelID, UserID: user.ID, ParentID: req.ParentID,
			}), client)
		}

	case "read":
		if req.MessageID > 0 && a.hub.IsSubscribed(client, req.ChannelID) {
			pos, moved, err := a.store.MarkRead(ctx, req.ChannelID, user.ID, req.MessageID)
			if err != nil {
				log.Printf("ws mark read: %v", err)
			} else if moved {
				a.hub.ToChannel(req.ChannelID, mustJSON(readUpdatedEvent{
					Type: "read.updated", ChannelID: req.ChannelID, UserID: user.ID, MessageID: pos,
				}), nil)
			}
		}

	default:
		reply("Không hiểu yêu cầu \"" + req.Type + "\".")
	}
}

func isNormalClose(err error) bool {
	switch websocket.CloseStatus(err) {
	case websocket.StatusNormalClosure, websocket.StatusGoingAway, websocket.StatusNoStatusRcvd, closeUnauthorized:
		return true
	}
	return errors.Is(err, net.ErrClosed) || errors.Is(err, io.EOF) || errors.Is(err, context.Canceled)
}
