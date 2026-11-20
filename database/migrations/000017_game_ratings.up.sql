-- Bảng lưu điểm xếp hạng Elo và thành tích cho các trò chơi đối kháng 2 người (Caro, Cờ Tướng, Cờ Vua, Kéo Búa Bao).
CREATE TABLE IF NOT EXISTS game_ratings (
    user_id        INTEGER  NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind           TEXT     NOT NULL, -- 'caro', 'xiangqi', 'chess', 'rps'
    rating         INTEGER  NOT NULL DEFAULT 1200,
    peak_rating    INTEGER  NOT NULL DEFAULT 1200,
    wins           INTEGER  NOT NULL DEFAULT 0,
    losses         INTEGER  NOT NULL DEFAULT 0,
    draws          INTEGER  NOT NULL DEFAULT 0,
    current_streak INTEGER  NOT NULL DEFAULT 0,
    best_streak    INTEGER  NOT NULL DEFAULT 0,
    updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_game_ratings_kind_rating ON game_ratings (kind, rating DESC);
