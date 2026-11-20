package game

import (
	"math"
)

// DefaultEloRating là mức điểm khởi đầu của người chơi mới (Rank Bạc).
const DefaultEloRating = 1200

// MinEloRating là mức sàn Elo tối thiểu.
const MinEloRating = 100

// RankTier phân loại cấp bậc dựa trên điểm Elo.
type RankTier struct {
	Name  string `json:"name"`
	Badge string `json:"badge"`
}

// GetRankTier trả về danh hiệu cấp bậc và huy hiệu dựa trên điểm Elo.
func GetRankTier(rating int) RankTier {
	switch {
	case rating >= 2000:
		return RankTier{Name: "Đại Kiện Tướng", Badge: "🌟"}
	case rating >= 1800:
		return RankTier{Name: "Kim Cương", Badge: "👑"}
	case rating >= 1600:
		return RankTier{Name: "Bạch Kim", Badge: "💎"}
	case rating >= 1400:
		return RankTier{Name: "Vàng", Badge: "🥇"}
	case rating >= 1200:
		return RankTier{Name: "Bạc", Badge: "🥈"}
	default:
		return RankTier{Name: "Đồng", Badge: "🥉"}
	}
}

// IsSoloGame kiểm tra game có phải là game đối kháng 2 người tính điểm Elo không.
func IsSoloGame(kind string) bool {
	switch kind {
	case "caro", "xiangqi", "chess", "rps":
		return true
	default:
		return false
	}
}

// EloKFactor trả về hệ số K cho trận đấu.
func EloKFactor(totalGames int) float64 {
	if totalGames < 30 {
		return 32.0
	}
	return 24.0
}

// CalculateElo tính điểm Elo mới và delta cho 2 kỳ thủ.
// scoreA: 1.0 (A thắng), 0.5 (hòa), 0.0 (B thắng).
func CalculateElo(ratingA, totalGamesA, ratingB, totalGamesB int, scoreA float64) (newA, deltaA, newB, deltaB int) {
	ea := 1.0 / (1.0 + math.Pow(10.0, float64(ratingB-ratingA)/400.0))
	eb := 1.0 - ea

	kA := EloKFactor(totalGamesA)
	kB := EloKFactor(totalGamesB)

	scoreB := 1.0 - scoreA

	dA := math.Round(kA * (scoreA - ea))
	dB := math.Round(kB * (scoreB - eb))

	nA := ratingA + int(dA)
	nB := ratingB + int(dB)

	if nA < MinEloRating {
		nA = MinEloRating
	}
	if nB < MinEloRating {
		nB = MinEloRating
	}

	return nA, int(dA), nB, int(dB)
}
