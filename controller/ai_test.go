package controller_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"chat/ai"
	"chat/model"
)

// fakeAI: dịch vụ chat dạng OpenAI + dịch vụ ảnh kiểu Pollinations, ghi lại yêu cầu nhận được.
type fakeAI struct {
	mu         sync.Mutex
	systems    []string
	asks       []string
	imagePro   []string
	edits      []string
	plans      int
	described  int
	toolRounds int
	toolNames  []string
	compacts   []string
	srv        *httptest.Server
}

// toolsFor: model giả gọi công cụ nào cho câu hỏi này ({tên, tham số JSON}).
func (f *fakeAI) toolsFor(ask string) [][2]string {
	switch {
	case strings.Contains(ask, "tóm tắt"):
		return [][2]string{{"read_messages", `{"hours":24}`}, {"look_at_images", `{}`}}
	case strings.Contains(ask, "là ai"):
		return [][2]string{{"list_members", `{"query":"nguyen"}`}}
	case strings.Contains(ask, "ai nói"):
		return [][2]string{{"search_messages", `{"query":"phở","from_user":"bob"}`}}
	case strings.Contains(ask, "nhắc"):
		at := time.Now().Add(26 * time.Hour).Format("2006-01-02 15:04")
		return [][2]string{{"set_reminder", `{"at":"` + at + `","note":"gửi báo cáo"}`}}
	case strings.Contains(ask, "bình chọn"):
		return [][2]string{{"create_poll", `{"question":"Trưa ăn gì?","options":["Phở","Bún chả"]}`}}
	case strings.Contains(ask, "minh hoạ"):
		return [][2]string{{"draw_image", `{"prompt":"a cat astronaut, watercolor","orientation":"portrait"}`}}
	case strings.Contains(ask, "phân tích"):
		return [][2]string{{"analyze_player_game", `{"player":"alice","game":"xiangqi"}`}}
	case strings.Contains(ask, "chơi"):
		return [][2]string{{"start_game", `{"game":"werewolf"}`}}
	case strings.Contains(ask, "ghim"):
		id := ask[strings.LastIndex(ask, "#")+1:]
		return [][2]string{{"pin_message", `{"message_id":` + id + `}`}}
	case strings.Contains(ask, "luồng"):
		id := ask[strings.LastIndex(ask, "#")+1:]
		return [][2]string{{"read_thread", `{"message_id":"#` + id + `"}`}, {"no_such_tool", `{}`}}
	}
	return nil
}

func newFakeAI(t *testing.T) *fakeAI {
	f := &fakeAI{}
	img := image.NewRGBA(image.Rect(0, 0, 64, 40))
	img.Set(1, 1, color.RGBA{0, 0, 255, 255})
	var pngBuf bytes.Buffer
	png.Encode(&pngBuf, img)
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/images/edits" {
			var body struct {
				Prompt string `json:"prompt"`
				Image  []struct {
					URL string `json:"image_url"`
				} `json:"image"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			f.mu.Lock()
			for _, im := range body.Image {
				f.edits = append(f.edits, body.Prompt+" | "+im.URL[:min(len(im.URL), 30)])
			}
			f.mu.Unlock()
			fmt.Fprintf(w, `{"data":[{"b64_json":%q}]}`, base64.StdEncoding.EncodeToString(pngBuf.Bytes()))
			return
		}
		if strings.HasPrefix(r.URL.Path, "/prompt/") {
			f.mu.Lock()
			f.imagePro = append(f.imagePro, strings.TrimPrefix(r.URL.Path, "/prompt/")+"?"+r.URL.RawQuery)
			f.mu.Unlock()
			w.Write(pngBuf.Bytes())
			return
		}
		var req struct {
			Messages []ai.Message     `json:"messages"`
			Tools    []map[string]any `json:"tools"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		sys, ask := req.Messages[0].Content, req.Messages[len(req.Messages)-1].Content
		// agent: ask là tin user cuối; ngữ cảnh gồm cả kết quả công cụ
		var all []string
		for _, m := range req.Messages {
			if m.Role == "user" {
				ask = m.Content
			}
			all = append(all, m.Content)
		}
		last := req.Messages[len(req.Messages)-1]
		stream := func(parts ...string) {
			w.Header().Set("Content-Type", "text/event-stream")
			for _, s := range parts {
				b, _ := json.Marshal(map[string]any{"model": "fake-1", "choices": []any{map[string]any{"delta": map[string]string{"content": s}}}})
				fmt.Fprintf(w, "data: %s\n\n", b)
			}
			fmt.Fprint(w, "data: [DONE]\n\n")
		}
		if strings.Contains(sys, "You decide what context") { // bước lập kế hoạch
			f.mu.Lock()
			f.plans++
			f.mu.Unlock()
			if strings.Contains(ask, "tóm tắt") {
				stream(`{"history_hours": 24, "search_chat": "", "web_search": "", "look_at_images": true}`)
			} else {
				stream(`{"history_hours": 0, "search_chat": "", "web_search": "", "look_at_images": false}`)
			}
			return
		}
		if strings.Contains(sys, "trí nhớ dài hạn") { // gộp tin cũ vào trí nhớ của kênh
			f.mu.Lock()
			f.compacts = append(f.compacts, ask)
			f.mu.Unlock()
			stream("**Đã chốt**: ", fmt.Sprintf("đi ăn lẩu (lần gộp %d)", len(f.compacts)))
			return
		}
		if strings.HasPrefix(sys, "Mô tả bức ảnh") { // model đọc ảnh (chỉ có 1 tin user kèm ảnh)
			f.mu.Lock()
			f.described++
			f.mu.Unlock()
			stream("Một hình chữ nhật đỏ nhỏ trên nền trong suốt")
			return
		}
		// có công cụ và chưa gọi lần nào: gọi công cụ theo từ khoá trong câu hỏi
		if len(req.Tools) > 0 && last.Role == "user" {
			if calls := f.toolsFor(ask); len(calls) > 0 {
				f.mu.Lock()
				f.toolRounds++
				for _, c := range calls {
					f.toolNames = append(f.toolNames, c[0])
				}
				f.mu.Unlock()
				w.Header().Set("Content-Type", "text/event-stream")
				for i, c := range calls {
					b, _ := json.Marshal(map[string]any{"model": "fake-1", "choices": []any{map[string]any{"delta": map[string]any{
						"tool_calls": []any{map[string]any{"index": i, "id": fmt.Sprint("call", i), "type": "function",
							"function": map[string]string{"name": c[0], "arguments": c[1]}}}}}}})
					fmt.Fprintf(w, "data: %s\n\n", b)
				}
				fmt.Fprint(w, "data: [DONE]\n\n")
				return
			}
		}
		f.mu.Lock()
		f.systems = append(f.systems, strings.Join(all, "\n"))
		f.asks = append(f.asks, ask)
		f.mu.Unlock()
		reply := []string{"Tóm tắt: ", "mọi người ", "đang bàn ", "chuyện **phở**."}
		if last.Role == "tool" && !strings.Contains(ask, "tóm tắt") {
			reply = []string{"Kết quả: " + last.Content}
		}
		if strings.Contains(sys, "text-to-image") {
			reply = []string{"a cute cat astronaut, watercolor"}
		}
		if strings.Contains(sys, "image-editing") {
			reply = []string{"redraw as a chibi character, keep the face"}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, s := range reply {
			b, _ := json.Marshal(map[string]any{"model": "fake-1", "choices": []any{map[string]any{"delta": map[string]string{"content": s}}}})
			fmt.Fprintf(w, "data: %s\n\n", b)
			w.(http.Flusher).Flush()
			time.Sleep(150 * time.Millisecond)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(f.srv.Close)
	return f
}

type wsMsg struct {
	ID          int64  `json:"id"`
	UserID      int64  `json:"user_id"`
	Content     string `json:"content"`
	ReplyToID   *int64 `json:"reply_to_id"`
	Attachments []struct {
		Width       int    `json:"width"`
		ContentType string `json:"content_type"`
		FileName    string `json:"file_name"`
	} `json:"attachments"`
}

// nextMsg: đợi sự kiện typ có message thoả cond.
func nextMsg(t *testing.T, c *wsClient, typ string, cond func(wsMsg) bool) wsMsg {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		ev := c.waitForTimeout(typ, 8*time.Second)
		b, _ := json.Marshal(ev["message"])
		var m wsMsg
		json.Unmarshal(b, &m)
		if cond(m) {
			return m
		}
	}
	t.Fatalf("no %s matching", typ)
	return wsMsg{}
}

func TestAIAssistant(t *testing.T) {
	e := newEnv(t)
	f := newFakeAI(t)
	chat := ai.NewChat(&ai.Provider{Name: "fake", BaseURL: f.srv.URL, Model: "fake-1", Vision: true})
	images := &ai.Images{Providers: []ai.ImageProvider{ai.PollinationsImage{BaseURL: f.srv.URL}}}
	if err := e.api.SetAI(context.Background(), chat, images, nil); err != nil {
		t.Fatal(err)
	}
	// gọi lại không tạo bot thứ hai
	if err := e.api.SetAI(context.Background(), chat, images, nil); err != nil {
		t.Fatal(err)
	}

	alice := e.register("alice", "Alice")
	bob := e.register("bob", "Bob")
	var ch channel
	e.do("POST", "/api/channels", alice.Token, map[string]any{"name": "an-trua"}, &ch)
	e.do("POST", "/api/channels/"+itoa(ch.ID)+"/join", bob.Token, nil, nil)

	wa := e.dial(alice.Token)
	ready := wa.waitFor("ready")
	info, _ := ready["ai"].(map[string]any)
	if info == nil || info["chat"] != true || info["image"] != true {
		t.Fatalf("ready without ai info: %v", ready["ai"])
	}
	botID := int64(info["bot_id"].(float64))
	wb := e.dial(bob.Token)
	wb.waitFor("ready")

	wb.send(map[string]any{"type": "message.send", "channel_id": ch.ID, "content": "Trưa nay ăn phở Thìn nhé", "client_id": "b1"})
	nextMsg(t, wa, "message.new", func(m wsMsg) bool { return m.UserID == bob.User.ID })

	// hỏi: bot trả lời ngay trong kênh, trích tin hỏi, chữ hiện dần rồi chốt kèm tên model
	wa.send(map[string]any{"type": "message.send", "channel_id": ch.ID, "content": "@ai tóm tắt giúp mình", "client_id": "a1"})
	q := nextMsg(t, wb, "message.new", func(m wsMsg) bool { return m.UserID == alice.User.ID })
	bot := nextMsg(t, wb, "message.new", func(m wsMsg) bool { return m.UserID == botID })
	if bot.Content != "…" || bot.ReplyToID == nil || *bot.ReplyToID != q.ID {
		t.Fatalf("bot placeholder: %+v", bot)
	}
	final := nextMsg(t, wb, "message.updated", func(m wsMsg) bool { return m.ID == bot.ID && strings.Contains(m.Content, "fake-1") })
	if !strings.HasPrefix(final.Content, "Tóm tắt: mọi người đang bàn chuyện **phở**.") {
		t.Fatalf("final content: %q", final.Content)
	}
	f.mu.Lock()
	sys, ask := f.systems[len(f.systems)-1], f.asks[len(f.asks)-1]
	plans := f.plans
	f.mu.Unlock()
	if !strings.Contains(sys, "Bob: Trưa nay ăn phở Thìn nhé") || !strings.Contains(sys, "#an-trua") || !strings.Contains(sys, "từ ") {
		t.Fatalf("context missing history: %s", sys)
	}
	if ask != "Alice hỏi: tóm tắt giúp mình" || plans != 0 {
		t.Fatalf("ask = %q, plans = %d (agent reads history itself, no planning step)", ask, plans)
	}
	if !strings.Contains(final.Content, "đọc ") {
		t.Fatalf("footer should say what was read: %q", final.Content)
	}

	// vẽ: nhờ AI viết lại mô tả tiếng Anh, ảnh gắn vào tin của bot
	wa.send(map[string]any{"type": "message.send", "channel_id": ch.ID, "content": "@ai vẽ chú mèo phi hành gia --ngang", "client_id": "a2"})
	draw := nextMsg(t, wb, "message.new", func(m wsMsg) bool { return m.UserID == botID && strings.HasPrefix(m.Content, "🎨 Đang vẽ") })
	if !strings.Contains(draw.Content, "chú mèo phi hành gia") || strings.Contains(draw.Content, "--ngang") {
		t.Fatalf("draw placeholder: %q", draw.Content)
	}
	done := nextMsg(t, wb, "message.updated", func(m wsMsg) bool { return m.ID == draw.ID && len(m.Attachments) == 1 })
	if done.Attachments[0].Width != 64 || done.Attachments[0].ContentType != "image/png" || !strings.HasPrefix(done.Attachments[0].FileName, "ai-chu-meo") {
		t.Fatalf("attachment: %+v", done.Attachments)
	}
	f.mu.Lock()
	imgReq := f.imagePro[0]
	f.mu.Unlock()
	if !strings.Contains(imgReq, "cute cat astronaut") || !strings.Contains(imgReq, "width=1216") {
		t.Fatalf("image request: %s", imgReq)
	}

	// tin không nhắc @ai, @aixyz, tin nhắn riêng: bot im lặng
	var dm struct{ ID int64 }
	e.do("POST", "/api/dms", alice.Token, map[string]any{"user_id": bob.User.ID}, &dm)
	wa.send(map[string]any{"type": "message.send", "channel_id": dm.ID, "content": "@ai chào", "client_id": "a3"})
	wa.send(map[string]any{"type": "message.send", "channel_id": ch.ID, "content": "email me@ai.vn hoặc @aixyz", "client_id": "a4"})
	time.Sleep(700 * time.Millisecond)
	f.mu.Lock()
	n := len(f.asks)
	f.mu.Unlock()
	if n != 2 { // câu trả lời + 1 lần viết lại mô tả ảnh (lượt gọi công cụ đếm riêng)
		t.Fatalf("unexpected AI calls: %d", n)
	}
}

func TestAIRedrawFromImage(t *testing.T) {
	e := newEnv(t)
	f := newFakeAI(t)
	chat := ai.NewChat(&ai.Provider{Name: "fake", BaseURL: f.srv.URL, Model: "fake-1", Vision: true})
	editor := ai.PollinationsEditor{PollinationsImage: ai.PollinationsImage{Key: "k", BaseURL: f.srv.URL}, GenURL: f.srv.URL}
	if err := e.api.SetAI(context.Background(), chat, &ai.Images{Providers: []ai.ImageProvider{editor}}, nil); err != nil {
		t.Fatal(err)
	}
	alice := e.register("alice", "Alice")
	var ch channel
	e.do("POST", "/api/channels", alice.Token, map[string]any{"name": "ve"}, &ch)
	wa := e.dial(alice.Token)
	info := wa.waitFor("ready")["ai"].(map[string]any)
	botID := int64(info["bot_id"].(float64))
	src := pngBytes(30, 20)

	// 1. ảnh gửi kèm tin "@ai biến …"
	code, msg := e.upload(ch.ID, alice.Token, "@ai biến nhân vật này thành chibi", "u1", upFile{"nhan-vat.png", src})
	if code != 201 {
		t.Fatalf("upload: %d %v", code, msg)
	}
	draw := nextMsg(t, wa, "message.new", func(m wsMsg) bool { return m.UserID == botID })
	if !strings.Contains(draw.Content, "vẽ lại từ ảnh gốc") {
		t.Fatalf("placeholder: %q", draw.Content)
	}
	done := nextMsg(t, wa, "message.updated", func(m wsMsg) bool { return m.ID == draw.ID && len(m.Attachments) == 1 })
	if !strings.Contains(done.Content, "vẽ lại từ ảnh gốc bởi pollinations") {
		t.Fatalf("final: %q", done.Content)
	}

	// 2. trả lời trích dẫn tin có ảnh rồi "@ai vẽ …"
	srcID := int64(msg["id"].(float64))
	wa.send(map[string]any{"type": "message.send", "channel_id": ch.ID, "content": "@ai vẽ lại kiểu anime", "client_id": "a2", "reply_to_id": srcID})
	draw2 := nextMsg(t, wa, "message.new", func(m wsMsg) bool { return m.UserID == botID && m.ID != draw.ID })
	nextMsg(t, wa, "message.updated", func(m wsMsg) bool { return m.ID == draw2.ID && len(m.Attachments) == 1 })

	f.mu.Lock()
	edits := append([]string(nil), f.edits...)
	f.mu.Unlock()
	if len(edits) != 2 || !strings.HasPrefix(edits[0], "redraw as a chibi character, keep the face | data:image/png;base64,") {
		t.Fatalf("edit requests: %v", edits)
	}

	// 3. có ảnh nhưng chỉ hỏi (không nhờ sửa): trả lời bằng chữ, báo là không xem được ảnh
	e.upload(ch.ID, alice.Token, "@ai đây là ai?", "u3", upFile{"x.png", src})
	nextMsg(t, wa, "message.updated", func(m wsMsg) bool { return m.UserID == botID && strings.Contains(m.Content, "fake-1") })
	f.mu.Lock()
	lastAsk := f.asks[len(f.asks)-1]
	f.mu.Unlock()
	if !strings.Contains(lastAsk, "Ảnh x.png: Một hình chữ nhật đỏ nhỏ") {
		t.Fatalf("ask with image: %q", lastAsk)
	}
}

// Tóm tắt "1 ngày" phải đọc hết tin trong ngày (không chỉ vài chục tin gần nhất), kể cả trả lời
// trong luồng, ảnh được mô tả một lần rồi dùng lại.
func TestAISummaryReadsWholeRange(t *testing.T) {
	e := newEnv(t)
	f := newFakeAI(t)
	chat := ai.NewChat(&ai.Provider{Name: "fake", BaseURL: f.srv.URL, Model: "fake-1", Vision: true})
	if err := e.api.SetAI(context.Background(), chat, nil, nil); err != nil {
		t.Fatal(err)
	}
	alice := e.register("alice", "Alice")
	var ch channel
	e.do("POST", "/api/channels", alice.Token, map[string]any{"name": "team-h"}, &ch)
	wa := e.dial(alice.Token)
	botID := int64(wa.waitFor("ready")["ai"].(map[string]any)["bot_id"].(float64))
	for i := 1; i <= 80; i++ {
		wa.send(map[string]any{"type": "message.send", "channel_id": ch.ID, "content": fmt.Sprintf("tin số %d", i), "client_id": fmt.Sprint("m", i)})
	}
	// tin qua websocket lưu bất đồng bộ: đợi tin cuối rồi mới gửi ảnh, để ảnh mới hơn mọi tin chữ
	nextMsg(t, wa, "message.new", func(m wsMsg) bool { return m.Content == "tin số 80" })
	code, img := e.upload(ch.ID, alice.Token, "ảnh team building", "img", upFile{"team.png", pngBytes(8, 8)})
	if code != 201 {
		t.Fatal(code)
	}
	wa.send(map[string]any{"type": "message.send", "channel_id": ch.ID, "content": "trả lời trong luồng nè", "client_id": "th", "parent_id": int64(img["id"].(float64))})
	// đợi tin cuối được lưu (tin gửi qua websocket xử lý song song): câu hỏi phải đến sau tất cả
	nextMsg(t, wa, "message.new", func(m wsMsg) bool { return m.Content == "trả lời trong luồng nè" })

	for round := 0; round < 2; round++ {
		wa.send(map[string]any{"type": "message.send", "channel_id": ch.ID, "content": "@ai tóm tắt 1 ngày qua", "client_id": fmt.Sprint("q", round)})
		nextMsg(t, wa, "message.updated", func(m wsMsg) bool { return m.UserID == botID && strings.Contains(m.Content, "fake-1") })
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	sys := f.systems[len(f.systems)-1]
	for _, want := range []string{"tin số 1\n", "tin số 80", "↳ ", "trả lời trong luồng nè", "[ảnh team.png: Một hình chữ nhật đỏ nhỏ"} {
		if !strings.Contains(sys, want) {
			t.Fatalf("summary context missing %q (described=%d tools=%v systems=%d):\n%s", want, f.described, f.toolNames, len(f.systems), sys[len(sys)-min(len(sys), 600):])
		}
	}
	if f.described != 1 {
		t.Fatalf("image should be described once and cached, got %d", f.described)
	}
}

// Agent: model gọi công cụ, server chạy rồi gửi kết quả lại cho model trả lời.
func TestAIAgentTools(t *testing.T) {
	e := newEnv(t)
	f := newFakeAI(t)
	chat := ai.NewChat(&ai.Provider{Name: "fake", BaseURL: f.srv.URL, Model: "fake-1", Vision: true})
	images := &ai.Images{Providers: []ai.ImageProvider{ai.PollinationsImage{BaseURL: f.srv.URL}}}
	if err := e.api.SetAI(context.Background(), chat, images, nil); err != nil {
		t.Fatal(err)
	}
	alice := e.register("alice", "Alice")
	bob := e.register("bob", "Bob Nguyễn")
	var ch channel
	e.do("POST", "/api/channels", alice.Token, map[string]any{"name": "agent"}, &ch)
	e.do("POST", "/api/channels/"+itoa(ch.ID)+"/join", bob.Token, nil, nil)
	wa := e.dial(alice.Token)
	botID := int64(wa.waitFor("ready")["ai"].(map[string]any)["bot_id"].(float64))
	wb := e.dial(bob.Token)
	wb.waitFor("ready")
	wb.send(map[string]any{"type": "message.send", "channel_id": ch.ID, "content": "mai ăn phở nhé", "client_id": "b1"})
	root := nextMsg(t, wa, "message.new", func(m wsMsg) bool { return m.UserID == bob.User.ID })
	wb.send(map[string]any{"type": "message.send", "channel_id": ch.ID, "content": "đồng ý phở gà", "client_id": "b2", "parent_id": root.ID})
	time.Sleep(200 * time.Millisecond)

	ask := func(q string) string {
		t.Helper()
		wa.send(map[string]any{"type": "message.send", "channel_id": ch.ID, "content": "@ai " + q, "client_id": q})
		return nextMsg(t, wa, "message.updated", func(m wsMsg) bool {
			return m.UserID == botID && strings.Contains(m.Content, "fake-1") && strings.Contains(m.Content, "Kết quả")
		}).Content
	}

	// tìm người: không dấu vẫn khớp "Bob Nguyễn"
	if got := ask("nguyen là ai"); !strings.Contains(got, "Bob Nguyễn (@bob)") {
		t.Fatalf("list_members: %q", got)
	}
	// tìm tin theo người
	if got := ask("ai nói phở"); !strings.Contains(got, "Bob Nguyễn: mai ăn phở nhé") {
		t.Fatalf("search_messages: %q", got)
	}
	// đọc luồng (công cụ lạ thì báo lỗi, không làm hỏng lượt)
	if got := ask(fmt.Sprintf("đọc luồng #%d", root.ID)); !strings.Contains(got, "không có công cụ no_such_tool") {
		t.Fatalf("unknown tool: %q", got)
	}
	f.mu.Lock()
	ctxText := f.systems[len(f.systems)-1]
	f.mu.Unlock()
	if !strings.Contains(ctxText, "Luồng của tin #") || !strings.Contains(ctxText, "↳ [#") || !strings.Contains(ctxText, "đồng ý phở gà") {
		t.Fatalf("read_thread result missing:\n%s", ctxText)
	}
	// nhắc việc: chỉ cho người hỏi
	if got := ask("nhắc mình gửi báo cáo"); !strings.Contains(got, "Đã đặt nhắc Alice") {
		t.Fatalf("set_reminder: %q", got)
	}
	var rems []map[string]any
	e.do("GET", "/api/reminders", alice.Token, nil, &rems)
	if len(rems) != 1 || rems[0]["note"] != "gửi báo cáo" {
		t.Fatalf("reminders: %v", rems)
	}
	// bình chọn do bot tạo trong kênh
	if got := ask("tạo bình chọn ăn trưa"); !strings.Contains(got, "Đã tạo bình chọn «Trưa ăn gì?»") {
		t.Fatalf("create_poll: %q", got)
	}
	// vẽ: mô tả tiếng Anh của agent dùng thẳng, khung dọc
	if got := ask("minh hoạ con mèo"); !strings.Contains(got, "Đã vẽ xong") {
		t.Fatalf("draw_image: %q", got)
	}
	// mở game: phòng Ma Sói do người hỏi làm chủ phòng
	if got := ask("rủ mọi người chơi ma sói"); !strings.Contains(got, "Đã mở phòng Ma Sói") || !strings.Contains(got, "Alice là chủ phòng") {
		t.Fatalf("start_game: %q", got)
	}
	var page struct {
		Messages []map[string]any `json:"messages"`
	}
	e.do("GET", "/api/channels/"+itoa(ch.ID)+"/messages", alice.Token, nil, &page)
	var gameMsg map[string]any
	for _, m := range page.Messages {
		if em, _ := m["embed"].(map[string]any); em != nil && em["type"] == "game" {
			gameMsg = m
		}
	}
	if gameMsg == nil || int64(gameMsg["user_id"].(float64)) != alice.User.ID || gameMsg["game"] == nil {
		t.Fatalf("game message: %v", gameMsg)
	}
	// ghim tin thay người hỏi
	if got := ask(fmt.Sprintf("ghim tin #%d", root.ID)); !strings.Contains(got, "Đã ghim tin") {
		t.Fatalf("pin_message: %q", got)
	}
	var pins []map[string]any
	e.do("GET", "/api/channels/"+itoa(ch.ID)+"/pins", bob.Token, nil, &pins)
	if len(pins) != 1 || int64(pins[0]["id"].(float64)) != root.ID {
		t.Fatalf("pins: %v", pins)
	}

	f.mu.Lock()
	imgReq := f.imagePro[len(f.imagePro)-1]
	tools := strings.Join(f.toolNames, ",")
	f.mu.Unlock()
	if !strings.HasPrefix(imgReq, "a cat astronaut, watercolor?") || !strings.Contains(imgReq, "height=1216") {
		t.Fatalf("image request: %s", imgReq)
	}
	if tools != "list_members,search_messages,read_thread,no_such_tool,set_reminder,create_poll,draw_image,start_game,pin_message" {
		t.Fatalf("tools called: %s", tools)
	}
}

// Không bên nào gọi công cụ được: dùng cách cũ (lập kế hoạch rồi trả lời một lần).
func TestAIAgentFallsBackWithoutTools(t *testing.T) {
	e := newEnv(t)
	f := newFakeAI(t)
	chat := ai.NewChat(&ai.Provider{Name: "fake", BaseURL: f.srv.URL, Model: "fake-1", NoTools: true})
	if err := e.api.SetAI(context.Background(), chat, nil, nil); err != nil {
		t.Fatal(err)
	}
	alice := e.register("alice", "Alice")
	var ch channel
	e.do("POST", "/api/channels", alice.Token, map[string]any{"name": "cu"}, &ch)
	wa := e.dial(alice.Token)
	botID := int64(wa.waitFor("ready")["ai"].(map[string]any)["bot_id"].(float64))
	wa.send(map[string]any{"type": "message.send", "channel_id": ch.ID, "content": "@ai tóm tắt hôm nay", "client_id": "q"})
	nextMsg(t, wa, "message.updated", func(m wsMsg) bool { return m.UserID == botID && strings.Contains(m.Content, "fake-1") })
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.plans != 1 || f.toolRounds != 0 {
		t.Fatalf("plans=%d toolRounds=%d", f.plans, f.toolRounds)
	}
}

// Trí nhớ theo kênh: kênh dài ra thì tin cũ được gộp vào bản tóm tắt; câu hỏi sau đọc trí nhớ
// + mọi tin sau phần đã nhớ.
func TestAIChannelMemory(t *testing.T) {
	e := newEnv(t)
	f := newFakeAI(t)
	chat := ai.NewChat(&ai.Provider{Name: "fake", BaseURL: f.srv.URL, Model: "fake-1"})
	if err := e.api.SetAI(context.Background(), chat, nil, nil); err != nil {
		t.Fatal(err)
	}
	alice := e.register("alice", "Alice")
	var ch channel
	e.do("POST", "/api/channels", alice.Token, map[string]any{"name": "nho"}, &ch)
	wa := e.dial(alice.Token)
	botID := int64(wa.waitFor("ready")["ai"].(map[string]any)["bot_id"].(float64))
	ask := func(q string) {
		t.Helper()
		wa.send(map[string]any{"type": "message.send", "channel_id": ch.ID, "content": "@ai " + q, "client_id": q})
		nextMsg(t, wa, "message.updated", func(m wsMsg) bool { return m.UserID == botID && strings.Contains(m.Content, "fake-1") })
	}
	send := func(from, to int) {
		for i := from; i <= to; i++ {
			wa.send(map[string]any{"type": "message.send", "channel_id": ch.ID, "content": fmt.Sprintf("chuyện số %d", i), "client_id": fmt.Sprint("m", i)})
		}
		last := fmt.Sprintf("chuyện số %d", to)
		nextMsg(t, wa, "message.new", func(m wsMsg) bool { return m.Content == last })
	}
	waitCompacts := func(n int) {
		t.Helper()
		for i := 0; i < 100; i++ {
			f.mu.Lock()
			got := len(f.compacts)
			f.mu.Unlock()
			if got >= n {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("expected %d compactions", n)
	}

	// kênh ngắn: chưa gộp
	send(1, 10)
	ask("chào")
	time.Sleep(300 * time.Millisecond)
	f.mu.Lock()
	if len(f.compacts) != 0 {
		t.Fatalf("short channel compacted: %d", len(f.compacts))
	}
	f.mu.Unlock()

	// dài ra: gộp các tin cũ ngoài 25 tin gần nhất
	send(11, 60)
	ask("hỏi lần hai")
	waitCompacts(1)
	f.mu.Lock()
	first := f.compacts[0]
	f.mu.Unlock()
	if !strings.Contains(first, "(chưa có)") || !strings.Contains(first, "chuyện số 1\n") || strings.Contains(first, "chuyện số 60") {
		t.Fatalf("compaction input:\n%s", first)
	}

	// câu hỏi sau: có trí nhớ + đọc nguyên văn mọi tin sau phần đã nhớ
	time.Sleep(200 * time.Millisecond)
	ask("hỏi lần ba")
	f.mu.Lock()
	sys := f.systems[len(f.systems)-1]
	f.mu.Unlock()
	for _, want := range []string{"## Trí nhớ của kênh", "**Đã chốt**: đi ăn lẩu (lần gộp 1)", "chuyện số 60"} {
		if !strings.Contains(sys, want) {
			t.Fatalf("context missing %q:\n%s", want, sys)
		}
	}
	if strings.Contains(sys, "chuyện số 2\n") {
		t.Fatalf("remembered messages should not be repeated verbatim:\n%s", sys)
	}
}

func TestAIAgentAnalyzePlayerGame(t *testing.T) {
	e := newEnv(t)
	f := newFakeAI(t)
	chat := ai.NewChat(&ai.Provider{Name: "fake", BaseURL: f.srv.URL, Model: "fake-1"})
	if err := e.api.SetAI(context.Background(), chat, nil, nil); err != nil {
		t.Fatal(err)
	}

	alice := e.register("alice", "Alice")
	var ch channel
	e.do("POST", "/api/channels", alice.Token, map[string]any{"name": "test-ai-analysis"}, &ch)

	wa := e.dial(alice.Token)
	ready := wa.waitFor("ready")
	botID := int64(ready["ai"].(map[string]any)["bot_id"].(float64))

	// Tạo một ván cờ tướng đã kết thúc
	state, _ := json.Marshal(map[string]any{
		"players": []map[string]any{
			{"id": alice.User.ID, "name": "Alice"},
		},
		"winners": []int64{alice.User.ID},
		"log":     []string{"1. P2-5 M8+7", "2. M2+3 X9-8", "Chiếu bí! Alice thắng."},
		"result":  "Alice thắng",
	})
	e.st.CreateGame(context.Background(), ch.ID, alice.User.ID, model.Embed{Type: "game", ID: "xiangqi"}, "ended", state)
	e.st.RecordSoloGameResult(context.Background(), "xiangqi", alice.User.ID, 99999, 1.0)

	// Alice hỏi AI phân tích cách chơi cờ tướng
	wa.send(map[string]any{"type": "message.send", "channel_id": ch.ID, "content": "@ai phân tích cách chơi cờ tướng của mình", "client_id": "a-analyze"})
	final := nextMsg(t, wa, "message.updated", func(m wsMsg) bool {
		return m.UserID == botID && strings.Contains(m.Content, "fake-1")
	})

	if !strings.Contains(final.Content, "Chiến tướng công sát trung lộ") {
		t.Fatalf("expected analysis report in response, got: %q", final.Content)
	}
	if !strings.Contains(final.Content, "P2-5 M8+7") {
		t.Fatalf("expected opening move in response, got: %q", final.Content)
	}
}

