package controller_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"chat/auth"
	"chat/controller"
	"chat/database"
	"chat/socket"
	"chat/store"

	"github.com/coder/websocket"
)

func TestMain(m *testing.M) {
	auth.Iterations = 1000 // test không cần băm chậm
	os.Exit(m.Run())
}

type env struct {
	api *controller.API
	st  *store.Store
	t   *testing.T
	srv *httptest.Server
}

func newEnv(t *testing.T) *env {
	t.Helper()
	db, err := database.InitDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := database.Migrate(database.MigrationOpt{DB: db, Mode: database.ModeUp}); err != nil {
		t.Fatal(err)
	}
	hub := socket.NewHub()
	st := store.New(db)
	api := controller.NewAPI(st, hub, []string{"localhost", "localhost:*", "tauri.localhost"}, t.TempDir())
	srv := httptest.NewServer(api.Handler(nil))
	t.Cleanup(func() { hub.Shutdown(); srv.Close() })
	return &env{t: t, srv: srv, api: api, st: st}
}

// do gửi request và decode JSON vào out (nếu khác nil), trả về status code.
func (e *env) do(method, path, token string, body any, out any) int {
	e.t.Helper()
	var buf bytes.Buffer
	if body != nil {
		json.NewEncoder(&buf).Encode(body)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, &buf)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	if out != nil {
		json.NewDecoder(res.Body).Decode(out)
	}
	return res.StatusCode
}

type authResp struct {
	Token string `json:"token"`
	User  struct {
		ID          int64  `json:"id"`
		Username    string `json:"username"`
		DisplayName string `json:"display_name"`
	} `json:"user"`
	Error string `json:"error"`
}

func (e *env) register(username, display string) authResp {
	e.t.Helper()
	var r authResp
	code := e.do("POST", "/api/auth/register", "", map[string]string{
		"username": username, "email": username + "@example.com", "password": "matkhau123", "display_name": display,
	}, &r)
	if code != http.StatusCreated {
		e.t.Fatalf("register %s: %d %s", username, code, r.Error)
	}
	return r
}

type channel struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	MemberCount int    `json:"member_count"`
	UnreadCount int    `json:"unread_count"`
}

/* ---------- websocket client ---------- */

type wsClient struct {
	t    *testing.T
	conn *websocket.Conn
}

func (e *env) dial(token string) *wsClient {
	e.t.Helper()
	url := "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/ws?token=" + token
	conn, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { conn.CloseNow() })
	return &wsClient{t: e.t, conn: conn}
}

func (c *wsClient) send(v any) {
	b, _ := json.Marshal(v)
	if err := c.conn.Write(context.Background(), websocket.MessageText, b); err != nil {
		c.t.Fatal(err)
	}
}

// waitFor đọc sự kiện tới khi gặp type mong muốn, bỏ qua các sự kiện khác.
func (c *wsClient) waitFor(typ string) map[string]any {
	c.t.Helper()
	return c.waitForTimeout(typ, 3*time.Second)
}

// tryWait như waitFor nhưng hết giờ thì trả về false thay vì làm test thất bại.
func (c *wsClient) tryWait(typ string, d time.Duration) (map[string]any, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	for {
		_, b, err := c.conn.Read(ctx)
		if err != nil {
			return nil, false
		}
		var ev map[string]any
		json.Unmarshal(b, &ev)
		if ev["type"] == typ {
			return ev, true
		}
	}
}

func (c *wsClient) waitForTimeout(typ string, d time.Duration) map[string]any {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	for {
		_, b, err := c.conn.Read(ctx)
		if err != nil {
			c.t.Fatalf("waiting for %q: %v", typ, err)
		}
		var ev map[string]any
		json.Unmarshal(b, &ev)
		if ev["type"] == typ {
			return ev
		}
	}
}

/* ---------- tests ---------- */

func TestAuthAndProfile(t *testing.T) {
	e := newEnv(t)
	alice := e.register("alice", "Alice Nguyễn")

	var r authResp
	if code := e.do("POST", "/api/auth/register", "", map[string]string{"username": "alice", "email": "x@example.com", "password": "matkhau123"}, &r); code != 409 {
		t.Fatalf("duplicate username: got %d", code)
	}
	if code := e.do("POST", "/api/auth/register", "", map[string]string{"username": "A b", "email": "y@example.com", "password": "matkhau123"}, nil); code != 400 {
		t.Fatalf("bad username: got %d", code)
	}
	if code := e.do("POST", "/api/auth/register", "", map[string]string{"username": "carol", "email": "c@example.com", "password": "short"}, nil); code != 400 {
		t.Fatalf("short password: got %d", code)
	}

	if code := e.do("POST", "/api/auth/login", "", map[string]string{"login": "ALICE@example.com", "password": "matkhau123"}, &r); code != 200 || r.Token == "" {
		t.Fatalf("login by email: %d", code)
	}
	if code := e.do("POST", "/api/auth/login", "", map[string]string{"login": "alice", "password": "sai-mat-khau"}, nil); code != 401 {
		t.Fatalf("wrong password: got %d", code)
	}
	if code := e.do("GET", "/api/me", "", nil, nil); code != 401 {
		t.Fatalf("no token: got %d", code)
	}

	var me map[string]any
	status := "Đang họp"
	if code := e.do("PATCH", "/api/me", alice.Token, map[string]any{"display_name": "Alice N.", "status_text": status}, &me); code != 200 {
		t.Fatalf("update me: %d %v", code, me)
	}
	if me["display_name"] != "Alice N." || me["status_text"] != status {
		t.Fatalf("profile not updated: %v", me)
	}
	if code := e.do("PATCH", "/api/me", alice.Token, map[string]any{"avatar": "javascript:alert(1)"}, nil); code != 400 {
		t.Fatalf("bad avatar: got %d", code)
	}

	// Đổi mật khẩu: phiên hiện tại còn, phiên khác (r.Token) bị đăng xuất
	// và websocket đang mở của phiên khác bị đóng với mã 4001.
	other := e.dial(r.Token)
	other.waitFor("ready")
	mine := e.dial(alice.Token)
	mine.waitFor("ready")
	if code := e.do("PUT", "/api/me/password", alice.Token, map[string]string{"current_password": "matkhau123", "new_password": "matkhaumoi456"}, nil); code != 204 {
		t.Fatalf("change password: %d", code)
	}
	if code := e.do("GET", "/api/me", alice.Token, nil, nil); code != 200 {
		t.Fatalf("current session after password change: %d", code)
	}
	if code := e.do("GET", "/api/me", r.Token, nil, nil); code != 401 {
		t.Fatalf("other session after password change: %d", code)
	}
	if st := closeStatus(other); st != 4001 {
		t.Fatalf("other socket after password change: close status %d", st)
	}
	mine.send(map[string]any{"type": "ping"})
	mine.waitFor("pong") // phiên hiện tại vẫn sống

	if code := e.do("POST", "/api/auth/logout", alice.Token, nil, nil); code != 204 {
		t.Fatalf("logout: %d", code)
	}
	if code := e.do("GET", "/api/me", alice.Token, nil, nil); code != 401 {
		t.Fatalf("after logout: %d", code)
	}
	if st := closeStatus(mine); st != 4001 {
		t.Fatalf("socket after logout: close status %d", st)
	}
}

// closeStatus đọc tới khi kết nối bị đóng và trả về mã đóng.
func closeStatus(c *wsClient) websocket.StatusCode {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		if _, _, err := c.conn.Read(ctx); err != nil {
			return websocket.CloseStatus(err)
		}
	}
}

func TestChannelsAndRealtime(t *testing.T) {
	e := newEnv(t)
	alice := e.register("alice", "Alice")
	bob := e.register("bob", "Bob Trần")

	var ch channel
	if code := e.do("POST", "/api/channels", alice.Token, map[string]string{"name": "  Dự Án Mới ", "description": "Bàn việc"}, &ch); code != 201 {
		t.Fatalf("create channel: %d", code)
	}
	if ch.Name != "dự-án-mới" || ch.MemberCount != 1 {
		t.Fatalf("channel normalized wrong: %+v", ch)
	}
	if code := e.do("POST", "/api/channels", bob.Token, map[string]string{"name": "dự-án-mới"}, nil); code != 409 {
		t.Fatalf("duplicate channel: %d", code)
	}

	var discover []channel
	e.do("GET", "/api/channels/discover", bob.Token, nil, &discover)
	if len(discover) != 1 || discover[0].ID != ch.ID {
		t.Fatalf("discover: %+v", discover)
	}
	id := func(p string) string { return strings.Replace(p, "{id}", itoa(ch.ID), 1) }
	if code := e.do("GET", id("/api/channels/{id}/messages"), bob.Token, nil, nil); code != 403 {
		t.Fatalf("non-member history: %d", code)
	}

	// websocket: token sai bị đóng với mã 4001
	bad := e.dial("khong-hop-le")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	_, _, err := bad.conn.Read(ctx)
	cancel()
	if websocket.CloseStatus(err) != 4001 {
		t.Fatalf("bad token close status: %v", err)
	}

	wa := e.dial(alice.Token)
	wa.waitFor("ready")
	wb := e.dial(bob.Token)
	ready := wb.waitFor("ready")
	if len(ready["online_user_ids"].([]any)) != 2 {
		t.Fatalf("online users: %v", ready["online_user_ids"])
	}
	if p := wa.waitFor("presence"); p["online"] != true {
		t.Fatalf("presence: %v", p)
	}

	// bob tham gia: alice nhận member.joined, bob nhận channel.joined
	if code := e.do("POST", id("/api/channels/{id}/join"), bob.Token, nil, nil); code != 200 {
		t.Fatalf("join: %d", code)
	}
	if ev := wa.waitFor("member.joined"); ev["user"].(map[string]any)["display_name"] != "Bob Trần" {
		t.Fatalf("member.joined: %v", ev)
	}
	wb.waitFor("channel.joined")

	// alice gửi tin: cả hai nhận, alice nhận lại client_id
	wa.send(map[string]any{"type": "message.send", "channel_id": ch.ID, "content": "Xin chào 👋", "client_id": "c-1"})
	evA := wa.waitFor("message.new")
	evB := wb.waitFor("message.new")
	if evA["client_id"] != "c-1" {
		t.Fatalf("client_id not echoed: %v", evA)
	}
	msg := evB["message"].(map[string]any)
	if msg["content"] != "Xin chào 👋" || msg["user"].(map[string]any)["display_name"] != "Alice" {
		t.Fatalf("message.new: %v", evB)
	}

	// bob chưa đọc 1 tin; alice (người gửi) 0 tin
	unread := func(token string) int {
		var list []channel
		e.do("GET", "/api/channels", token, nil, &list)
		return list[0].UnreadCount
	}
	if n := unread(bob.Token); n != 1 {
		t.Fatalf("bob unread = %d, want 1", n)
	}
	if n := unread(alice.Token); n != 0 {
		t.Fatalf("alice unread = %d, want 0", n)
	}
	wb.send(map[string]any{"type": "read", "channel_id": ch.ID, "message_id": msg["id"]})
	wb.send(map[string]any{"type": "ping"})
	wb.waitFor("pong") // đảm bảo "read" đã xử lý xong
	if n := unread(bob.Token); n != 0 {
		t.Fatalf("bob unread after read = %d", n)
	}
	// alice thấy bob đã xem
	if ev := wa.waitFor("read.updated"); ev["user_id"].(float64) != float64(bob.User.ID) || ev["message_id"] != msg["id"] {
		t.Fatalf("read.updated: %v", ev)
	}
	// đọc lại (hoặc id vượt quá tin mới nhất) không phát thêm sự kiện; vị trí không vượt tin cuối
	wb.send(map[string]any{"type": "read", "channel_id": ch.ID, "message_id": 999999})
	wb.send(map[string]any{"type": "ping"})
	wb.waitFor("pong")

	// lịch sử + vị trí đã đọc của từng thành viên
	var hist struct {
		Messages []map[string]any `json:"messages"`
		HasMore  bool             `json:"has_more"`
		Reads    []struct {
			UserID    int64 `json:"user_id"`
			MessageID int64 `json:"message_id"`
		} `json:"reads"`
	}
	e.do("GET", id("/api/channels/{id}/messages"), bob.Token, nil, &hist)
	if len(hist.Messages) != 1 || hist.HasMore {
		t.Fatalf("history: %+v", hist)
	}
	if len(hist.Reads) != 2 {
		t.Fatalf("reads: %+v", hist.Reads)
	}
	for _, r := range hist.Reads {
		if r.MessageID != int64(msg["id"].(float64)) {
			t.Fatalf("read position of %d = %d, want %v", r.UserID, r.MessageID, msg["id"])
		}
	}

	// đang gõ
	wb.send(map[string]any{"type": "typing", "channel_id": ch.ID})
	if ev := wa.waitFor("typing"); ev["user_id"].(float64) != float64(bob.User.ID) {
		t.Fatalf("typing: %v", ev)
	}

	// đổi hồ sơ: người khác nhận user.updated
	e.do("PATCH", "/api/me", bob.Token, map[string]any{"display_name": "Bob T."}, nil)
	if ev := wa.waitFor("user.updated"); ev["user"].(map[string]any)["display_name"] != "Bob T." {
		t.Fatalf("user.updated: %v", ev)
	}

	// chỉ chủ kênh được sửa/xoá
	if code := e.do("PATCH", id("/api/channels/{id}"), bob.Token, map[string]string{"description": "x"}, nil); code != 403 {
		t.Fatalf("non-owner update: %d", code)
	}
	if code := e.do("PATCH", id("/api/channels/{id}"), alice.Token, map[string]string{"description": "Mô tả mới"}, nil); code != 200 {
		t.Fatalf("owner update: %d", code)
	}
	wb.waitFor("channel.updated")

	// bob rời kênh: alice nhận member.left, bob không gửi được nữa
	if code := e.do("POST", id("/api/channels/{id}/leave"), bob.Token, nil, nil); code != 204 {
		t.Fatalf("leave: %d", code)
	}
	wa.waitFor("member.left")
	wb.send(map[string]any{"type": "message.send", "channel_id": ch.ID, "content": "còn ai không", "client_id": "c-2"})
	if ev := wb.waitFor("error"); ev["client_id"] != "c-2" {
		t.Fatalf("send after leave: %v", ev)
	}

	// bob ngắt kết nối: alice nhận presence offline
	wb.conn.Close(websocket.StatusNormalClosure, "")
	if p := wa.waitFor("presence"); p["online"] != false {
		t.Fatalf("presence offline: %v", p)
	}

	// xoá kênh
	if code := e.do("DELETE", id("/api/channels/{id}"), alice.Token, nil, nil); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	wa.waitFor("channel.deleted")
}

func TestCORS(t *testing.T) {
	e := newEnv(t)
	for origin, want := range map[string]int{
		"tauri://localhost":      204,
		"http://tauri.localhost": 204,
		"http://localhost:1420":  204,
		"http://evil.com":        403,
	} {
		req, _ := http.NewRequest("OPTIONS", e.srv.URL+"/api/channels", nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("Access-Control-Request-Method", "GET")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != want {
			t.Errorf("%s: got %d want %d", origin, res.StatusCode, want)
		}
		if want == 204 && res.Header.Get("Access-Control-Allow-Origin") != origin {
			t.Errorf("%s: missing allow-origin header", origin)
		}
	}
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// Khi gắn giao diện web: "/" và đường dẫn lạ ra giao diện, /api lạ ra JSON 404, API vẫn chạy.
func TestWebUIRouting(t *testing.T) {
	db, err := database.InitDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := database.Migrate(database.MigrationOpt{DB: db, Mode: database.ModeUp}); err != nil {
		t.Fatal(err)
	}
	ui := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("UI")) })
	srv := httptest.NewServer(controller.NewAPI(store.New(db), socket.NewHub(), nil, t.TempDir()).Handler(ui))
	defer srv.Close()

	for _, tc := range []struct {
		method, path string
		code         int
		body         string
	}{
		{"GET", "/", 200, "UI"},
		{"GET", "/kenh/abc", 200, "UI"},
		{"GET", "/api/khong-co", 404, "Không có API này."},
		{"GET", "/api/health", 200, "ok"},
		{"GET", "/api/me", 401, "hết hạn"},
		{"POST", "/", 405, ""},
	} {
		req, _ := http.NewRequest(tc.method, srv.URL+tc.path, nil)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var buf bytes.Buffer
		buf.ReadFrom(res.Body)
		res.Body.Close()
		if res.StatusCode != tc.code || !strings.Contains(buf.String(), tc.body) {
			t.Errorf("%s %s: got %d %q, want %d containing %q", tc.method, tc.path, res.StatusCode, buf.String(), tc.code, tc.body)
		}
	}
}

func TestLoginRateLimit(t *testing.T) {
	e := newEnv(t)
	e.register("alice", "Alice")
	for i := 0; i < 10; i++ {
		if code := e.do("POST", "/api/auth/login", "", map[string]string{"login": "alice", "password": "sai"}, nil); code != 401 {
			t.Fatalf("attempt %d: %d", i, code)
		}
	}
	// lần thứ 11 bị chặn, kể cả khi đúng mật khẩu
	if code := e.do("POST", "/api/auth/login", "", map[string]string{"login": "ALICE", "password": "matkhau123"}, nil); code != 429 {
		t.Fatalf("after 10 fails: %d, want 429", code)
	}
	// tài khoản khác không bị ảnh hưởng
	e.register("bob", "Bob")
	if code := e.do("POST", "/api/auth/login", "", map[string]string{"login": "bob", "password": "matkhau123"}, nil); code != 200 {
		t.Fatalf("other account: %d", code)
	}
}
