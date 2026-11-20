# Đặc Tả Kỹ Thuật (SPEC): Hệ Thống Đánh Giá Điểm Số Xếp Hạng Elo Cho Game Đối Kháng 2 Người

- **Mã tính năng**: `SOLO-GAMES-RATING`
- **Tác giả**: Antigravity (DeepMind Team)
- **Trạng thái**: ✅ Đã triển khai (Implemented & Verified)
- **Ngày tạo**: 2026-11-20
- **Thư mục liên quan**:
  - Backend: `game/`, `store/games.go`, `store/schema.go`, `controller/games.go`, `controller/api.go`
  - Frontend: `desktop/src/components/Games.tsx`, `desktop/src/lib/api.ts`, `desktop/src/components/XiangqiGame.tsx`, `desktop/src/styles.css`

---

## 1. Mục Tiêu & Phạm Vi (Goals & Scope)

### 1.1 Mục tiêu (Goals)
1. **Đánh giá trình độ công bằng (Standard Elo Rating)**: Tính toán và cập nhật điểm xếp hạng (Rating / Elo) cho các trò chơi solo đối kháng 2 người:
   - Cờ Caro (`caro`)
   - Cờ Tướng (`xiangqi`)
   - Cờ Vua (`chess`)
   - Kéo Búa Bao (`rps`)
2. **Cập nhật tự động sau mỗi ván đấu**: Khi ván đấu chuyển trạng thái `ended`, hệ thống tự động:
   - Tính toán biến thiên điểm ($\Delta Elo$) giữa Người chơi A và B theo công thức Elo tiêu chuẩn của FIDE.
   - Lưu trữ điểm số tích luỹ, tổng số ván thắng/thua/hòa, chuỗi thắng và đỉnh điểm (Peak Rating) vào cơ sở dữ liệu SQLite.
3. **Phân cấp bậc xếp hạng (Rank Tiers & Badges)**:
   - 🥉 **Tập Sự / Đồng (Bronze)**: 0 - 1199 Elo
   - 🥈 **Bạc (Silver)**: 1200 - 1399 Elo (Mức mặc định khi bắt đầu: 1200)
   - 🥇 **Vàng (Gold)**: 1400 - 1599 Elo
   - 💎 **Bạch Kim (Platinum)**: 1600 - 1799 Elo
   - 👑 **Kim Cương (Diamond)**: 1800 - 1999 Elo
   - 🌟 **Đại Kiện Tướng (Grandmaster)**: ≥ 2000 Elo
4. **Bảng xếp hạng TOP Vinh Danh (Leaderboard Upgrade)**:
   - Bảng xếp hạng theo từng môn cờ và bảng tổng hợp, sắp xếp ưu tiên theo Rating Elo cao nhất.
   - Hiển thị Huy hiệu Rank Tier, điểm Elo, tỷ lệ thắng (Win Rate), số trận thắng/thua.
   - Hiển thị thông tin Rank/Elo của người chơi ngay trên bàn cờ khi thi đấu.

### 1.2 Không thuộc phạm vi (Non-Goals)
- Không áp dụng Elo cá nhân cho các game nhiều người (như Ma Sói `werewolf` hay Trạm Vũ Trụ `station`) trong v1 này (chỉ áp dụng cho các game solo 2 người).

---

## 2. Kiến Trúc & Công Thức Tính Điểm (Domain Logic & Formulas)

### 2.1 Công Thức Tính Điểm Elo Chuẩn

Giả sử Người chơi A (Rating $R_A$) gặp Người chơi B (Rating $R_B$):

1. **Xác suất thắng kỳ vọng (Expected Score)**:
   $$E_A = \frac{1}{1 + 10^{(R_B - R_A) / 400}}$$
   $$E_B = \frac{1}{1 + 10^{(R_A - R_B) / 400}} = 1 - E_A$$

2. **Kết quả thực tế ($S$)**:
   - $S = 1.0$: Thắng trận (Win)
   - $S = 0.5$: Hòa trận (Draw)
   - $S = 0.0$: Thua trận (Loss)

3. **Hệ số biến thiên $K$ (K-factor)**:
   - $K = 32$ mặc định để điểm số biến thiên nhanh và phản ánh đúng trình độ sau vài trận đầu.
   - Khi kỳ thủ đã có trên 30 trận: $K = 24$.

4. **Điểm mới sau trận đấu ($R'$)**:
   $$R'_A = \text{round}(R_A + K \times (S_A - E_A))$$
   $$R'_B = \text{round}(R_B + K \times (S_B - E_B))$$
   - Điểm sàn tối thiểu: `100` Elo (không bị âm điểm).

---

## 3. Mô Hình Dữ Liệu & API Contracts

### 3.1 Bảng Cơ Sở Dữ Liệu SQLite (`game_ratings`)

```sql
CREATE TABLE IF NOT EXISTS game_ratings (
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,                -- 'caro', 'xiangqi', 'chess', 'rps'
    rating INTEGER NOT NULL DEFAULT 1200,
    peak_rating INTEGER NOT NULL DEFAULT 1200,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    current_streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL,
    PRIMARY KEY (user_id, kind),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_game_ratings_kind_rating ON game_ratings(kind, rating DESC);
```

### 3.2 Struct Dữ Liệu Backend (`store/games.go`)

```go
type UserGameRating struct {
    UserID        int64   `json:"user_id"`
    Kind          string  `json:"kind"`
    Rating        int     `json:"rating"`
    PeakRating    int     `json:"peak_rating"`
    RankTier      string  `json:"rank_tier"`       // "Bronze", "Silver", "Gold", "Platinum", "Diamond", "Grandmaster"
    TierBadge     string  `json:"tier_badge"`      // "🥉", "🥈", "🥇", "💎", "👑", "🌟"
    Wins          int     `json:"wins"`
    Losses        int     `json:"losses"`
    Draws         int     `json:"draws"`
    TotalGames    int     `json:"total_games"`
    WinRate       float64 `json:"win_rate"`
    CurrentStreak int     `json:"current_streak"`
    BestStreak    int     `json:"best_streak"`
}
```

### 3.3 API Contracts

- **GET `/api/games/leaderboard?kind={caro|xiangqi|chess|rps|all}`**
  - Trả về danh sách xếp hạng có kèm theo `rating`, `rank_tier`, `tier_badge`.
  - Danh sách sắp xếp theo `rating DESC, wins DESC`.

- **GET `/api/games/ratings?user_id={id}` (Tuỳ chọn)**:
  - Xem hồ sơ thành tích và Elo của người chơi theo từng môn cờ.

---

## 4. Quy Tắc Nghiệp Vụ & Xử Lý Trường Hợp Biên

| Trường hợp | Xử lý |
|:---|:---|
| 1. Người chơi mới chưa từng đấu | Gán Elo khởi đầu = 1200 (Rank Bạc). |
| 2. Trận đấu bị hủy hoặc xóa tin nhắn khi chưa kết thúc | Không tính điểm Elo. Chỉ tính điểm khi game có `status == 'ended'`. |
| 3. Chênh lệch điểm lớn (Ví dụ: 1200 gặp 1800) | Công thức Elo tự động bảo vệ: người 1800 thắng chỉ nhận được rất ít điểm (+2 hoặc +3), nếu người 1200 tạo bất ngờ thắng sẽ nhận điểm tối đa (+30). |
| 4. Ván cờ hòa | Cả 2 nhận $S=0.5$. Người có rating thấp hơn vẫn sẽ được cộng nhẹ điểm từ người rating cao hơn. |
| 5. Đánh với chính mình (Test/Solo) | Nếu `playerA.ID == playerB.ID`, bỏ qua việc tính điểm Elo. |

---

## 5. Thiết Kế Giao Diện Người Dùng (UI / UX)

### 5.1 Bảng Xếp Hạng TOP (Leaderboard Dialog)
- Tab lọc theo game: `Tất Cả`, `Cờ Tướng`, `Cờ Vua`, `Cờ Caro`, `Kéo Búa Bao`.
- Cột thông tin:
  - Hạng (Rank 1, 2, 3 với cúp Vàng/Bạc/Đồng).
  - Người chơi (Avatar + Tên hiển thị).
  - **Cấp Bậc & Elo** (Ví dụ: `🌟 2045 Đại Kiện Tướng` hoặc `🥇 1520 Vàng`).
  - Thắng / Hòa / Thua (`15W - 3D - 2L`).
  - Tỷ lệ thắng (`83.3%`).
  - Chuỗi thắng (`🔥 5 trận`).

### 5.2 Bàn Cờ Thi Đấu
- Ngay tại avatar của hai người chơi trên bàn cờ (`XiangqiGame.tsx`, `Games.tsx`), hiển thị huy hiệu Rank và điểm Elo (Ví dụ: `Alice (1350 🥈)`).
- Khi trận đấu kết thúc, popup chiến thắng hiển thị thêm thông tin biến thiên điểm số: `+18 Elo (1368 🥈)`.

---

## 6. Kế Hoạch Triển Khai Từng Bước (Implementation Checklist)

- [x] **Giai đoạn 1: Backend Elo Engine & Database Schema**
  - [x] Tạo bảng `game_ratings` và migration trong `database/migrations/000017_game_ratings.up.sql`.
  - [x] Xây dựng thuật toán tính Elo chuẩn trong package `game/elo.go` kèm unit test `game/elo_test.go`.
  - [x] Tích hợp tính Elo và cập nhật `game_ratings` trong `store/games.go` khi kết thúc ván chơi.
  - [x] Nâng cấp `GetGameLeaderboard` để lấy danh sách từ `game_ratings` với đầy đủ tier badge, peak rating, win rate.
- [x] **Giai đoạn 2: API & Controller Integration**
  - [x] Cập nhật controller `controller/games.go` hỗ trợ xếp hạng Elo cho API `GET /api/games/leaderboard`.
  - [x] Viết unit tests kiểm thử luồng kết thúc ván đấu và cập nhật bảng xếp hạng trong `controller/games_test.go`.
- [x] **Giai đoạn 3: Frontend UI Components**
  - [x] Nâng cấp kiểu dữ liệu `GameLeaderboard` và `GameMemberStats` trong [desktop/src/lib/api.ts](file:///Users/hoang.nguyen3/tidebird/chat/desktop/src/lib/api.ts).
  - [x] Cập nhật giao diện `GameLeaderboardDialog` trong [desktop/src/components/Games.tsx](file:///Users/hoang.nguyen3/tidebird/chat/desktop/src/components/Games.tsx) hiển thị Rank Tier, Elo, và huy hiệu.
  - [x] Hiển thị Elo của người chơi trên bảng xếp hạng và giao diện thi đấu.
- [x] **Giai đoạn 4: Xác Thực Toàn Diện**
  - [x] Chạy `go test ./...`.
  - [x] Chạy `pnpm build`.
  - [x] Chạy `make verify` pass 5/5 tiêu chí.
