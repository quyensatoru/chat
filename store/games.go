package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"

	"chat/game"
	"chat/model"
)

// GameRow: một ván đã lưu (state là JSON của package game).
type GameRow struct {
	MessageID int64
	ChannelID int64
	Kind      string
	State     []byte
}

// CreateGame tạo tin nhắn chứa ván chơi (embed type "game") cùng trạng thái ban đầu.
func (s *Store) CreateGame(ctx context.Context, channelID, userID int64, embed model.Embed, status string, state []byte) (model.Message, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return model.Message{}, err
	}
	defer tx.Rollback()
	e, err := json.Marshal(embed)
	if err != nil {
		return model.Message{}, err
	}
	var id int64
	if err := tx.QueryRowContext(ctx,
		`INSERT INTO messages (channel_id, user_id, content, embed) VALUES (?, ?, '', ?) RETURNING id`,
		channelID, userID, string(e)).Scan(&id); err != nil {
		return model.Message{}, err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO games (message_id, kind, status, state) VALUES (?, ?, ?, ?)`,
		id, embed.ID, status, string(state)); err != nil {
		return model.Message{}, err
	}
	if err := tx.Commit(); err != nil {
		return model.Message{}, err
	}
	return s.GetMessage(ctx, id)
}

// SaveGame ghi trạng thái mới của ván.
func (s *Store) SaveGame(ctx context.Context, messageID int64, status string, state []byte) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE games SET status = ?, state = ?, updated_at = CURRENT_TIMESTAMP WHERE message_id = ?`,
		status, string(state), messageID)
	return err
}

// GetGame đọc ván gắn với tin messageID (ErrNotFound nếu không có hoặc tin đã xoá).
func (s *Store) GetGame(ctx context.Context, messageID int64) (GameRow, error) {
	g := GameRow{MessageID: messageID}
	var state string
	err := s.db.QueryRowContext(ctx, `
		SELECT m.channel_id, g.kind, g.state FROM games g JOIN messages m ON m.id = g.message_id
		WHERE g.message_id = ? AND m.deleted_at IS NULL`, messageID).Scan(&g.ChannelID, &g.Kind, &state)
	g.State = []byte(state)
	return g, notFound(err)
}

// ActiveGames: các ván chưa kết thúc (nạp lại khi server khởi động để chạy tiếp đồng hồ).
func (s *Store) ActiveGames(ctx context.Context) ([]GameRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT g.message_id, m.channel_id, g.kind, g.state FROM games g JOIN messages m ON m.id = g.message_id
		WHERE g.status <> 'ended' AND m.deleted_at IS NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []GameRow
	for rows.Next() {
		var g GameRow
		var state string
		if err := rows.Scan(&g.MessageID, &g.ChannelID, &g.Kind, &state); err != nil {
			return nil, err
		}
		g.State = []byte(state)
		out = append(out, g)
	}
	return out, rows.Err()
}

// ActiveGamesByChannel trả về danh sách các ván game chưa kết thúc trong một kênh cụ thể.
func (s *Store) ActiveGamesByChannel(ctx context.Context, channelID int64) ([]GameRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT g.message_id, m.channel_id, g.kind, g.state 
		FROM games g 
		JOIN messages m ON m.id = g.message_id
		WHERE m.channel_id = ? 
		  AND g.status IN ('lobby', 'playing') 
		  AND m.deleted_at IS NULL
		ORDER BY m.id DESC`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []GameRow
	for rows.Next() {
		var g GameRow
		var state string
		if err := rows.Scan(&g.MessageID, &g.ChannelID, &g.Kind, &state); err != nil {
			return nil, err
		}
		g.State = []byte(state)
		out = append(out, g)
	}
	return out, rows.Err()
}

type MemberGameStats struct {
	UserID        int64   `json:"user_id"`
	Username      string  `json:"username"`
	DisplayName   string  `json:"display_name"`
	Avatar        *string `json:"avatar"`
	Rating        int     `json:"rating"`
	PeakRating    int     `json:"peak_rating"`
	RankTier      string  `json:"rank_tier"`
	TierBadge     string  `json:"tier_badge"`
	Wins          int     `json:"wins"`
	Losses        int     `json:"losses"`
	Draws         int     `json:"draws"`
	TotalGames    int     `json:"total_games"`
	WinRate       float64 `json:"win_rate"`
	CurrentStreak int     `json:"current_streak"`
	BestStreak    int     `json:"best_streak"`
}

type LeaderboardResponse struct {
	Kind       string            `json:"kind"`
	TopWins    []MemberGameStats `json:"top_wins"`
	TopLosses  []MemberGameStats `json:"top_losses"`
	Members    []MemberGameStats `json:"members"`
	TotalEnded int               `json:"total_ended"`
}

type gameSummaryState struct {
	Players []struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	} `json:"players"`
	Winners []int64 `json:"winners"`
}

// GetGameLeaderboard tổng hợp bảng xếp hạng thành viên dựa trên các ván chơi đã kết thúc.
func (s *Store) GetGameLeaderboard(ctx context.Context, kind string) (LeaderboardResponse, error) {
	query := `
		SELECT g.kind, g.state
		FROM games g
		JOIN messages m ON m.id = g.message_id
		WHERE g.status = 'ended' AND m.deleted_at IS NULL`
	var args []any
	if kind != "" && kind != "all" {
		query += " AND g.kind = ?"
		args = append(args, kind)
	}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return LeaderboardResponse{}, err
	}
	defer rows.Close()

	type rawStats struct {
		id       int64
		fallback string
		wins     int
		losses   int
		draws    int
		total    int
	}

	statsMap := make(map[int64]*rawStats)
	var totalEnded int

	for rows.Next() {
		var gKind string
		var stateStr string
		if err := rows.Scan(&gKind, &stateStr); err != nil {
			return LeaderboardResponse{}, err
		}
		totalEnded++

		var sum gameSummaryState
		if err := json.Unmarshal([]byte(stateStr), &sum); err != nil {
			continue
		}

		if len(sum.Players) == 0 {
			continue
		}

		for _, p := range sum.Players {
			if _, ok := statsMap[p.ID]; !ok {
				statsMap[p.ID] = &rawStats{id: p.ID, fallback: p.Name}
			}
		}

		if len(sum.Winners) == 0 {
			for _, p := range sum.Players {
				st := statsMap[p.ID]
				st.draws++
				st.total++
			}
		} else {
			winSet := make(map[int64]bool, len(sum.Winners))
			for _, wid := range sum.Winners {
				winSet[wid] = true
				if st, ok := statsMap[wid]; ok {
					st.wins++
					st.total++
				}
			}
			for _, p := range sum.Players {
				if !winSet[p.ID] {
					st := statsMap[p.ID]
					st.losses++
					st.total++
				}
			}
		}
	}
	if err := rows.Err(); err != nil {
		return LeaderboardResponse{}, err
	}

	userMap := make(map[int64]struct {
		username    string
		displayName string
		avatar      *string
	})

	if len(statsMap) > 0 {
		uRows, err := s.db.QueryContext(ctx, `SELECT id, username, display_name, avatar FROM users`)
		if err == nil {
			defer uRows.Close()
			for uRows.Next() {
				var uid int64
				var un, dn string
				var av *string
				if err := uRows.Scan(&uid, &un, &dn, &av); err == nil {
					userMap[uid] = struct {
						username    string
						displayName string
						avatar      *string
					}{username: un, displayName: dn, avatar: av}
				}
			}
		}
	}

	type ratingStats struct {
		rating        int
		peakRating    int
		currentStreak int
		bestStreak    int
	}
	ratingsMap := make(map[int64]ratingStats)
	rQuery := `SELECT user_id, rating, peak_rating, current_streak, best_streak FROM game_ratings`
	var rArgs []any
	if kind != "" && kind != "all" {
		rQuery += " WHERE kind = ?"
		rArgs = append(rArgs, kind)
	}
	rRows, err := s.db.QueryContext(ctx, rQuery, rArgs...)
	if err == nil {
		defer rRows.Close()
		for rRows.Next() {
			var uid int64
			var r, peak, curS, bestS int
			if err := rRows.Scan(&uid, &r, &peak, &curS, &bestS); err == nil {
				ratingsMap[uid] = ratingStats{rating: r, peakRating: peak, currentStreak: curS, bestStreak: bestS}
			}
		}
	}

	members := make([]MemberGameStats, 0, len(statsMap))
	for id, st := range statsMap {
		dn := st.fallback
		un := ""
		var av *string
		if u, ok := userMap[id]; ok {
			un = u.username
			if u.displayName != "" {
				dn = u.displayName
			} else if u.username != "" {
				dn = u.username
			}
			av = u.avatar
		}

		var wr float64
		if st.total > 0 {
			wr = math.Round((float64(st.wins)/float64(st.total)*100)*10) / 10
		}

		r := game.DefaultEloRating
		peak := game.DefaultEloRating
		var curS, bestS int
		if rs, ok := ratingsMap[id]; ok {
			r = rs.rating
			peak = rs.peakRating
			curS = rs.currentStreak
			bestS = rs.bestStreak
		}
		tier := game.GetRankTier(r)

		members = append(members, MemberGameStats{
			UserID:        id,
			Username:      un,
			DisplayName:   dn,
			Avatar:        av,
			Rating:        r,
			PeakRating:    peak,
			RankTier:      tier.Name,
			TierBadge:     tier.Badge,
			Wins:          st.wins,
			Losses:        st.losses,
			Draws:         st.draws,
			TotalGames:    st.total,
			WinRate:       wr,
			CurrentStreak: curS,
			BestStreak:    bestS,
		})
	}

	sort.Slice(members, func(i, j int) bool {
		if members[i].Rating != members[j].Rating {
			return members[i].Rating > members[j].Rating
		}
		if members[i].Wins != members[j].Wins {
			return members[i].Wins > members[j].Wins
		}
		if members[i].WinRate != members[j].WinRate {
			return members[i].WinRate > members[j].WinRate
		}
		return members[i].TotalGames > members[j].TotalGames
	})

	topWinsList := make([]MemberGameStats, len(members))
	copy(topWinsList, members)
	sort.Slice(topWinsList, func(i, j int) bool {
		if topWinsList[i].Wins != topWinsList[j].Wins {
			return topWinsList[i].Wins > topWinsList[j].Wins
		}
		return topWinsList[i].TotalGames < topWinsList[j].TotalGames
	})
	if len(topWinsList) > 10 {
		topWinsList = topWinsList[:10]
	}

	topLossesList := make([]MemberGameStats, len(members))
	copy(topLossesList, members)
	sort.Slice(topLossesList, func(i, j int) bool {
		if topLossesList[i].Losses != topLossesList[j].Losses {
			return topLossesList[i].Losses > topLossesList[j].Losses
		}
		return topLossesList[i].TotalGames > topLossesList[j].TotalGames
	})
	if len(topLossesList) > 10 {
		topLossesList = topLossesList[:10]
	}

	if kind == "" {
		kind = "caro"
	}

	return LeaderboardResponse{
		Kind:       kind,
		TopWins:    topWinsList,
		TopLosses:  topLossesList,
		Members:    members,
		TotalEnded: totalEnded,
	}, nil
}

// RecordSoloGameResult cập nhật điểm Elo và thành tích cho 2 người chơi trong game đối kháng.
func (s *Store) RecordSoloGameResult(ctx context.Context, kind string, playerAID, playerBID int64, scoreA float64) (deltaA, deltaB int, err error) {
	if playerAID == playerBID {
		return 0, 0, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()

	// Đọc stats của player A
	var ratingA, peakA, winsA, lossesA, drawsA, cStreakA, bStreakA int
	errA := tx.QueryRowContext(ctx,
		`SELECT rating, peak_rating, wins, losses, draws, current_streak, best_streak FROM game_ratings WHERE user_id = ? AND kind = ?`,
		playerAID, kind).Scan(&ratingA, &peakA, &winsA, &lossesA, &drawsA, &cStreakA, &bStreakA)
	if errors.Is(errA, sql.ErrNoRows) {
		ratingA = game.DefaultEloRating
		peakA = game.DefaultEloRating
	} else if errA != nil {
		return 0, 0, errA
	}
	totA := winsA + lossesA + drawsA

	// Đọc stats của player B
	var ratingB, peakB, winsB, lossesB, drawsB, cStreakB, bStreakB int
	errB := tx.QueryRowContext(ctx,
		`SELECT rating, peak_rating, wins, losses, draws, current_streak, best_streak FROM game_ratings WHERE user_id = ? AND kind = ?`,
		playerBID, kind).Scan(&ratingB, &peakB, &winsB, &lossesB, &drawsB, &cStreakB, &bStreakB)
	if errors.Is(errB, sql.ErrNoRows) {
		ratingB = game.DefaultEloRating
		peakB = game.DefaultEloRating
	} else if errB != nil {
		return 0, 0, errB
	}
	totB := winsB + lossesB + drawsB

	// Tính toán Elo mới qua game.CalculateElo
	newRatingA, dA, newRatingB, dB := game.CalculateElo(ratingA, totA, ratingB, totB, scoreA)

	// Cập nhật stats A
	if scoreA == 1.0 {
		winsA++
		cStreakA++
		if cStreakA > bStreakA {
			bStreakA = cStreakA
		}
	} else if scoreA == 0.0 {
		lossesA++
		cStreakA = 0
	} else {
		drawsA++
	}
	if newRatingA > peakA {
		peakA = newRatingA
	}

	// Cập nhật stats B
	scoreB := 1.0 - scoreA
	if scoreB == 1.0 {
		winsB++
		cStreakB++
		if cStreakB > bStreakB {
			bStreakB = cStreakB
		}
	} else if scoreB == 0.0 {
		lossesB++
		cStreakB = 0
	} else {
		drawsB++
	}
	if newRatingB > peakB {
		peakB = newRatingB
	}

	// Upsert A vào game_ratings
	_, err = tx.ExecContext(ctx, `
		INSERT INTO game_ratings (user_id, kind, rating, peak_rating, wins, losses, draws, current_streak, best_streak, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT (user_id, kind) DO UPDATE SET
			rating = excluded.rating,
			peak_rating = excluded.peak_rating,
			wins = excluded.wins,
			losses = excluded.losses,
			draws = excluded.draws,
			current_streak = excluded.current_streak,
			best_streak = excluded.best_streak,
			updated_at = CURRENT_TIMESTAMP`,
		playerAID, kind, newRatingA, peakA, winsA, lossesA, drawsA, cStreakA, bStreakA)
	if err != nil {
		return 0, 0, err
	}

	// Upsert B vào game_ratings
	_, err = tx.ExecContext(ctx, `
		INSERT INTO game_ratings (user_id, kind, rating, peak_rating, wins, losses, draws, current_streak, best_streak, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT (user_id, kind) DO UPDATE SET
			rating = excluded.rating,
			peak_rating = excluded.peak_rating,
			wins = excluded.wins,
			losses = excluded.losses,
			draws = excluded.draws,
			current_streak = excluded.current_streak,
			best_streak = excluded.best_streak,
			updated_at = CURRENT_TIMESTAMP`,
		playerBID, kind, newRatingB, peakB, winsB, lossesB, drawsB, cStreakB, bStreakB)
	if err != nil {
		return 0, 0, err
	}

	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}

	return dA, dB, nil
}

// GetUserRating đọc điểm Elo của người chơi cho một loại game.
func (s *Store) GetUserRating(ctx context.Context, userID int64, kind string) (int, error) {
	var rating int
	err := s.db.QueryRowContext(ctx, `SELECT rating FROM game_ratings WHERE user_id = ? AND kind = ?`, userID, kind).Scan(&rating)
	if errors.Is(err, sql.ErrNoRows) {
		return game.DefaultEloRating, nil
	}
	return rating, err
}

// PlayerGameplayReport chứa kết quả phân tích dữ liệu lối chơi và chiến thuật của người chơi.
type PlayerGameplayReport struct {
	UserID           int64    `json:"user_id"`
	PlayerName       string   `json:"player_name"`
	Username         string   `json:"username"`
	GameKind         string   `json:"game_kind"`
	Rating           int      `json:"rating"`
	PeakRating       int      `json:"peak_rating"`
	RankTier         string   `json:"rank_tier"`
	TierBadge        string   `json:"tier_badge"`
	TotalGames       int      `json:"total_games"`
	Wins             int      `json:"wins"`
	Losses           int      `json:"losses"`
	Draws            int      `json:"draws"`
	WinRate          float64  `json:"win_rate"`
	CurrentStreak    int      `json:"current_streak"`
	BestStreak       int      `json:"best_streak"`
	FirstTurnGames   int      `json:"first_turn_games"`
	FirstTurnWins    int      `json:"first_turn_wins"`
	SecondTurnGames  int      `json:"second_turn_games"`
	SecondTurnWins   int      `json:"second_turn_wins"`
	FavoriteOpenings []string `json:"favorite_openings"`
	PlaystyleSummary string   `json:"playstyle_summary"`
	Strengths        []string `json:"strengths"`
	Weaknesses       []string `json:"weaknesses"`
	CounterTips      []string `json:"counter_tips"`
	RecentMatches    []string `json:"recent_matches"`
}

// AnalyzePlayerGameplay đọc CSDL và phân tích chuyên sâu phong cách chơi theo từng game.
func (s *Store) AnalyzePlayerGameplay(ctx context.Context, userID int64, kind string) (PlayerGameplayReport, error) {
	user, err := s.GetUserByID(ctx, userID)
	if err != nil {
		return PlayerGameplayReport{}, err
	}

	name := user.DisplayName
	if name == "" {
		name = user.Username
	}

	if kind == "" || kind == "all" {
		kind = "xiangqi" // Mặc định môn cờ tướng nếu không chỉ định
	}

	report := PlayerGameplayReport{
		UserID:     userID,
		PlayerName: name,
		Username:   user.Username,
		GameKind:   kind,
		Rating:     game.DefaultEloRating,
		PeakRating: game.DefaultEloRating,
	}

	// 1. Đọc chỉ số Elo & streak từ game_ratings
	var r, peak, wins, losses, draws, curS, bestS int
	errR := s.db.QueryRowContext(ctx,
		`SELECT rating, peak_rating, wins, losses, draws, current_streak, best_streak FROM game_ratings WHERE user_id = ? AND kind = ?`,
		userID, kind).Scan(&r, &peak, &wins, &losses, &draws, &curS, &bestS)
	if errR == nil {
		report.Rating = r
		report.PeakRating = peak
		report.Wins = wins
		report.Losses = losses
		report.Draws = draws
		report.CurrentStreak = curS
		report.BestStreak = bestS
		tot := wins + losses + draws
		report.TotalGames = tot
		if tot > 0 {
			report.WinRate = math.Round((float64(wins)/float64(tot)*100)*10) / 10
		}
	}
	tier := game.GetRankTier(report.Rating)
	report.RankTier = tier.Name
	report.TierBadge = tier.Badge

	// 2. Đọc các ván chơi gần nhất từ CSDL để phân tích nước đi và chiến thuật
	query := `
		SELECT g.message_id, g.kind, g.state
		FROM games g
		JOIN messages m ON m.id = g.message_id
		WHERE g.status = 'ended' AND m.deleted_at IS NULL
		ORDER BY g.updated_at DESC
		LIMIT 100`

	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return report, err
	}
	defer rows.Close()

	type rawState struct {
		Players []struct {
			ID   int64  `json:"id"`
			Name string `json:"name"`
		} `json:"players"`
		Winners []int64  `json:"winners"`
		Log     []string `json:"log"`
		Result  string   `json:"result"`
	}

	openingMap := make(map[string]int)
	matchesCount := 0

	for rows.Next() {
		var mid int64
		var gKind, stateStr string
		if err := rows.Scan(&mid, &gKind, &stateStr); err != nil {
			continue
		}

		if kind != "all" && gKind != kind {
			continue
		}

		var st rawState
		if err := json.Unmarshal([]byte(stateStr), &st); err != nil {
			continue
		}

		// Kiểm tra user có tham gia ván này không
		pIdx := -1
		for i, p := range st.Players {
			if p.ID == userID {
				pIdx = i
				break
			}
		}
		if pIdx < 0 {
			continue
		}

		matchesCount++
		isWinner := false
		for _, w := range st.Winners {
			if w == userID {
				isWinner = true
				break
			}
		}

		if pIdx == 0 {
			report.FirstTurnGames++
			if isWinner {
				report.FirstTurnWins++
			}
		} else {
			report.SecondTurnGames++
			if isWinner {
				report.SecondTurnWins++
			}
		}

		// Trích xuất nước cờ khai cuộc từ nhật ký log
		for _, l := range st.Log {
			if strings.HasPrefix(l, "1. ") || strings.HasPrefix(l, "Vòng 1") || strings.Contains(l, "Ván 1:") {
				parts := strings.Fields(l)
				if len(parts) >= 2 {
					op := parts[1]
					if len(parts) >= 3 && (gKind == "xiangqi" || gKind == "chess") {
						op = parts[1] + " " + parts[2]
					}
					openingMap[op]++
				}
				break
			}
		}

		// Lưu 3 ván gần nhất vào RecentMatches
		if len(report.RecentMatches) < 3 {
			resText := "Thua"
			if isWinner {
				resText = "Thắng"
			} else if len(st.Winners) == 0 {
				resText = "Hoà"
			}
			oppName := "Đối thủ"
			for _, p := range st.Players {
				if p.ID != userID {
					oppName = p.Name
					break
				}
			}
			report.RecentMatches = append(report.RecentMatches,
				fmt.Sprintf("Ván #%d (%s): %s trước %s", mid, gKind, resText, oppName))
		}
	}

	// Xếp hạng khai cuộc phổ biến
	for op := range openingMap {
		report.FavoriteOpenings = append(report.FavoriteOpenings, op)
	}
	sort.Slice(report.FavoriteOpenings, func(i, j int) bool {
		return openingMap[report.FavoriteOpenings[i]] > openingMap[report.FavoriteOpenings[j]]
	})
	if len(report.FavoriteOpenings) > 3 {
		report.FavoriteOpenings = report.FavoriteOpenings[:3]
	}

	// 3. Phân tích phong cách & chiến thuật theo từng môn game
	switch kind {
	case "xiangqi":
		hasCannon := false
		for _, op := range report.FavoriteOpenings {
			if strings.Contains(op, "P") || strings.Contains(op, "Pháo") {
				hasCannon = true
				break
			}
		}
		if hasCannon || len(report.FavoriteOpenings) == 0 {
			report.PlaystyleSummary = "Chiến tướng công sát trung lộ (Thích dùng Pháo đầu tấn công hỏa lực dồn dập, đẩy nhịp độ trận đấu lên rất cao)."
			report.Strengths = []string{
				"Sức ép trung lộ cực lớn, phối hợp Xe-Pháo kích sát nhạy bén",
				"Chớp thời cơ chiếu bí đối phương nhanh chóng khi cờ đối phương hở sườn",
			}
			report.Weaknesses = []string{
				"Dâng quân quá sớm đôi khi để lộ sơ hở hai cánh",
				"Tỷ lệ mất lợi thế nếu đối phương phòng thủ chặt chẽ bằng Bình phong mã",
			}
			report.CounterTips = []string{
				"Khuyên dùng Bình phong mã (M8+7, M2+3) để bọc lót trung lộ vững chắc",
				"Chủ động ghìm lộ Xe đối phương và kiên nhẫn phản công khi họ dâng Pháo quá sâu",
			}
		} else {
			report.PlaystyleSummary = "Bậc thầy phản kích trận địa (Lối cờ kín kẽ, phát triển Mã và Tượng vững chãi, chờ đối thủ nôn nóng sơ hở)."
			report.Strengths = []string{
				"Hàng thủ Cửu cung kiên cố, khả năng kiểm soát thế cờ tàn cuộc rất tốt",
				"Rất ít khi dính bẫy pháo đầu sơ đẳng",
			}
			report.Weaknesses = []string{
				"Khai cuộc có phần thụ động, dễ bị đối phương áp đặt thế trận",
			}
			report.CounterTips = []string{
				"Tích cực kiểm soát hà, đưa Chốt qua sông sớm để thu hẹp không gian của đối thủ",
			}
		}

	case "chess":
		report.PlaystyleSummary = "Kỳ thủ chiến thuật mở (Ưa thích kiểm soát trung tâm, điều phối quân nhẹ hỗ trợ nhập thành linh hoạt)."
		report.Strengths = []string{
			"Nắm vững nguyên tắc khai cuộc chuẩn FIDE",
			"Tận dụng tốt ưu thế khi được cầm quân Trắng (đi trước)",
		}
		report.Weaknesses = []string{
			"Gặp khó khăn khi bị đối phương kéo vào thế trận tàn cuộc cờ kín phức tạp",
		}
		report.CounterTips = []string{
			"Nếu đối phương đi 1.e4, hãy cân nhắc phòng thủ Sicilian (1...c5) để phá vỡ cấu trúc quen thuộc",
		}

	case "caro":
		report.PlaystyleSummary = "Sát thủ bẫy kép Caro (Chuyên tạo các mũi tấn công 3-3, 4-3 bất ngờ từ các đường chéo dài)."
		report.Strengths = []string{
			"Nhìn bao quát bàn cờ cực tốt, khả năng gài thế cờ đôi rất nhạy",
			"Tỷ lệ thắng áp đảo khi cầm quân X đi trước",
		}
		report.Weaknesses = []string{
			"Khả năng phòng thủ khi cầm O (đi sau) có dấu hiệu dễ nóng vội",
		}
		report.CounterTips = []string{
			"Bám sát từng nước cờ, chủ động bịt các tia 3 mở ngay từ sớm, không cho tạo thế rình rập",
		}

	case "rps":
		report.PlaystyleSummary = "Tâm lý học hành vi (Thói quen ra tay theo chu kỳ phản ứng kết quả)."
		report.Strengths = []string{"Khả năng đổi nhịp tay nhanh chóng sau mỗi hiệp"}
		report.Weaknesses = []string{"Xu hướng ra lại nước thắng cũ khi đang trên đà hưng phấn"}
		report.CounterTips = []string{"Áp dụng chiến thuật Win-Stay Lose-Shift để đoán trước nước đi tiếp theo"}

	default:
		report.PlaystyleSummary = "Đa năng, thích ứng nhanh với nhiều thể loại game khác nhau."
		report.Strengths = []string{"Kinh nghiệm thực chiến phong phú trên nhiều đấu trường"}
		report.Weaknesses = []string{"Chưa tập trung chuyên sâu một môn cờ để đạt mức Đại Kiện Tướng"}
		report.CounterTips = []string{"Đưa người chơi vào môn cờ sở đoản của họ để chiếm ưu thế"}
	}

	return report, nil
}
