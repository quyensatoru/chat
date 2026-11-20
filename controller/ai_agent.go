package controller

// Agent cho @ai: model tự gọi công cụ (đọc thêm tin, tìm tin, xem thành viên, đọc luồng, tìm web,
// mở link, xem ảnh, vẽ ảnh, đặt nhắc việc, tạo bình chọn) qua nhiều lượt rồi mới trả lời.
// Ngữ cảnh ban đầu chỉ có vài tin gần nhất để vừa hạn mức token của gói miễn phí; cần gì thì gọi công cụ.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"chat/ai"
	"chat/game"
	"chat/model"
)

const (
	aiAgentRecent   = 25     // tin gần nhất nạp sẵn
	aiAgentRounds   = 5      // số lượt được gọi công cụ; lượt sau đó buộc phải trả lời
	aiAgentCalls    = 4      // lệnh gọi tối đa mỗi lượt
	aiToolChars     = 5000   // ký tự tối đa mỗi kết quả công cụ
	aiReadChars     = 40_000 // riêng đọc lịch sử (tóm tắt cần nhiều)
	aiAgentPageText = 1500   // ký tự mỗi trang khi tìm web
)

const aiAgentGuide = `

## Công cụ
Phần trên có trí nhớ tóm tắt của kênh (nếu có) và các tin gần nhất. Cần chi tiết hơn thì TỰ GỌI CÔNG CỤ, đừng đoán và đừng hỏi lại người dùng điều bạn tự tra được:
- Chuyện đã bàn / tóm tắt / ai nói gì, làm gì: read_messages (theo số giờ, lọc được theo người) hoặc search_messages (theo từ khoá).
- Hỏi về một người ("X là ai", "X đâu rồi"): list_members, rồi read_messages lọc theo người đó nếu cần. Bị phàn nàn về một người (nhắn linh tinh, spam…): read_messages lọc theo người đó rồi nhận xét theo tin thật.
- Tin có "[luồng: N trả lời]": read_thread. Tin ghim: pinned_messages.
- Thông tin mới hoặc bên ngoài (tin tức, giá cả, thời tiết, tài liệu…): web_search, rồi open_url để đọc kỹ một trang. Người dùng đưa link: open_url.
- Ảnh trong kênh: look_at_images. Nhờ vẽ / tạo / sửa ảnh: draw_image (ảnh tự gửi vào kênh, bạn chỉ cần nói ngắn gọn).
- Nhờ tìm / gửi ảnh có sẵn trên mạng: search_images (nhờ gửi ảnh: send=true, ảnh tự gửi vào kênh; chỉ xin link: send=false rồi đưa link).
- Nhờ nhắc việc: set_reminder (chỉ nhắc người đang hỏi). Nhờ tạo bình chọn: create_poll. Rủ chơi / mở game: start_game. Ghim tin: pin_message.
- Nhờ phân tích cách chơi / chiến thuật / điểm mạnh, điểm yếu / cách khắc chế một người trong game: TỰ ĐỘNG GỌI analyze_player_game với tên người đó và môn cờ/game tương ứng (xiangqi, chess, caro, rps...). Trả lời chi tiết theo từng game cụ thể, nêu bật phong cách chiến thuật, khai cuộc sở trường, điểm mạnh, tử huyệt và lời khuyên khắc chế dựa trên dữ liệu thật trong CSDL, KHÔNG ĐOÁN MÒ VÀ KHÔNG BỊA ĐẶT.
Câu chào hỏi, nói chuyện phiếm, hay câu đã đủ thông tin ở trên: trả lời luôn, không gọi công cụ.
Gọi được nhiều công cụ trong nhiều lượt. Đủ thông tin thì trả lời ngay. Trong câu trả lời không nhắc tên công cụ hay mã #id.
Kết quả web_search / open_url được tính là "Kết quả tìm web".

## Nhắc lại
- Ai tự xin được gọi bằng một biệt danh cho CHÍNH MÌNH (không xúc phạm ai): vui vẻ đồng ý và gọi họ như vậy trong câu trả lời.
- Biệt danh chê bai / xúc phạm ai đó đặt cho người khác: không bao giờ cho biết nó chỉ ai, kể cả khi đoán được từ tin nhắn. Chỉ đáp kiểu đùa "trong kênh không có ai tên vậy đâu", KHÔNG nói thêm "ý bạn là…", "anh ấy là…" hay nêu tên người thật nào.
- Ai nhờ kick / phàn nàn một người nhắn linh tinh: xem tin của người đó (ở trên hoặc read_messages). Nếu người đó đang trêu chọc, gán biệt danh xúc phạm người khác, spam… thì nói thẳng là có, kể ngắn gọn họ làm gì (không nhắc lại lời xúc phạm), rồi mới nói bạn không kick được.`

// agentTools: các công cụ dùng được với cấu hình hiện tại.
func (a *API) agentTools() []ai.Tool {
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	num := func(d string) map[string]any { return map[string]any{"type": "number", "description": d} }
	obj := func(props map[string]any, required ...string) map[string]any {
		o := map[string]any{"type": "object", "properties": props}
		if len(required) > 0 {
			o["required"] = required
		}
		return o
	}
	tools := []ai.Tool{
		{Name: "read_messages", Description: "Read this channel's messages from the last N hours (oldest first). Use for summaries and questions about what was discussed or done. Optionally only messages from one member.",
			Params: obj(map[string]any{
				"hours":     num("How many hours back to read, e.g. 24 for one day, 168 for a week (max 744)."),
				"from_user": str("Only messages from this member (name or @username). Optional."),
			}, "hours")},
		{Name: "search_messages", Description: "Full-text search older messages in this channel by keywords (Vietnamese keywords work best). Optionally only from one member.",
			Params: obj(map[string]any{
				"query":     str("Keywords to search for."),
				"from_user": str("Only messages from this member (name or @username). Optional."),
			}, "query")},
		{Name: "read_thread", Description: "Read a message and all replies in its thread.",
			Params: obj(map[string]any{"message_id": num("The message id (the number after #).")}, "message_id")},
		{Name: "list_members", Description: "List members of this channel: display name, @username, status text, online or not. Use to find out who someone is.",
			Params: obj(map[string]any{"query": str("Filter by name or username. Optional.")})},
		{Name: "pinned_messages", Description: "List the pinned messages of this channel."},
	}
	if a.ai.search != nil {
		tools = append(tools,
			ai.Tool{Name: "web_search", Description: "Search the web for current or external information (news, prices, weather, docs). Returns titles, links, snippets and some page text.",
				Params: obj(map[string]any{"query": str("Concise search query in the best language for the topic.")}, "query")},
			ai.Tool{Name: "search_images", Description: "Find existing pictures on the web like a person would: search the web, open the result pages and collect their photos. send=true downloads them and posts them in the channel as images (when the user asks to send/show pictures). send=false only returns image links (when the user asks for links).",
				Params: obj(map[string]any{
					"query": str("What the pictures should show; Vietnamese or English, whichever finds better pictures."),
					"count": num("How many pictures (1-4, default 3)."),
					"send":  map[string]any{"type": "boolean", "description": "true: post the pictures in the channel; false: only return links."},
				}, "query", "send")},
			ai.Tool{Name: "open_url", Description: "Open a web page and read its main text.",
				Params: obj(map[string]any{"url": str("http(s) URL.")}, "url")})
	}
	if a.ai.chat.CanSee() {
		tools = append(tools, ai.Tool{Name: "look_at_images", Description: "Look at images posted in this channel and get descriptions (including any text in them). Without message_id: the latest images.",
			Params: obj(map[string]any{"message_id": num("Only images of this message. Optional.")})})
	}
	if a.ai.images != nil {
		tools = append(tools, ai.Tool{Name: "draw_image", Description: "Generate an image (or redraw the images attached to the question) and post it in the channel.",
			Params: obj(map[string]any{
				"prompt":              str("ONE detailed English prompt. For a redraw: describe the result and what to keep from the original (face, pose…)."),
				"orientation":         map[string]any{"type": "string", "enum": []string{"square", "landscape", "portrait"}},
				"use_attached_images": map[string]any{"type": "boolean", "description": "Redraw from the images attached to the question."},
			}, "prompt")})
	}
	tools = append(tools,
		ai.Tool{Name: "start_game", Description: "Open a game room in this channel with the person asking as host; others join by clicking it. " +
			"station = Trạm Vũ Trụ (impostor game like Among Us), werewolf = Ma Sói, spy = Ai là gián điệp (spy word game), caro = Cờ caro (gomoku, 2 players), rps = Oẳn tù tì (rock paper scissors), chess = Cờ vua (chess, 2 players).",
			Params: obj(map[string]any{"game": map[string]any{"type": "string", "enum": []string{"station", "werewolf", "spy", "caro", "rps", "chess"}}}, "game")},
		ai.Tool{Name: "analyze_player_game", Description: "Phân tích lối chơi, khai cuộc sở trường, chiến thuật, điểm mạnh, điểm yếu và xếp hạng Elo của một người chơi từ cơ sở dữ liệu cho một trò chơi cụ thể (xiangqi = Cờ tướng, chess = Cờ vua, caro = Cờ caro, rps = Oẳn tù tì, werewolf = Ma Sói, station = Trạm Vũ Trụ) hoặc toàn bộ game (all). Dùng khi có người hỏi về phong cách đánh, chiến thuật hoặc cách đối phó với một người nào đó.",
			Params: obj(map[string]any{
				"player": str("Tên hiển thị hoặc @username của người chơi cần phân tích."),
				"game":   map[string]any{"type": "string", "enum": []string{"xiangqi", "chess", "caro", "rps", "werewolf", "station", "all"}, "description": "Loại trò chơi cần phân tích (xiangqi, chess, caro, rps, werewolf, station, hoặc all)."},
			}, "player")},
		ai.Tool{Name: "pin_message", Description: "Pin (or unpin) a message of this channel on behalf of the person asking.",
			Params: obj(map[string]any{
				"message_id": num("The message id (the number after #)."),
				"pinned":     map[string]any{"type": "boolean", "description": "false to unpin. Default true."},
			}, "message_id")},
		ai.Tool{Name: "set_reminder", Description: "Remind the person asking (only them) about this conversation at a given local time.",
			Params: obj(map[string]any{
				"at":   str("Local time as YYYY-MM-DD HH:MM."),
				"note": str("Short note shown with the reminder."),
			}, "at")},
		ai.Tool{Name: "create_poll", Description: "Create a poll in this channel.",
			Params: obj(map[string]any{
				"question": str("Poll question."),
				"options":  map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "2 to 10 options."},
				"multiple": map[string]any{"type": "boolean", "description": "Allow choosing several options."},
			}, "question", "options")})
	return tools
}

// agentRun: trạng thái một lần trả lời bằng agent.
type agentRun struct {
	a      *API
	ch     model.Channel
	q      model.Message
	asker  model.User
	refs   []ai.Ref // ảnh gửi kèm câu hỏi (để vẽ lại)
	status func(string)
	reply  func(string) (model.Message, error)
	got    *aiGathered

	draws, reminders, polls, games, imageSends int
}

// runAgent: trả lời bằng agent, stream chữ qua live. ok=false: agent không chạy được (chưa có chữ nào),
// để nơi gọi dùng cách cũ.
func (a *API) runAgent(ctx context.Context, ch model.Channel, q model.Message, asker model.User, text string, refs []ai.Ref,
	status func(string), reply func(string) (model.Message, error), live *liveText) (res ai.Result, got aiGathered, err error, ok bool) {
	msgs, got := a.aiContext(ctx, ch, q, asker, text, status, true)
	run := &agentRun{a: a, ch: ch, q: q, asker: asker, refs: refs, status: status, reply: reply, got: &got}
	tools := a.agentTools()
	for round := 0; ; round++ {
		use := tools
		if round == aiAgentRounds {
			use = nil // đã tra đủ nhiều: buộc trả lời bằng những gì đang có
		}
		live.reset()
		if round > 0 {
			status("Đang viết câu trả lời…")
		}
		var calls []ai.ToolCall
		res, calls, err = a.ai.chat.StreamTools(ctx, msgs, use, live.delta)
		if err != nil {
			if live.empty() {
				log.Printf("ai agent: lượt %d lỗi, dùng cách cũ: %v", round, err)
				return res, got, err, false
			}
			return res, got, err, true
		}
		if len(calls) == 0 {
			return res, got, nil, true
		}
		if len(calls) > aiAgentCalls {
			calls = calls[:aiAgentCalls]
		}
		msgs = append(msgs, ai.Message{Role: "assistant", Content: live.text(), ToolCalls: calls})
		for _, c := range calls {
			out := run.exec(ctx, c)
			log.Printf("ai agent: %s %s -> %d ký tự", c.Name, shorten(c.Args, 200), len(out))
			msgs = append(msgs, ai.Message{Role: "tool", ToolCallID: c.ID, Content: out})
		}
	}
}

/* ---------- Tham số ---------- */

type toolArgs map[string]any

func (t toolArgs) str(k string) string {
	switch v := t[k].(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return ""
}

func (t toolArgs) num(k string) float64 {
	switch v := t[k].(type) {
	case float64:
		return v
	case string:
		f, _ := strconv.ParseFloat(strings.TrimPrefix(strings.TrimSpace(v), "#"), 64)
		return f
	}
	return 0
}

func (t toolArgs) boolean(k string) bool {
	switch v := t[k].(type) {
	case bool:
		return v
	case string:
		return v == "true"
	}
	return false
}

func (t toolArgs) list(k string) []string {
	var out []string
	switch v := t[k].(type) {
	case []any:
		for _, x := range v {
			if s, ok := x.(string); ok && strings.TrimSpace(s) != "" {
				out = append(out, strings.TrimSpace(s))
			}
		}
	case string: // model đôi khi gửi "a, b, c"
		for _, s := range strings.Split(v, ",") {
			if s = strings.TrimSpace(s); s != "" {
				out = append(out, s)
			}
		}
	}
	return out
}

/* ---------- Thực thi ---------- */

func (r *agentRun) exec(ctx context.Context, c ai.ToolCall) string {
	args := toolArgs{}
	if s := strings.TrimSpace(c.Args); s != "" && s != "null" {
		if err := json.Unmarshal([]byte(s), &args); err != nil {
			return "Lỗi: tham số không phải JSON hợp lệ."
		}
	}
	switch c.Name {
	case "read_messages":
		return r.readMessages(ctx, args.num("hours"), args.str("from_user"))
	case "search_messages":
		return r.searchMessages(ctx, args.str("query"), args.str("from_user"))
	case "read_thread":
		return r.readThread(ctx, int64(args.num("message_id")))
	case "list_members":
		return r.listMembers(ctx, args.str("query"))
	case "pinned_messages":
		return r.pinned(ctx)
	case "web_search":
		return r.webSearch(ctx, args.str("query"))
	case "search_images":
		send := true
		if _, ok := args["send"]; ok {
			send = args.boolean("send")
		}
		n := int(args.num("count"))
		if n == 0 {
			n = 3
		}
		return r.searchImages(ctx, args.str("query"), n, send)
	case "open_url":
		return r.openURL(ctx, args.str("url"))
	case "look_at_images":
		return r.lookAtImages(ctx, int64(args.num("message_id")))
	case "draw_image":
		return r.draw(ctx, args.str("prompt"), args.str("orientation"), args.boolean("use_attached_images"))
	case "start_game":
		return r.startGame(ctx, args.str("game"))
	case "analyze_player_game":
		return r.analyzePlayerGame(ctx, args.str("player"), args.str("game"))
	case "pin_message":
		pin := true
		if _, ok := args["pinned"]; ok {
			pin = args.boolean("pinned")
		}
		return r.pin(ctx, int64(args.num("message_id")), pin)
	case "set_reminder":
		return r.setReminder(ctx, args.str("at"), args.str("note"))
	case "create_poll":
		return r.createPoll(ctx, args.str("question"), args.list("options"), args.boolean("multiple"))
	}
	return "Lỗi: không có công cụ " + c.Name + "."
}

// captionsFor: mô tả ảnh đã lưu của các tin (không gọi model).
func (r *agentRun) captionsFor(ctx context.Context, msgs []model.Message) map[string]string {
	caps := map[string]string{}
	for _, m := range msgs {
		for _, at := range m.Attachments {
			if im, ok := imageOf(at); ok {
				if c, _ := r.a.store.Caption(ctx, im.Key); c != "" {
					caps[im.Key] = c
				}
			}
		}
	}
	return caps
}

// keepNewest: giữ các dòng mới nhất trong giới hạn ký tự; trả về số tin bị bỏ.
func keepNewest(lines []string, limit int) ([]string, int) {
	total, start := 0, len(lines)
	for start > 0 && total+len(lines[start-1])+1 <= limit {
		start--
		total += len(lines[start]) + 1
	}
	return lines[start:], countMessages(lines[:start])
}

func clipTool(s string) string {
	if len(s) <= aiToolChars {
		return s
	}
	cut := aiToolChars
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "\n… (đã cắt bớt)"
}

func (r *agentRun) readMessages(ctx context.Context, hours float64, from string) string {
	if math.IsNaN(hours) || hours <= 0 {
		hours = 24
	}
	hours = math.Min(hours, 744)
	since := time.Now().Add(-time.Duration(hours * float64(time.Hour)))
	r.status(fmt.Sprintf("Đang đọc tin nhắn trong %s qua…", humanHours(hours)))
	list, older, err := r.a.store.MessagesSince(ctx, r.ch.ID, since, r.q.ID, aiRangeLimit)
	if err != nil {
		return "Lỗi khi đọc tin nhắn."
	}
	if from != "" {
		list = filterByUser(list, from)
		older = 0 // đếm theo người không chính xác: bỏ
	}
	lines := transcript(list, r.a.ai.bot.ID, r.captionsFor(ctx, list), lineID)
	lines, dropped := keepNewest(lines, aiReadChars)
	n := countMessages(lines)
	if n == 0 {
		who := ""
		if from != "" {
			who = " của " + from
		}
		return fmt.Sprintf("Không có tin nào%s trong %s qua.", who, humanHours(hours))
	}
	r.got.Messages += n
	if r.got.Since.IsZero() || since.Before(r.got.Since) {
		r.got.Since = since
	}
	head := fmt.Sprintf("%d tin từ %s đến giờ", n, since.Local().Format("15:04 02/01"))
	if from != "" {
		head += " của " + from
	}
	if dropped+older > 0 {
		head += fmt.Sprintf(" (bỏ bớt %d tin cũ hơn vì quá dài)", dropped+older)
	}
	return head + ":\n" + strings.Join(lines, "\n")
}

func (r *agentRun) searchMessages(ctx context.Context, query, from string) string {
	if query == "" {
		return "Lỗi: cần từ khoá."
	}
	r.status("Đang tìm tin cũ: «" + shorten(query, 60) + "»…")
	// chỉ kênh này: câu trả lời hiện ở đây, không được lộ tin của kênh khác
	hits, err := r.a.store.SearchMessages(ctx, r.asker.ID, query, r.ch.ID, r.q.ID, 25)
	if err != nil {
		return "Lỗi khi tìm."
	}
	if from != "" {
		hits = filterByUser(hits, from)
	}
	var lines []string
	caps := r.captionsFor(ctx, hits)
	for i := len(hits) - 1; i >= 0; i-- {
		if l := transcriptLine(hits[i], r.a.ai.bot.ID, caps, lineDate|lineID); l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) == 0 {
		return "Không tìm thấy tin nào khớp «" + query + "». Thử từ khoá khác hoặc read_messages."
	}
	r.got.Messages += len(lines)
	return clipTool(fmt.Sprintf("%d tin khớp «%s» (cũ đến mới):\n%s", len(lines), query, strings.Join(lines, "\n")))
}

func (r *agentRun) readThread(ctx context.Context, id int64) string {
	parent, err := r.a.store.GetMessage(ctx, id)
	if err != nil || parent.ChannelID != r.ch.ID || parent.Cipher != "" {
		return "Không tìm thấy tin #" + strconv.FormatInt(id, 10) + " trong kênh này."
	}
	if parent.ParentID != nil { // đưa id một trả lời: đọc cả luồng của nó
		if p, err := r.a.store.GetMessage(ctx, *parent.ParentID); err == nil {
			parent = p
		}
	}
	r.status("Đang đọc luồng trả lời…")
	replies, err := r.a.store.ListThread(ctx, parent.ID)
	if err != nil {
		return "Lỗi khi đọc luồng."
	}
	all := append([]model.Message{parent}, replies...)
	lines := transcript(all, r.a.ai.bot.ID, r.captionsFor(ctx, all), lineDate|lineID)
	r.got.Messages += countMessages(lines)
	return clipTool(fmt.Sprintf("Luồng của tin #%d (%d trả lời):\n%s", parent.ID, len(replies), strings.Join(lines, "\n")))
}

func (r *agentRun) listMembers(ctx context.Context, query string) string {
	r.status("Đang xem danh sách thành viên…")
	members, err := r.a.store.ListMembers(ctx, r.ch.ID)
	if err != nil {
		return "Lỗi khi đọc danh sách thành viên."
	}
	var lines []string
	for _, u := range members {
		if u.ID == r.a.ai.bot.ID || (query != "" && !userMatches(&u, query)) {
			continue
		}
		l := fmt.Sprintf("- %s (@%s)", publicName(&u), u.Username)
		if u.StatusText != "" {
			l += " — trạng thái: " + shorten(u.StatusText, 100)
		}
		if r.a.hub.IsOnline(u.ID) {
			l += " — đang online"
		}
		lines = append(lines, l)
	}
	if len(lines) == 0 {
		return fmt.Sprintf("Không có thành viên nào khớp «%s» trong kênh #%s (kênh có %d thành viên).", query, r.ch.Name, len(members))
	}
	return clipTool(fmt.Sprintf("Thành viên kênh #%s khớp «%s» (%d người):\n%s", r.ch.Name, query, len(lines), strings.Join(lines, "\n")))
}

func (r *agentRun) pinned(ctx context.Context) string {
	list, err := r.a.store.ListPinned(ctx, r.ch.ID)
	if err != nil {
		return "Lỗi khi đọc tin ghim."
	}
	lines := transcript(list, r.a.ai.bot.ID, r.captionsFor(ctx, list), lineDate|lineID)
	if len(lines) == 0 {
		return "Kênh chưa có tin ghim nào."
	}
	return clipTool("Tin ghim:\n" + strings.Join(lines, "\n"))
}

func (r *agentRun) webSearch(ctx context.Context, query string) string {
	if query == "" {
		return "Lỗi: cần câu tìm kiếm."
	}
	r.status("Đang tìm trên web: «" + shorten(query, 60) + "»…")
	results, _, err := r.a.ai.search.Search(ctx, query, 5)
	if err != nil || len(results) == 0 {
		return "Không tìm được kết quả web cho «" + query + "»."
	}
	r.a.fetchPages(ctx, results, r.status)
	var b strings.Builder
	fmt.Fprintf(&b, "Kết quả tìm web cho «%s»:\n", query)
	for i, res := range results {
		fmt.Fprintf(&b, "\n[%d] %s — %s\n%s\n", i+1, res.Title, res.URL, res.Snippet)
		if res.Content != "" {
			b.WriteString("Nội dung trang: " + shorten(res.Content, aiAgentPageText) + "\n")
		}
	}
	r.got.Web += len(results)
	return clipTool(b.String())
}

func (r *agentRun) openURL(ctx context.Context, u string) string {
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		return "Lỗi: chỉ mở được link http(s)."
	}
	r.status("Đang đọc trang " + shorten(u, 60) + "…")
	pctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	// client chặn địa chỉ nội bộ (không cho AI đọc dịch vụ trong mạng LAN)
	text, err := ai.PageText(pctx, r.a.unfurlClient, u, aiToolChars-200)
	if err != nil || strings.TrimSpace(text) == "" {
		return "Không đọc được trang " + u + "."
	}
	r.got.Web++
	return clipTool("Nội dung trang " + u + ":\n" + text)
}

func (r *agentRun) lookAtImages(ctx context.Context, id int64) string {
	var msgs []model.Message
	if id > 0 {
		m, err := r.a.store.GetMessage(ctx, id)
		if err != nil || m.ChannelID != r.ch.ID || m.Cipher != "" {
			return "Không tìm thấy tin #" + strconv.FormatInt(id, 10) + " trong kênh này."
		}
		msgs = []model.Message{m}
	} else {
		list, _, err := r.a.store.ListMessages(ctx, r.ch.ID, r.q.ID+1, 80)
		if err != nil {
			return "Lỗi khi đọc tin nhắn."
		}
		msgs = list
	}
	type found struct {
		im aiImage
		m  model.Message
	}
	var imgs []found
	for i := len(msgs) - 1; i >= 0 && len(imgs) < aiMaxCaptions; i-- { // mới nhất trước
		for _, at := range msgs[i].Attachments {
			if im, ok := imageOf(at); ok && len(imgs) < aiMaxCaptions {
				imgs = append(imgs, found{im, msgs[i]})
			}
		}
	}
	if len(imgs) == 0 {
		return "Không có ảnh nào."
	}
	r.status(fmt.Sprintf("Đang xem %d ảnh…", len(imgs)))
	list := make([]aiImage, len(imgs))
	for i, f := range imgs {
		list[i] = f.im
	}
	caps := r.a.describeImages(ctx, list)
	var lines []string
	for _, f := range imgs {
		c := caps[f.im.Key]
		if c == "" {
			c = "(chưa xem được)"
		}
		lines = append(lines, fmt.Sprintf("- Ảnh %s trong tin #%d của %s lúc %s: %s", f.im.Name, f.m.ID, publicName(f.m.User),
			f.m.CreatedAt.Local().Format("15:04 02/01"), c))
	}
	r.got.Images += len(caps)
	return clipTool(strings.Join(lines, "\n"))
}

func (r *agentRun) draw(ctx context.Context, prompt, orientation string, useRefs bool) string {
	if r.draws >= 1 {
		return "Đã vẽ một ảnh cho câu hỏi này rồi, không vẽ thêm."
	}
	r.draws++
	switch orientation {
	case "landscape":
		prompt += " --ngang"
	case "portrait":
		prompt += " --doc"
	}
	var refs []ai.Ref
	if useRefs {
		refs = r.refs
		if len(refs) == 0 {
			return "Câu hỏi không kèm ảnh nào để vẽ lại."
		}
	}
	r.status("Đang vẽ…")
	if why := r.a.drawAI(ctx, r.ch, r.q, r.asker, prompt, refs, r.reply); why != "" {
		return "Chưa vẽ được: " + why + " (người dùng đã thấy thông báo này)."
	}
	return "Đã vẽ xong và gửi ảnh vào kênh."
}

func (r *agentRun) startGame(ctx context.Context, kind string) string {
	if r.games >= 1 {
		return "Đã mở một phòng chơi cho câu hỏi này rồi."
	}
	m, err := r.a.startGame(ctx, r.ch, r.asker, kind, nil, "")
	if err != nil {
		var ge game.Error
		if errors.As(err, &ge) {
			return "Lỗi: " + ge.Error()
		}
		return "Lỗi khi mở phòng chơi."
	}
	r.games++
	return fmt.Sprintf("Đã mở phòng %s (tin #%d) trong kênh, %s là chủ phòng. Mọi người bấm vào ván trong kênh để tham gia, chủ phòng bấm bắt đầu khi đủ người.",
		game.Title(kind), m.ID, displayNameOf(r.asker))
}

func (r *agentRun) pin(ctx context.Context, id int64, pinned bool) string {
	m, err := r.a.store.GetMessage(ctx, id)
	if err != nil || m.ChannelID != r.ch.ID || m.DeletedAt != nil {
		return "Không tìm thấy tin #" + strconv.FormatInt(id, 10) + " trong kênh này."
	}
	by := int64(0)
	if pinned {
		by = r.asker.ID
	}
	if err := r.a.store.SetPinned(ctx, m.ID, by); err != nil {
		return "Lỗi khi ghim tin."
	}
	if updated, err := r.a.store.GetMessage(ctx, m.ID); err == nil {
		list := []model.Message{updated}
		r.a.fillGames(ctx, 0, list) // tin ghim là một ván chơi: giữ nguyên bàn chơi khi cập nhật
		r.a.hub.ToChannel(r.ch.ID, mustJSON(messageUpdatedEvent{Type: "message.updated", Message: list[0]}), nil)
	}
	if pinned {
		return fmt.Sprintf("Đã ghim tin #%d (thay %s).", m.ID, displayNameOf(r.asker))
	}
	return fmt.Sprintf("Đã bỏ ghim tin #%d.", m.ID)
}

func (r *agentRun) setReminder(ctx context.Context, at, note string) string {
	if r.reminders >= 2 {
		return "Đã đặt đủ nhắc việc cho câu hỏi này."
	}
	t, err := time.ParseInLocation("2006-01-02 15:04", at, time.Local)
	if err != nil {
		t, err = time.ParseInLocation("2006-01-02T15:04", strings.TrimSuffix(at, ":00"), time.Local)
	}
	if err != nil {
		return "Lỗi: thời gian phải có dạng YYYY-MM-DD HH:MM."
	}
	if m := validRemindAt(t); m != "" {
		return "Lỗi: " + m
	}
	if utf8.RuneCountInString(note) > 200 {
		note = shorten(note, 200)
	}
	if _, err := r.a.store.CreateReminder(ctx, r.asker.ID, r.q.ID, t, note); err != nil {
		return "Lỗi khi đặt nhắc việc."
	}
	r.reminders++
	return fmt.Sprintf("Đã đặt nhắc %s lúc %s %s (%s).", displayNameOf(r.asker), t.Format("15:04"), vnDate(t), note)
}

func (r *agentRun) createPoll(ctx context.Context, question string, options []string, multiple bool) string {
	if r.polls >= 1 {
		return "Đã tạo một bình chọn cho câu hỏi này rồi."
	}
	p, msg := validatePoll(createPollRequest{Question: question, Options: options, Multiple: multiple})
	if msg != "" {
		return "Lỗi: " + msg
	}
	m, err := r.a.store.CreatePoll(ctx, r.ch.ID, r.a.ai.bot.ID, p)
	if err != nil {
		return "Lỗi khi tạo bình chọn."
	}
	r.polls++
	r.a.hub.ToChannel(r.ch.ID, mustJSON(messageNewEvent{Type: "message.new", Message: m}), nil)
	return "Đã tạo bình chọn «" + p.Question + "» trong kênh."
}

func (r *agentRun) findMember(ctx context.Context, query string) (*model.PublicUser, error) {
	q := strings.TrimSpace(query)
	qLower := strings.ToLower(q)
	if q == "" || qLower == "tôi" || qLower == "mình" || qLower == "em" || qLower == "me" {
		return &model.PublicUser{
			ID:          r.asker.ID,
			Username:    r.asker.Username,
			DisplayName: r.asker.DisplayName,
			StatusText:  r.asker.StatusText,
		}, nil
	}

	cleanLogin := strings.TrimPrefix(q, "@")
	if u, err := r.a.store.GetUserByLogin(ctx, cleanLogin); err == nil {
		return &model.PublicUser{
			ID:          u.ID,
			Username:    u.Username,
			DisplayName: u.DisplayName,
			StatusText:  u.StatusText,
		}, nil
	}

	members, err := r.a.store.ListMembers(ctx, r.ch.ID)
	if err == nil {
		for _, m := range members {
			if userMatches(&m, q) {
				return &m, nil
			}
		}
	}

	askerPub := model.PublicUser{
		ID:          r.asker.ID,
		Username:    r.asker.Username,
		DisplayName: r.asker.DisplayName,
		StatusText:  r.asker.StatusText,
	}
	if userMatches(&askerPub, q) {
		return &askerPub, nil
	}

	return nil, fmt.Errorf("không tìm thấy người chơi «%s» trong hệ thống", query)
}

func (r *agentRun) analyzePlayerGame(ctx context.Context, player, gameKind string) string {
	r.status("Đang phân tích phong cách và chiến thuật chơi…")
	u, err := r.findMember(ctx, player)
	if err != nil {
		return err.Error() + ". Vui lòng kiểm tra lại tên hoặc @username."
	}

	gameKind = strings.ToLower(strings.TrimSpace(gameKind))
	if gameKind == "" {
		gameKind = "xiangqi"
	}

	var kinds []string
	if gameKind == "all" {
		kinds = []string{"xiangqi", "chess", "caro", "rps"}
	} else {
		kinds = []string{gameKind}
	}

	var sections []string
	for _, k := range kinds {
		rep, err := r.a.store.AnalyzePlayerGameplay(ctx, u.ID, k)
		if err != nil {
			continue
		}

		gTitle := game.Title(k)
		if gTitle == "" {
			gTitle = strings.ToUpper(k)
		}

		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("### Phân tích chiến thuật môn %s:\n", gTitle))
		sb.WriteString(fmt.Sprintf("- **Kỳ thủ**: %s (@%s)\n", rep.PlayerName, rep.Username))
		sb.WriteString(fmt.Sprintf("- **Hạng & Elo**: %s %s (Elo: %d | Đỉnh cao: %d)\n", rep.TierBadge, rep.RankTier, rep.Rating, rep.PeakRating))
		sb.WriteString(fmt.Sprintf("- **Thành tích**: Tổng %d ván | Thắng %d (%.1f%%) | Hoà %d | Thua %d\n", rep.TotalGames, rep.Wins, rep.WinRate, rep.Draws, rep.Losses))
		sb.WriteString(fmt.Sprintf("- **Chuỗi phong độ**: Thắng liên tiếp hiện tại: %d | Kỷ lục chuỗi: %d\n", rep.CurrentStreak, rep.BestStreak))
		if rep.FirstTurnGames > 0 || rep.SecondTurnGames > 0 {
			sb.WriteString(fmt.Sprintf("- **Ưu thế lượt đi**: Đi trước (tiên thủ): %d ván (thắng %d) | Đi sau (hậu thủ): %d ván (thắng %d)\n",
				rep.FirstTurnGames, rep.FirstTurnWins, rep.SecondTurnGames, rep.SecondTurnWins))
		}
		if len(rep.FavoriteOpenings) > 0 {
			sb.WriteString(fmt.Sprintf("- **Khai cuộc sở trường**: %s\n", strings.Join(rep.FavoriteOpenings, ", ")))
		}
		sb.WriteString(fmt.Sprintf("- **Phong cách chiến thuật**: %s\n", rep.PlaystyleSummary))
		if len(rep.Strengths) > 0 {
			sb.WriteString("- **Điểm mạnh**:\n")
			for _, s := range rep.Strengths {
				sb.WriteString(fmt.Sprintf("  + %s\n", s))
			}
		}
		if len(rep.Weaknesses) > 0 {
			sb.WriteString("- **Điểm yếu / Lỗ hổng**:\n")
			for _, w := range rep.Weaknesses {
				sb.WriteString(fmt.Sprintf("  + %s\n", w))
			}
		}
		if len(rep.CounterTips) > 0 {
			sb.WriteString("- **Mẹo khắc chế & Đối phó**:\n")
			for _, tip := range rep.CounterTips {
				sb.WriteString(fmt.Sprintf("  + %s\n", tip))
			}
		}
		if len(rep.RecentMatches) > 0 {
			sb.WriteString("- **Ván đấu gần đây**:\n")
			for _, m := range rep.RecentMatches {
				sb.WriteString(fmt.Sprintf("  + %s\n", m))
			}
		}
		sections = append(sections, sb.String())
	}

	if len(sections) == 0 {
		return fmt.Sprintf("Chưa tìm thấy dữ liệu ván đấu nào của người chơi %s (@%s).", u.DisplayName, u.Username)
	}

	return clipTool(strings.Join(sections, "\n---\n\n"))
}

/* ---------- Tìm người ---------- */

// foldVN: chữ thường, bỏ dấu tiếng Việt ("Đức Anh" -> "duc anh").
func foldVN(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if base, ok := vnBase[r]; ok {
			b.WriteRune(base)
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

var vnBase = func() map[rune]rune {
	groups := map[rune]string{
		'a': "àáảãạăằắẳẵặâầấẩẫậ", 'e': "èéẻẽẹêềếểễệ", 'i': "ìíỉĩị", 'o': "òóỏõọôồốổỗộơờớởỡợ",
		'u': "ùúủũụưừứửữự", 'y': "ỳýỷỹỵ", 'd': "đ",
	}
	m := map[rune]rune{}
	for base, list := range groups {
		for _, r := range list {
			m[r] = base
		}
	}
	return m
}()

func userMatches(u *model.PublicUser, query string) bool {
	if u == nil {
		return false
	}
	q := foldVN(strings.TrimPrefix(strings.TrimSpace(query), "@"))
	return q != "" && (strings.Contains(foldVN(u.DisplayName), q) || strings.Contains(foldVN(u.Username), q))
}

func filterByUser(msgs []model.Message, who string) []model.Message {
	out := msgs[:0:0]
	for _, m := range msgs {
		if userMatches(m.User, who) {
			out = append(out, m)
		}
	}
	return out
}

// vnDate: "thứ Sáu 20/11/2026".
func vnDate(t time.Time) string {
	days := [...]string{"Chủ nhật", "thứ Hai", "thứ Ba", "thứ Tư", "thứ Năm", "thứ Sáu", "thứ Bảy"}
	return days[t.Weekday()] + " " + t.Format("02/01/2006")
}
