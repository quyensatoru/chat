package controller

import (
	"encoding/json"
	"log"

	"chat/model"
)

// Các sự kiện server gửi xuống qua websocket. Mọi sự kiện đều có trường "type".
//
//	ready            {user, online_user_ids}                 ngay sau khi kết nối thành công
//	message.new      {message, client_id?}                   tin mới trong một kênh mình tham gia
//	message.updated  {message}                               tin được sửa hoặc bị xoá (deleted_at)
//	key.updated      {user_id, public_key}                   ai đó tạo/đổi khoá mã hoá đầu cuối
//	poll.updated     {channel_id, message_id, poll}          số phiếu / trạng thái bình chọn thay đổi
//	game.updated     {channel_id, message_id, game}          ván chơi thay đổi (xem controller/games.go)
//	reminder.due     {reminder}                              tới giờ nhắc việc (chỉ gửi cho người đặt)
//	call.*           xem controller/calls.go                 gọi thoại / video
//	typing           {channel_id, user_id}                   ai đó đang gõ
//	presence         {user_id, online}                       ai đó vừa online/offline
//	user.updated     {user}                                  ai đó đổi hồ sơ
//	channel.joined   {channel}                               mình vừa tham gia/tạo kênh (từ máy khác)
//	channel.left     {channel_id}                            mình vừa rời kênh (từ máy khác)
//	channel.updated  {channel}                               kênh đổi tên/mô tả
//	channel.deleted  {channel_id}                            kênh bị xoá
//	member.joined    {channel_id, user}                      có người vào kênh
//	member.left      {channel_id, user_id}                   có người rời kênh
//	reaction.updated {channel_id, message_id, parent_id?, reactions}  cảm xúc của một tin thay đổi
//	thread.updated   {channel_id, message_id, thread}        luồng trả lời của tin gốc thay đổi
//	read.updated     {channel_id, user_id, message_id}       ai đó đã xem tới tin message_id
//	error            {message, client_id?}                   lỗi xử lý yêu cầu của chính kết nối này
//	pong             {}                                      trả lời "ping" của client

type readyEvent struct {
	Type          string     `json:"type"`
	User          model.User `json:"user"`
	OnlineUserIDs []int64    `json:"online_user_ids"`
	// Mã bản build giao diện web đang phục vụ: khác bản client đang chạy thì client nhắc tải lại.
	UIBuild string `json:"ui_build,omitempty"`
	// Các cuộc gọi nhóm đang diễn ra trong những kênh mình tham gia.
	GroupCalls []groupCallState `json:"group_calls"`
	// Trợ lý AI (nil: máy chủ tắt AI).
	AI *aiInfo `json:"ai,omitempty"`
}

type messageNewEvent struct {
	Type     string        `json:"type"`
	Message  model.Message `json:"message"`
	ClientID string        `json:"client_id,omitempty"`
}

type messageUpdatedEvent struct {
	Type    string        `json:"type"`
	Message model.Message `json:"message"`
}

type typingEvent struct {
	Type      string `json:"type"`
	ChannelID int64  `json:"channel_id"`
	UserID    int64  `json:"user_id"`
	ParentID  int64  `json:"parent_id,omitempty"`
}

type SpectatorInfo struct {
	UserID      int64   `json:"user_id"`
	Username    string  `json:"username"`
	DisplayName string  `json:"display_name"`
	Avatar      *string `json:"avatar"`
}

type gameSpectatorsEvent struct {
	Type       string          `json:"type"`
	MessageID  int64           `json:"message_id"`
	ChannelID  int64           `json:"channel_id"`
	Count      int             `json:"count"`
	Spectators []SpectatorInfo `json:"spectators"`
}

type presenceEvent struct {
	Type   string `json:"type"`
	UserID int64  `json:"user_id"`
	Online bool   `json:"online"`
}

type userEvent struct {
	Type string           `json:"type"`
	User model.PublicUser `json:"user"`
}

type channelEvent struct {
	Type    string        `json:"type"`
	Channel model.Channel `json:"channel"`
}

type channelIDEvent struct {
	Type      string `json:"type"`
	ChannelID int64  `json:"channel_id"`
}

type memberJoinedEvent struct {
	Type      string           `json:"type"`
	ChannelID int64            `json:"channel_id"`
	User      model.PublicUser `json:"user"`
}

type memberLeftEvent struct {
	Type      string `json:"type"`
	ChannelID int64  `json:"channel_id"`
	UserID    int64  `json:"user_id"`
}

// reaction.updated: danh sách cảm xúc mới của một tin (parent_id có nếu tin nằm trong luồng).
// read.updated: user_id đã xem tới tin message_id (gửi khi người đó mở/đọc kênh).
type readUpdatedEvent struct {
	Type      string `json:"type"`
	ChannelID int64  `json:"channel_id"`
	UserID    int64  `json:"user_id"`
	MessageID int64  `json:"message_id"`
}

type reactionUpdatedEvent struct {
	Type      string           `json:"type"`
	ChannelID int64            `json:"channel_id"`
	MessageID int64            `json:"message_id"`
	ParentID  *int64           `json:"parent_id,omitempty"`
	Reactions []model.Reaction `json:"reactions"`
}

// thread.updated: tóm tắt luồng mới của tin gốc message_id (sau khi có trả lời mới).
type threadUpdatedEvent struct {
	Type      string              `json:"type"`
	ChannelID int64               `json:"channel_id"`
	MessageID int64               `json:"message_id"`
	Thread    model.ThreadSummary `json:"thread"`
}

type errorEvent struct {
	Type     string `json:"type"`
	Message  string `json:"message"`
	ClientID string `json:"client_id,omitempty"`
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("marshal event: %v", err)
		return []byte(`{"type":"error","message":"internal"}`)
	}
	return b
}
