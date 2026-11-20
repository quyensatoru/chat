import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Attachment, Channel } from "../lib/api";
import { displayName } from "../lib/format";
import { useChat } from "../state/ChatProvider";
import { buildRows, MessageRow } from "./ChannelView";
import { Composer } from "./Composer";
import { ImageViewer } from "./MessageParts";
import { Icon } from "./ui";
import { channelLabel } from "../lib/channel";
import type { ChessState, XiangqiState } from "../lib/games";

type Props = {
  channel: Channel;
  parentId: number;
  onClose: () => void;
};

/** Panel bên phải: tin gốc, các trả lời và ô trả lời. Trên điện thoại phủ toàn màn hình. */
export function ThreadPanel({ channel, parentId, onClose }: Props) {
  const { state, openThread, retryMessage, discardMessage, sendMessage, spectateGame, unspectateGame } = useChat();
  const thread = state.threads[parentId];
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // Mở bằng thông báo hoặc kết nối lại: luồng có thể chưa được tải.
  useEffect(() => {
    if (!state.threads[parentId]) openThread(parentId);
  }, [parentId, state.threads, openThread]);

  const parent = thread?.parent;
  const isGameThread = parent?.embed?.type === "game" || !!parent?.game;

  // Khán giả theo dõi ván game khi mở thread
  useEffect(() => {
    if (isGameThread) {
      spectateGame(parentId);
      return () => {
        unspectateGame(parentId);
      };
    }
  }, [isGameThread, parentId, spectateGame, unspectateGame]);

  const pending = useMemo(() => state.pending.filter((p) => p.parentId === parentId), [state.pending, parentId]);
  const rows = useMemo(
    () => (thread ? buildRows(thread.replies, pending, state.me.id).filter((r) => r.kind !== "day") : []),
    [thread, pending, state.me.id],
  );

  // Trả lời mới: tự cuộn xuống nếu đang ở cuối.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  const parentUser = parent ? (state.users[parent.user_id] ?? parent.user) : undefined;
  const replyCount = thread?.replies.length ?? 0;
  const where = channelLabel(channel, state.users, state.me.id);
  const game = parent?.game;

  const getRoleBadge = (userId: number) => {
    if (!isGameThread || !game) return undefined;
    const isHost = game.host_id === userId;

    if (game.kind === "xiangqi") {
      const s = game.state as XiangqiState | undefined;
      if (s?.red_player_id === userId) {
        return <span className="game-role-badge is-player-red">⚔️ Đỏ</span>;
      }
      if (s?.black_player_id === userId) {
        return <span className="game-role-badge is-player-black">⚔️ Đen</span>;
      }
    } else if (game.kind === "chess") {
      const s = game.state as ChessState | undefined;
      if (s?.white_player_id === userId) {
        return <span className="game-role-badge is-player-white">⚔️ Trắng</span>;
      }
      if (s?.black_player_id === userId) {
        return <span className="game-role-badge is-player-black">⚔️ Đen</span>;
      }
    } else if (game.players.some((p) => p.id === userId)) {
      return <span className="game-role-badge is-player">⚔️ Kỳ thủ</span>;
    }

    if (isHost) {
      return <span className="game-role-badge is-host">👑 Chủ phòng</span>;
    }

    return <span className="game-role-badge is-viewer">👁️ Khán giả</span>;
  };

  const spectators = state.spectators[parentId] ?? [];
  const liveGame = state.liveGames[channel.id]?.find((g) => g.message_id === parentId);
  const viewerCount = spectators.length || liveGame?.viewer_count || 0;
  const spectatorNames = spectators.map((s) => s.display_name || s.username).join(", ");

  return (
    <aside className="thread-panel" aria-label="Luồng trả lời">
      <header className="thread-header">
        <div>
          <h3>{isGameThread ? `Khán đài: ${game?.title || parent?.embed?.title || "Trò chơi"}` : "Luồng"}</h3>
          <div className="thread-header-sub">
            <p className="muted">
              {isGameThread && game?.players && game.players.length >= 2
                ? `${game.players[0].name} vs ${game.players[1].name}`
                : where}
            </p>
            {isGameThread && viewerCount > 0 && (
              <span
                className="thread-spectator-badge"
                title={spectatorNames ? `Khán giả: ${spectatorNames}` : `${viewerCount} khán giả đang theo dõi`}
              >
                <span className="live-dot" /> 👁️ {viewerCount} người xem
              </span>
            )}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Đóng luồng">
          <Icon name="x" />
        </button>
      </header>

      <div
        className="thread-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {!parent ? (
          <p className="messages-loading">Đang tải luồng…</p>
        ) : (
          <>
            <MessageRow
              mine={parent.user_id === state.me.id}
              mentioned={!!parent.mentions?.includes(state.me.id)}
              grouped={false}
              name={displayName(parentUser)}
              avatarUser={parentUser}
              time={parent.created_at}
              content={parent.content}
              attachments={parent.attachments}
              onOpenImage={setViewing}
              message={parent}
              roleBadge={isGameThread ? <span className="game-role-badge is-host">🎮 Ván đấu</span> : undefined}
            />
            <div className="thread-divider" role="separator">
              <span>{replyCount > 0 ? `${replyCount} bình luận` : "Chưa có bình luận"}</span>
            </div>
            {rows.map((r) => {
              if (r.kind === "msg") {
                const user = state.users[r.msg.user_id] ?? r.msg.user;
                return (
                  <MessageRow
                    key={r.key}
                    mine={r.msg.user_id === state.me.id}
                    mentioned={!!r.msg.mentions?.includes(state.me.id)}
                    grouped={r.grouped}
                    name={displayName(user)}
                    avatarUser={user}
                    time={r.msg.created_at}
                    content={r.msg.content}
                    attachments={r.msg.attachments}
                    onOpenImage={setViewing}
                    message={r.msg}
                    roleBadge={getRoleBadge(r.msg.user_id)}
                  />
                );
              }
              if (r.kind !== "pending") return null;
              const me = state.users[state.me.id] ?? state.me;
              return (
                <MessageRow
                  key={r.key}
                  mine
                  grouped={r.grouped}
                  name={displayName(me)}
                  avatarUser={me}
                  time={r.p.createdAt}
                  content={r.p.content}
                  pending={r.p}
                  onRetry={() => retryMessage(r.p.clientId)}
                  onDiscard={() => discardMessage(r.p.clientId)}
                  roleBadge={getRoleBadge(state.me.id)}
                />
              );
            })}
          </>
        )}
      </div>

      {isGameThread && (
        <div className="game-cheering-bar" role="toolbar" aria-label="Cổ vũ nhanh">
          {["👏 Hay quá!", "🔥 Căng thẳng!", "🤔 Nước cờ hiểm!", "☕ Ngồi xem cao thủ!", "🍿 Hóng kết quả!"].map((text) => (
            <button
              key={text}
              type="button"
              className="game-cheer-chip"
              onClick={() => {
                sendMessage(channel.id, text, undefined, parentId);
              }}
            >
              {text}
            </button>
          ))}
        </div>
      )}

      {parent && <Composer channel={channel} parentId={parentId} />}
      {viewing && <ImageViewer attachment={viewing} onClose={() => setViewing(null)} />}
    </aside>
  );
}
