package game_test

import (
	"chat/game"
	"testing"
)

func TestCalculateEloEqualMatch(t *testing.T) {
	// 2 người ngang điểm: 1200 vs 1200
	newA, deltaA, newB, deltaB := game.CalculateElo(1200, 10, 1200, 10, 1.0)
	if deltaA != 16 || deltaB != -16 {
		t.Fatalf("expected deltaA=16, deltaB=-16, got %d, %d", deltaA, deltaB)
	}
	if newA != 1216 || newB != 1184 {
		t.Fatalf("expected newA=1216, newB=1184, got %d, %d", newA, newB)
	}
}

func TestCalculateEloUnderdogWin(t *testing.T) {
	// Người 1200 thắng người 1400
	newA, deltaA, newB, deltaB := game.CalculateElo(1200, 5, 1400, 5, 1.0)
	if deltaA <= 16 {
		t.Fatalf("expected underdog win to yield > 16 points, got %d", deltaA)
	}
	if deltaB >= -16 {
		t.Fatalf("expected higher rated loss to lose > 16 points, got %d", deltaB)
	}
	if newA != 1200+deltaA || newB != 1400+deltaB {
		t.Fatalf("rating calculation mismatch: %d, %d", newA, newB)
	}
}

func TestCalculateEloDraw(t *testing.T) {
	// Hòa nhau khi bằng điểm
	newA, deltaA, newB, deltaB := game.CalculateElo(1200, 10, 1200, 10, 0.5)
	if deltaA != 0 || deltaB != 0 {
		t.Fatalf("expected delta=0 for equal draw, got %d, %d", deltaA, deltaB)
	}
	if newA != 1200 || newB != 1200 {
		t.Fatalf("expected ratings unchanged, got %d, %d", newA, newB)
	}
}

func TestCalculateEloFloor(t *testing.T) {
	// Kiểm tra sàn điểm không rớt dưới MinEloRating (100)
	newA, _, _, _ := game.CalculateElo(105, 50, 1500, 50, 0.0)
	if newA < game.MinEloRating {
		t.Fatalf("expected rating to be at least %d, got %d", game.MinEloRating, newA)
	}
}

func TestGetRankTier(t *testing.T) {
	tests := []struct {
		rating    int
		wantName  string
		wantBadge string
	}{
		{2100, "Đại Kiện Tướng", "🌟"},
		{1850, "Kim Cương", "👑"},
		{1650, "Bạch Kim", "💎"},
		{1450, "Vàng", "🥇"},
		{1250, "Bạc", "🥈"},
		{1100, "Đồng", "🥉"},
	}

	for _, tt := range tests {
		tier := game.GetRankTier(tt.rating)
		if tier.Name != tt.wantName || tier.Badge != tt.wantBadge {
			t.Errorf("GetRankTier(%d) = %+v, want %s %s", tt.rating, tier, tt.wantName, tt.wantBadge)
		}
	}
}
