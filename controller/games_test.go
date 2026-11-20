package controller_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"chat/controller"
	"chat/model"

	"github.com/coder/websocket"
)

type gameResp struct {
	Kind    string               `json:"kind"`
	Status  string               `json:"status"`
	Players []struct{ ID int64 } `json:"players"`
	State   map[string]any       `json:"state"`
	Me      map[string]any       `json:"me"`
	Version int                  `json:"version"`
	Error   string               `json:"error"`
}

type gameMsg struct {
	ID    int64 `json:"id"`
	Embed struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	} `json:"embed"`
	Game  gameResp `json:"game"`
	Error string   `json:"error"`
}

func TestGamesCaro(t *testing.T) {
	e := newEnv(t)
	alice := e.register("alice", "Alice")
	bob := e.register("bob", "Bob")
	carol := e.register("carol", "Carol")
	dave := e.register("dave", "Dave") // không ở trong kênh
	var ch channel
	e.do("POST", "/api/channels", alice.Token, map[string]any{"name": "giai-tri"}, &ch)
	for _, tk := range []string{bob.Token, carol.Token} {
		e.do("POST", "/api/channels/"+itoa(ch.ID)+"/join", tk, nil, nil)
	}
	wc := e.dial(carol.Token)
	path := "/api/channels/" + itoa(ch.ID) + "/games"

	if code := e.do("POST", path, alice.Token, map[string]any{"kind": "tetris"}, nil); code != 400 {
		t.Fatalf("unknown game: %d", code)
	}
	if code := e.do("POST", path, dave.Token, map[string]any{"kind": "caro"}, nil); code == 201 {
		t.Fatal("non-member created a game")
	}
	var m gameMsg
	if code := e.do("POST", path, alice.Token, map[string]any{"kind": "caro", "client_id": "g1"}, &m); code != 201 {
		t.Fatalf("create: %d %s", code, m.Error)
	}
	if m.Embed.Type != "game" || m.Game.Status != "lobby" || len(m.Game.Players) != 1 {
		t.Fatalf("created: %+v", m)
	}
	if ev := wc.waitFor("message.new"); ev["message"].(map[string]any)["game"] == nil {
		t.Fatalf("message.new without game: %v", ev)
	}
	act := func(tok, action string, data any) (int, gameResp) {
		var g gameResp
		body := map[string]any{"action": action}
		if data != nil {
			body["data"] = data
		}
		code := e.do("POST", "/api/messages/"+itoa(m.ID)+"/game", tok, body, &g)
		return code, g
	}
	if code, _ := act(dave.Token, "join", nil); code != 404 {
		t.Fatalf("non-member join: %d", code)
	}
	code, g := act(bob.Token, "join", nil)
	if code != 200 || g.Status != "playing" {
		t.Fatalf("join: %d %+v", code, g)
	}
	ev := wc.waitFor("game.updated")
	if ev["game"].(map[string]any)["status"] != "playing" {
		t.Fatalf("spectator update: %v", ev)
	}
	firstTok, secondTok := alice.Token, bob.Token
	if g.Players[0].ID == bob.User.ID {
		firstTok, secondTok = bob.Token, alice.Token
	}
	if code, g := act(secondTok, "move", map[string]int{"cell": 0}); code != 400 || g.Error == "" {
		t.Fatalf("O moved first: %d", code)
	}
	if code, _ := act(firstTok, "move", map[string]int{"cell": 112}); code != 200 {
		t.Fatalf("move: %d", code)
	}
	if code, g := act(carol.Token, "move", map[string]int{"cell": 113}); code != 400 || g.Error != "Bạn không chơi ván này." {
		t.Fatalf("spectator move: %d %q", code, g.Error)
	}

	// lịch sử tin có kèm ván
	var list struct {
		Messages []gameMsg `json:"messages"`
	}
	e.do("GET", "/api/channels/"+itoa(ch.ID)+"/messages", carol.Token, nil, &list)
	if len(list.Messages) == 0 || list.Messages[len(list.Messages)-1].Game.State["board"] == nil {
		t.Fatalf("history without game: %+v", list)
	}

	// xoá tin -> ván không còn
	if code := e.do("DELETE", "/api/messages/"+itoa(m.ID), alice.Token, nil, nil); code != 200 {
		t.Fatalf("delete: %d", code)
	}
	if code, _ := act(bob.Token, "move", map[string]int{"cell": 0}); code != 404 {
		t.Fatalf("move on deleted game: %d", code)
	}
}

func TestGameLeaderboard(t *testing.T) {
	e := newEnv(t)
	alice := e.register("alice", "Alice")
	bob := e.register("bob", "Bob")
	var ch channel
	e.do("POST", "/api/channels", alice.Token, map[string]any{"name": "game-room"}, &ch)
	e.do("POST", "/api/channels/"+itoa(ch.ID)+"/join", bob.Token, nil, nil)

	var m gameMsg
	e.do("POST", "/api/channels/"+itoa(ch.ID)+"/games", alice.Token, map[string]any{"kind": "caro"}, &m)

	var g gameResp
	e.do("POST", "/api/messages/"+itoa(m.ID)+"/game", bob.Token, map[string]any{"action": "join"}, &g)

	e.do("POST", "/api/messages/"+itoa(m.ID)+"/game", alice.Token, map[string]any{"action": "resign"}, nil)
	time.Sleep(100 * time.Millisecond)

	var lb struct {
		Kind      string `json:"kind"`
		TopWins   []any  `json:"top_wins"`
		TopLosses []any  `json:"top_losses"`
		Members   []struct {
			UserID     int64   `json:"user_id"`
			Rating     int     `json:"rating"`
			RankTier   string  `json:"rank_tier"`
			TierBadge  string  `json:"tier_badge"`
			Wins       int     `json:"wins"`
			Losses     int     `json:"losses"`
			TotalGames int     `json:"total_games"`
			WinRate    float64 `json:"win_rate"`
		} `json:"members"`
		TotalEnded int `json:"total_ended"`
	}
	code := e.do("GET", "/api/games/leaderboard?kind=caro", alice.Token, nil, &lb)
	if code != 200 {
		t.Fatalf("leaderboard status: %d", code)
	}
	if lb.TotalEnded != 1 {
		t.Fatalf("total ended want 1, got %d", lb.TotalEnded)
	}
	if len(lb.Members) != 2 {
		t.Fatalf("members count want 2, got %d", len(lb.Members))
	}
	// Bob thắng: nhận +16 -> 1216 (Rank Bạc)
	if lb.Members[0].UserID != bob.User.ID || lb.Members[0].Rating != 1216 || lb.Members[0].TierBadge != "🥈" {
		t.Fatalf("expected bob to be top 1 with 1216 Elo 🥈, got: %+v", lb.Members[0])
	}
	// Alice thua: mất 16 -> 1184 (Rank Đồng)
	if lb.Members[1].UserID != alice.User.ID || lb.Members[1].Rating != 1184 || lb.Members[1].TierBadge != "🥉" {
		t.Fatalf("expected alice to be rank 2 with 1184 Elo 🥉, got: %+v", lb.Members[1])
	}
}

func TestGamesSecretsStayPrivate(t *testing.T) {
	e := newEnv(t)
	names := []string{"anh", "binh", "chi", "dung", "emm"}
	var toks []string
	for _, n := range names {
		toks = append(toks, e.register(n, n).Token)
	}
	var ch channel
	e.do("POST", "/api/channels", toks[0], map[string]any{"name": "ma-soi"}, &ch)
	for _, tk := range toks[1:] {
		e.do("POST", "/api/channels/"+itoa(ch.ID)+"/join", tk, nil, nil)
	}
	var m gameMsg
	e.do("POST", "/api/channels/"+itoa(ch.ID)+"/games", toks[0], map[string]any{"kind": "spy"}, &m)
	act := func(tok, action string) (int, gameResp) {
		var g gameResp
		code := e.do("POST", "/api/messages/"+itoa(m.ID)+"/game", tok, map[string]any{"action": action}, &g)
		return code, g
	}
	for _, tk := range toks[1:4] {
		if code, g := act(tk, "join"); code != 200 {
			t.Fatalf("join: %d %s", code, g.Error)
		}
	}
	// toks[4] chỉ xem
	spectator := e.dial(toks[4])
	if code, g := act(toks[0], "start"); code != 200 || g.Me["word"] == nil {
		t.Fatalf("start: %d %+v", code, g)
	}
	ev := spectator.waitFor("game.updated")
	gm := ev["game"].(map[string]any)
	if gm["me"] != nil || gm["state"].(map[string]any)["words"] != nil {
		t.Fatalf("spectator sees secrets: %v", gm)
	}
	var list struct {
		Messages []gameMsg `json:"messages"`
	}
	e.do("GET", "/api/channels/"+itoa(ch.ID)+"/messages", toks[1], nil, &list)
	if g := list.Messages[len(list.Messages)-1].Game; g.Me["word"] == nil {
		t.Fatalf("player should see own word in history: %+v", g)
	}
	var list2 struct {
		Messages []gameMsg `json:"messages"`
	}
	e.do("GET", "/api/channels/"+itoa(ch.ID)+"/messages", toks[4], nil, &list2)
	if g := list2.Messages[len(list2.Messages)-1].Game; g.Me != nil {
		t.Fatalf("spectator has me: %+v", g)
	}
}

func TestStationRealtime(t *testing.T) {
	e := newEnv(t)
	var toks []string
	var ids []int64
	for _, n := range []string{"anh", "binh", "chi", "dung", "khach"} {
		r := e.register(n, n)
		toks = append(toks, r.Token)
		ids = append(ids, r.User.ID)
	}
	var ch channel
	e.do("POST", "/api/channels", toks[0], map[string]any{"name": "tram"}, &ch)
	for _, tk := range toks[1:] {
		e.do("POST", "/api/channels/"+itoa(ch.ID)+"/join", tk, nil, nil)
	}
	var m gameMsg
	if code := e.do("POST", "/api/channels/"+itoa(ch.ID)+"/games", toks[0], map[string]any{"kind": "station"}, &m); code != 201 {
		t.Fatalf("create station: %d %s", code, m.Error)
	}
	act := func(tok, action string, data any) (int, gameResp) {
		var g gameResp
		body := map[string]any{"action": action}
		if data != nil {
			body["data"] = data
		}
		return e.do("POST", "/api/messages/"+itoa(m.ID)+"/game", tok, body, &g), g
	}
	for _, tk := range toks[1:4] {
		act(tk, "join", nil)
	}
	if code, g := act(toks[0], "start", nil); code != 200 || g.Status != "playing" {
		t.Fatalf("start: %d %+v", code, g)
	}

	ws := e.dial(toks[1])
	ws.waitFor("ready")
	ws.send(map[string]any{"type": "game.watch", "message_id": m.ID})
	if ev := ws.waitFor("game.map"); ev["map"].(map[string]any)["rooms"] == nil {
		t.Fatalf("map: %v", ev)
	}
	f := ws.waitFor("game.frame")["frame"].(map[string]any)
	if f["phase"] != "intro" {
		t.Fatalf("first phase: %v", f["phase"])
	}
	me := f["me"].(map[string]any)
	x, y := me["x"].(float64), me["y"].(float64)
	// trong intro không đi được; chờ sang "play" rồi đi 20 đơn vị
	for f["phase"] != "play" {
		f = ws.waitForTimeout("game.frame", 8*time.Second)["frame"].(map[string]any)
	}
	ws.send(map[string]any{"type": "game.pos", "message_id": m.ID, "data": map[string]float64{"x": x + 20, "y": y}})
	deadline := time.Now().Add(2 * time.Second)
	for {
		f = ws.waitFor("game.frame")["frame"].(map[string]any)
		if f["me"].(map[string]any)["x"].(float64) == x+20 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("position was not accepted")
		}
	}

	// người không chơi mở màn hình: không nhận gì
	spectator := e.dial(toks[4])
	spectator.waitFor("ready")
	spectator.send(map[string]any{"type": "game.watch", "message_id": m.ID})
	if ev, ok := spectator.tryWait("game.map", 500*time.Millisecond); ok {
		t.Fatalf("spectator got map: %v", ev)
	}
	_ = ids
}

func TestGamesChess(t *testing.T) {
	e := newEnv(t)
	alice := e.register("alice", "Alice")
	bob := e.register("bob", "Bob")

	wsAlice := e.dial(alice.Token)
	wsAlice.waitFor("ready")

	// Test DM creation for chess
	var dm channel
	if code := e.do("POST", "/api/dms", alice.Token, map[string]any{"user_id": bob.User.ID}, &dm); code != 201 {
		t.Fatalf("create dm: %d", code)
	}

	var m gameMsg
	if code := e.do("POST", "/api/channels/"+itoa(dm.ID)+"/games", alice.Token, map[string]any{
		"kind": "chess",
		"options": map[string]any{
			"turn_minutes": 3,
			"first":        "host",
		},
	}, &m); code != 201 {
		t.Fatalf("create chess in dm: %d", code)
	}

	// Bob joins, auto-starts 2-player chess
	var g gameResp
	if code := e.do("POST", "/api/messages/"+itoa(m.ID)+"/game", bob.Token, map[string]any{"action": "join"}, &g); code != 200 {
		t.Fatalf("bob join: %d", code)
	}
	if g.Status != "playing" {
		t.Fatalf("expected playing status, got %s", g.Status)
	}

	// Alice (host) specified first: "host", so Alice must be White
	turnPID := int64(g.State["turn_player_id"].(float64))
	if turnPID != alice.User.ID {
		t.Fatalf("expected alice (host) to have first turn, got %d", turnPID)
	}

	// WebSocket receives game.updated on join
	ev := wsAlice.waitFor("game.updated")
	if ev["message_id"].(float64) != float64(m.ID) {
		t.Fatalf("ws game.updated mismatch: %v", ev)
	}

	// White (Alice) moves e2 -> e4
	if code := e.do("POST", "/api/messages/"+itoa(m.ID)+"/game", alice.Token, map[string]any{
		"action": "move",
		"data":   map[string]string{"from": "e2", "to": "e4"},
	}, &g); code != 200 {
		t.Fatalf("white move e2-e4: %d", code)
	}

	// WebSocket receives game.updated on move
	wsAlice.waitFor("game.updated")

	// Black (Bob) resigns
	if code := e.do("POST", "/api/messages/"+itoa(m.ID)+"/game", bob.Token, map[string]any{
		"action": "resign",
	}, &g); code != 200 {
		t.Fatalf("black resign: %d", code)
	}
	if g.Status != "ended" {
		t.Fatalf("expected ended status, got %s", g.Status)
	}

	// WebSocket receives game.updated on end
	wsAlice.waitFor("game.updated")
}

func TestGetGameUserRole(t *testing.T) {
	e := newEnv(t)
	alice := e.register("alice2", "Alice 2")
	bob := e.register("bob2", "Bob 2")
	carol := e.register("carol2", "Carol 2") // viewer

	var ch channel
	e.do("POST", "/api/channels", alice.Token, map[string]any{"name": "test-roles"}, &ch)
	e.do("POST", "/api/channels/"+itoa(ch.ID)+"/join", bob.Token, nil, nil)
	e.do("POST", "/api/channels/"+itoa(ch.ID)+"/join", carol.Token, nil, nil)

	var m gameMsg
	if code := e.do("POST", "/api/channels/"+itoa(ch.ID)+"/games", alice.Token, map[string]any{"kind": "caro"}, &m); code != 201 {
		t.Fatalf("create caro game: %d", code)
	}

	// Bob joins
	e.do("POST", "/api/messages/"+itoa(m.ID)+"/game", bob.Token, map[string]any{"action": "join"}, nil)

	// Carol sends a reply comment in the game thread
	wc := e.dial(carol.Token)
	wc.send(map[string]any{
		"type":       "message.send",
		"channel_id": ch.ID,
		"parent_id":  m.ID,
		"content":    "Trận này căng quá!",
		"client_id":  "c-comment-1",
	})
	ev := wc.waitFor("message.new")
	msgObj := ev["message"].(map[string]any)
	if msgObj["parent_id"].(float64) != float64(m.ID) {
		t.Fatalf("expected message to have parent_id %d", m.ID)
	}

	// Fetch thread
	var th struct {
		Parent  map[string]any   `json:"parent"`
		Replies []map[string]any `json:"replies"`
	}
	if code := e.do("GET", "/api/messages/"+itoa(m.ID)+"/thread", carol.Token, nil, &th); code != 200 {
		t.Fatalf("get thread: %d", code)
	}
	if len(th.Replies) != 1 {
		t.Fatalf("expected 1 reply, got %d", len(th.Replies))
	}
	replyUserID := int64(th.Replies[0]["user_id"].(float64))
	if replyUserID != carol.User.ID {
		t.Fatalf("expected reply from carol, got %d", replyUserID)
	}

	// Verify roles
	if role := controller.GetGameUserRole(nil, alice.User.ID, alice.User.ID); role != controller.RoleHost {
		t.Fatalf("expected alice to be RoleHost, got %v", role)
	}
	if role := controller.GetGameUserRole(nil, alice.User.ID, carol.User.ID); role != controller.RoleViewer {
		t.Fatalf("expected carol to be RoleViewer, got %v", role)
	}
}

func TestListLiveGames(t *testing.T) {
	e := newEnv(t)
	alice := e.register("alice", "Alice")
	bob := e.register("bob", "Bob")
	eve := e.register("eve", "Eve") // không join channel

	var ch channel
	e.do("POST", "/api/channels", alice.Token, map[string]any{"name": "test-live"}, &ch)
	e.do("POST", "/api/channels/"+itoa(ch.ID)+"/join", bob.Token, nil, nil)

	// 1. Kênh chưa có game nào
	var liveList []controller.LiveGameSummary
	if code := e.do("GET", "/api/channels/"+itoa(ch.ID)+"/live-games", alice.Token, nil, &liveList); code != 200 {
		t.Fatalf("list live games: %d", code)
	}
	if len(liveList) != 0 {
		t.Fatalf("expected 0 live games, got %d", len(liveList))
	}

	// 2. Eve không ở trong channel
	if code := e.do("GET", "/api/channels/"+itoa(ch.ID)+"/live-games", eve.Token, nil, nil); code != 404 && code != 403 {
		t.Fatalf("expected 403/404 for non-member, got %d", code)
	}

	// 3. Alice tạo ván xiangqi (chọn first: host)
	var m gameMsg
	if code := e.do("POST", "/api/channels/"+itoa(ch.ID)+"/games", alice.Token, map[string]any{
		"kind": "xiangqi",
		"options": map[string]any{"first": "host"},
	}, &m); code != 201 {
		t.Fatalf("create xiangqi: %d", code)
	}

	if code := e.do("GET", "/api/channels/"+itoa(ch.ID)+"/live-games", bob.Token, nil, &liveList); code != 200 {
		t.Fatalf("list live games: %d", code)
	}
	if len(liveList) != 1 {
		t.Fatalf("expected 1 live game, got %d", len(liveList))
	}
	item := liveList[0]
	if item.MessageID != m.ID || item.Kind != "xiangqi" || item.Status != "lobby" {
		t.Fatalf("unexpected live game item: %+v", item)
	}
	if item.Host.ID != alice.User.ID {
		t.Fatalf("expected host alice, got %d", item.Host.ID)
	}
	if item.IsMyTurn {
		t.Fatalf("expected is_my_turn = false for bob in lobby")
	}

	// 4. Bob join ván -> chuyển sang playing
	var g gameResp
	e.do("POST", "/api/messages/"+itoa(m.ID)+"/game", bob.Token, map[string]any{"action": "join"}, &g)
	if g.Status != "playing" {
		t.Fatalf("expected playing status, got %s", g.Status)
	}

	// 5. Kiểm tra live games khi playing
	var aliceLiveList []controller.LiveGameSummary
	e.do("GET", "/api/channels/"+itoa(ch.ID)+"/live-games", alice.Token, nil, &aliceLiveList)
	if len(aliceLiveList) != 1 || aliceLiveList[0].Status != "playing" {
		t.Fatalf("expected 1 playing game for alice: %+v", aliceLiveList)
	}
	// Xiangqi: Red đi trước (Host là Red: Alice)
	if !aliceLiveList[0].IsMyTurn {
		t.Fatalf("expected is_my_turn = true for alice (first turn red)")
	}

	var bobLiveList []controller.LiveGameSummary
	e.do("GET", "/api/channels/"+itoa(ch.ID)+"/live-games", bob.Token, nil, &bobLiveList)
	if len(bobLiveList) != 1 || bobLiveList[0].IsMyTurn {
		t.Fatalf("expected is_my_turn = false for bob (black)")
	}

	// 6. Alice resign -> ván kết thúc (ended)
	e.do("POST", "/api/messages/"+itoa(m.ID)+"/game", alice.Token, map[string]any{"action": "resign"}, nil)

	// 7. Gọi lại live games -> phải rỗng (0 ván)
	e.do("GET", "/api/channels/"+itoa(ch.ID)+"/live-games", alice.Token, nil, &liveList)
	if len(liveList) != 0 {
		t.Fatalf("expected 0 live games after game ended, got %d", len(liveList))
	}
}

func TestGameSpectators(t *testing.T) {
	e := newEnv(t)
	alice := e.register("alice_spec", "Alice")
	bob := e.register("bob_spec", "Bob")
	carol := e.register("carol_spec", "Carol")
	dave := e.register("dave_spec", "Dave")

	var ch channel
	e.do("POST", "/api/channels", alice.Token, map[string]any{"name": "spectator-test"}, &ch)
	e.do("POST", "/api/channels/"+itoa(ch.ID)+"/join", bob.Token, nil, nil)
	e.do("POST", "/api/channels/"+itoa(ch.ID)+"/join", carol.Token, nil, nil)
	e.do("POST", "/api/channels/"+itoa(ch.ID)+"/join", dave.Token, nil, nil)

	var m gameMsg
	if code := e.do("POST", "/api/channels/"+itoa(ch.ID)+"/games", alice.Token, map[string]any{"kind": "caro"}, &m); code != 201 {
		t.Fatalf("create game status: %d", code)
	}

	wc := e.dial(carol.Token)
	defer wc.conn.Close(websocket.StatusNormalClosure, "")

	wd := e.dial(dave.Token)

	// Carol spectates game
	wc.send(map[string]any{
		"type":       "game.spectate",
		"message_id": m.ID,
	})

	ev := wc.waitFor("game.spectators")
	if count, ok := ev["count"].(float64); !ok || int(count) != 1 {
		t.Fatalf("expected 1 spectator, got %v", ev["count"])
	}

	// Dave also spectates
	wd.send(map[string]any{
		"type":       "game.spectate",
		"message_id": m.ID,
	})
	ev2 := wc.waitFor("game.spectators")
	if count, ok := ev2["count"].(float64); !ok || int(count) != 2 {
		t.Fatalf("expected 2 spectators, got %v", ev2["count"])
	}

	// Check LiveGameSummary API reflects viewer_count
	var liveList []controller.LiveGameSummary
	e.do("GET", "/api/channels/"+itoa(ch.ID)+"/live-games", alice.Token, nil, &liveList)
	if len(liveList) != 1 || liveList[0].ViewerCount != 2 {
		t.Fatalf("expected viewer_count = 2 in API, got: %+v", liveList)
	}

	// Carol unspectates
	wc.send(map[string]any{
		"type":       "game.unspectate",
		"message_id": m.ID,
	})
	ev3 := wc.waitFor("game.spectators")
	if count, ok := ev3["count"].(float64); !ok || int(count) != 1 {
		t.Fatalf("expected 1 spectator after unspectate, got %v", ev3["count"])
	}

	// Dave disconnects socket unexpectedly
	wd.conn.Close(websocket.StatusGoingAway, "bye")
	ev4 := wc.waitFor("game.spectators")
	if count, ok := ev4["count"].(float64); !ok || int(count) != 0 {
		t.Fatalf("expected 0 spectators after dave disconnect, got %v", ev4["count"])
	}

	// Carol sends typing in thread with parent_id
	wc.send(map[string]any{
		"type":       "typing",
		"channel_id": ch.ID,
		"parent_id":  m.ID,
	})
	// typing sent without errors
}

func TestPlayerGameplayAnalytics(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()

	alice := e.register("alice_analyst", "Alice Analyst")
	bob := e.register("bob_analyst", "Bob Analyst")

	var ch channel
	e.do("POST", "/api/channels", alice.Token, map[string]any{"name": "analytics-channel"}, &ch)
	e.do("POST", "/api/channels/"+fmt.Sprint(ch.ID)+"/join", bob.Token, nil, nil)

	// 1. Tạo ván cờ tướng (Xiangqi) với nước mở Pháo đầu P2-5 M8+7
	xiangqiState, _ := json.Marshal(map[string]any{
		"players": []map[string]any{
			{"id": alice.User.ID, "name": alice.User.DisplayName},
			{"id": bob.User.ID, "name": bob.User.DisplayName},
		},
		"winners": []int64{alice.User.ID},
		"log": []string{
			"1. P2-5 M8+7",
			"2. M2+3 X9-8",
			"Chiếu bí! Đỏ thắng cuộc.",
		},
		"result": "Đỏ thắng",
	})
	_, err := e.st.CreateGame(ctx, ch.ID, alice.User.ID, model.Embed{Type: "game", ID: "xiangqi"}, "ended", xiangqiState)
	if err != nil {
		t.Fatalf("create xiangqi game: %v", err)
	}

	// Cập nhật rating Elo
	if _, _, err := e.st.RecordSoloGameResult(ctx, "xiangqi", alice.User.ID, bob.User.ID, 1.0); err != nil {
		t.Fatalf("record game result: %v", err)
	}

	// 2. Phân tích cờ tướng của Alice
	xqRep, err := e.st.AnalyzePlayerGameplay(ctx, alice.User.ID, "xiangqi")
	if err != nil {
		t.Fatalf("analyze xiangqi gameplay: %v", err)
	}
	if xqRep.Rating <= 1200 {
		t.Fatalf("expected rating > 1200 after win, got %d", xqRep.Rating)
	}
	if xqRep.Wins != 1 || xqRep.TotalGames != 1 {
		t.Fatalf("expected 1 win out of 1 game, got %+v", xqRep)
	}
	if xqRep.FirstTurnGames != 1 || xqRep.FirstTurnWins != 1 {
		t.Fatalf("expected 1 first turn win, got %+v", xqRep)
	}
	if len(xqRep.FavoriteOpenings) == 0 || xqRep.FavoriteOpenings[0] != "P2-5 M8+7" {
		t.Fatalf("expected favorite opening P2-5 M8+7, got %v", xqRep.FavoriteOpenings)
	}
	if !strings.Contains(xqRep.PlaystyleSummary, "Chiến tướng công sát trung lộ") {
		t.Fatalf("expected offensive archetype, got: %s", xqRep.PlaystyleSummary)
	}
	if len(xqRep.Strengths) == 0 || len(xqRep.Weaknesses) == 0 || len(xqRep.CounterTips) == 0 {
		t.Fatalf("missing tactical evaluation: %+v", xqRep)
	}
	if len(xqRep.RecentMatches) != 1 || !strings.Contains(xqRep.RecentMatches[0], "Thắng") {
		t.Fatalf("expected recent match win summary, got: %v", xqRep.RecentMatches)
	}

	// 3. Phân tích Cờ vua (Chess)
	chessState, _ := json.Marshal(map[string]any{
		"players": []map[string]any{
			{"id": alice.User.ID, "name": alice.User.DisplayName},
			{"id": bob.User.ID, "name": bob.User.DisplayName},
		},
		"winners": []int64{alice.User.ID},
		"log": []string{
			"1. e4 e5",
			"2. Nf3 Nc6",
		},
		"result": "Trắng thắng",
	})
	if _, err := e.st.CreateGame(ctx, ch.ID, alice.User.ID, model.Embed{Type: "game", ID: "chess"}, "ended", chessState); err != nil {
		t.Fatalf("create chess game: %v", err)
	}

	chessRep, err := e.st.AnalyzePlayerGameplay(ctx, alice.User.ID, "chess")
	if err != nil {
		t.Fatalf("analyze chess gameplay: %v", err)
	}
	if !strings.Contains(chessRep.PlaystyleSummary, "Kỳ thủ chiến thuật mở") {
		t.Fatalf("expected open chess archetype, got: %s", chessRep.PlaystyleSummary)
	}
	if len(chessRep.CounterTips) == 0 || !strings.Contains(chessRep.CounterTips[0], "Sicilian") {
		t.Fatalf("expected Sicilian counter tip, got: %v", chessRep.CounterTips)
	}

	// 4. Phân tích Caro
	caroRep, err := e.st.AnalyzePlayerGameplay(ctx, alice.User.ID, "caro")
	if err != nil {
		t.Fatalf("analyze caro gameplay: %v", err)
	}
	if !strings.Contains(caroRep.PlaystyleSummary, "Sát thủ bẫy kép Caro") {
		t.Fatalf("expected caro archetype, got: %s", caroRep.PlaystyleSummary)
	}
	if len(caroRep.CounterTips) == 0 || !strings.Contains(caroRep.CounterTips[0], "bịt các tia 3") {
		t.Fatalf("expected caro counter tip, got: %v", caroRep.CounterTips)
	}

	// 5. Phân tích Oẳn tù tì (RPS)
	rpsRep, err := e.st.AnalyzePlayerGameplay(ctx, alice.User.ID, "rps")
	if err != nil {
		t.Fatalf("analyze rps gameplay: %v", err)
	}
	if !strings.Contains(rpsRep.PlaystyleSummary, "Tâm lý học hành vi") {
		t.Fatalf("expected rps archetype, got: %s", rpsRep.PlaystyleSummary)
	}
	if len(rpsRep.CounterTips) == 0 || !strings.Contains(rpsRep.CounterTips[0], "Win-Stay Lose-Shift") {
		t.Fatalf("expected rps counter tip, got: %v", rpsRep.CounterTips)
	}
}



