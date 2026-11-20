import { useEffect, useState, useMemo } from "react";
import type { LiveGameItem, GameKind } from "../lib/api";
import { useChat } from "../state/ChatProvider";

function getGameIcon(kind: GameKind): string {
  switch (kind) {
    case "xiangqi":
      return "🪖";
    case "chess":
      return "♟️";
    case "caro":
      return "⭕";
    case "werewolf":
      return "🐺";
    case "spy":
      return "🕵️";
    case "rps":
      return "✊";
    case "station":
      return "🛰️";
    default:
      return "🎮";
  }
}

function formatGamePlayers(g: LiveGameItem): string {
  if (g.status === "lobby") {
    const hostName = g.host.display_name || g.host.username;
    if (g.game?.max_players && g.game.max_players > 2) {
      return `${hostName} (${g.players.length}/${g.game.max_players})`;
    }
    return `${hostName} · Chờ đối thủ`;
  }
  if (g.players.length === 2) {
    return `${g.players[0]?.name || "?"} vs ${g.players[1]?.name || "?"}`;
  }
  if (g.players.length > 2) {
    return `${g.players.length} người chơi`;
  }
  return g.host.display_name || g.host.username;
}

export function LiveGamesBar({ channelId }: { channelId: number }) {
  const { state, loadLiveGames, jumpToMessage } = useChat();
  const [jumpingId, setJumpingId] = useState<number | null>(null);

  // Load live games on channel change
  useEffect(() => {
    void loadLiveGames(channelId);
  }, [channelId, loadLiveGames]);

  const rawGames = state.liveGames[channelId] || [];

  // Sort games by priority:
  // 1. is_my_turn == true
  // 2. playing with me
  // 3. playing
  // 4. lobby
  // 5. newest first (message_id DESC)
  const games = useMemo(() => {
    const myId = state.me.id;
    return [...rawGames].sort((a, b) => {
      if (a.is_my_turn !== b.is_my_turn) return a.is_my_turn ? -1 : 1;
      const aIsPlayer = a.players.some((p) => p.id === myId);
      const bIsPlayer = b.players.some((p) => p.id === myId);
      if (aIsPlayer !== bIsPlayer) return aIsPlayer ? -1 : 1;
      if (a.status !== b.status) return a.status === "playing" ? -1 : 1;
      return b.message_id - a.message_id;
    });
  }, [rawGames, state.me.id]);

  if (games.length === 0) {
    return null;
  }

  const handleJump = async (g: LiveGameItem) => {
    if (jumpingId !== null) return;
    setJumpingId(g.message_id);
    try {
      await jumpToMessage({ id: g.message_id, channel_id: g.channel_id });
    } catch (err) {
      console.error("jumpToMessage failed:", err);
    } finally {
      setJumpingId(null);
    }
  };

  return (
    <aside className="live-games-bar" aria-label="Các trò chơi đang diễn ra">
      <div className="live-games-label">
        <span className="live-games-label-icon" aria-hidden>🎮</span>
        <span className="live-games-label-text">Đang diễn ra</span>
      </div>
      <div className="live-games-scroll">
        {games.map((g) => {
          const isJumping = jumpingId === g.message_id;
          return (
            <button
              key={g.message_id}
              type="button"
              className={`live-game-chip ${g.is_my_turn ? "is-my-turn" : ""} is-${g.status} ${
                isJumping ? "is-jumping" : ""
              }`}
              onClick={() => handleJump(g)}
              title={`Nhấn để cuộn tới ${g.title}`}
            >
              <span className="live-game-icon">{getGameIcon(g.kind)}</span>
              <div className="live-game-info">
                <div className="live-game-header">
                  <span className={`live-status-dot dot-${g.status}`} />
                  <strong className="live-game-title">{g.title}</strong>
                  <span className="live-status-text">
                    {g.status === "lobby" ? "Chờ người" : "Live"}
                  </span>
                </div>
                <div className="live-game-meta">
                  <span className="live-game-players">{formatGamePlayers(g)}</span>
                  {g.is_my_turn && <span className="live-turn-badge">⚡ Lượt bạn!</span>}
                  {g.viewer_count > 0 && (
                    <span className="live-viewers-count" title={`${g.viewer_count} người đang xem trực tiếp`}>
                      👁️ {g.viewer_count}
                    </span>
                  )}
                </div>
              </div>
              <span className="live-jump-indicator" aria-hidden>
                {isJumping ? (
                  <svg className="spin live-spinner" viewBox="0 0 24 24" width="14" height="14">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" strokeDasharray="31.4 31.4" />
                  </svg>
                ) : (
                  "↓"
                )}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
