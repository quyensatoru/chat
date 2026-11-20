import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, type GameKind, type GameLeaderboard, type GameView, type Message, type PublicUser } from "../lib/api";
import {
  GAME_INFO,
  ROLE_INFO,
  myTurn,
  type CaroState,
  type ChessState,
  type XiangqiState,
  type RpsChoice,
  type RpsMe,
  type RpsState,
  type SpyMe,
  type SpyState,
  type WerewolfMe,
  type WerewolfRole,
  type WerewolfState,
} from "../lib/games";
import { ChessPiece } from "./ChessPiece";
import { XiangqiGame } from "./XiangqiGame";
import { useChat } from "../state/ChatProvider";
import type { StationState } from "../lib/station";
import { StationSummary } from "./Station";
import { ShareDialog } from "./Share";
import { Avatar, Dialog, FormError, Icon } from "./ui";

/* ---------- Tiện ích ---------- */

/** Số giây còn lại tới deadline, tự cập nhật. */
function useSecondsLeft(deadline: string | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [deadline]);
  if (!deadline) return null;
  return Math.max(0, Math.ceil((new Date(deadline).getTime() - now) / 1000));
}

function clock(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Countdown({ deadline, label }: { deadline?: string; label?: string }) {
  const left = useSecondsLeft(deadline);
  if (left === null) return null;
  return (
    <span className={`game-clock${left <= 10 ? " is-urgent" : ""}`} role="timer" aria-label={label}>
      ⏱ {clock(left)}
    </span>
  );
}

type Ctx = {
  messageId: number;
  game: GameView;
  meId: number;
  isPlayer: boolean;
  busy: boolean;
  /** Gửi hành động; lỗi hiện ở cuối thẻ. */
  act: (action: string, data?: unknown) => void;
  user: (id: number) => PublicUser;
  nameOf: (id: number) => string;
  /** Mở hộp thoại chia sẻ phòng chơi sang kênh / tin nhắn riêng khác. */
  invite: () => void;
  /** Mở luồng bình luận / khán đài của ván đấu */
  openThread: () => void;
  replyCount: number;
  viewerCount: number;
};

/** Ô người chơi: avatar, tên, nhãn phụ; bấm được nếu có onClick. */
function PlayerTile({
  ctx,
  id,
  badge,
  sub,
  dead,
  selected,
  winner,
  onClick,
  children,
}: {
  ctx: Ctx;
  id: number;
  badge?: ReactNode;
  sub?: ReactNode;
  dead?: boolean;
  selected?: boolean;
  winner?: boolean;
  onClick?: () => void;
  children?: ReactNode;
}) {
  const cls = [
    "game-player",
    dead && "is-dead",
    selected && "is-selected",
    winner && "is-winner",
    onClick && "is-clickable",
    id === ctx.meId && "is-me",
  ]
    .filter(Boolean)
    .join(" ");
  const body = (
    <>
      <Avatar user={ctx.user(id)} size={30} />
      <span className="game-player-text">
        <span className="game-player-name">
          {ctx.nameOf(id)}
          {id === ctx.meId && <span className="game-me-tag">bạn</span>}
        </span>
        {sub && <span className="game-player-sub">{sub}</span>}
      </span>
      {badge && <span className="game-player-badge">{badge}</span>}
      {children}
    </>
  );
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} disabled={ctx.busy} aria-pressed={selected}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Thẻ bí mật (vai / từ khoá): mặc định úp để người ngồi cạnh không nhìn trộm. */
function SecretCard({ label, children, tone }: { label: string; children: ReactNode; tone?: "wolf" | "plain" }) {
  const [shown, setShown] = useState(false);
  return (
    <div className={`game-secret${tone === "wolf" ? " is-wolf" : ""}${shown ? " is-shown" : ""}`}>
      <div className="game-secret-head">
        <span>{label}</span>
        <button type="button" className="link-btn" onClick={() => setShown((v) => !v)} aria-expanded={shown}>
          {shown ? "Úp thẻ" : "Lật xem"}
        </button>
      </div>
      {shown ? (
        <div className="game-secret-body">{children}</div>
      ) : (
        <button type="button" className="game-secret-cover" onClick={() => setShown(true)}>
          Bấm để lật thẻ (che màn hình khỏi người bên cạnh)
        </button>
      )}
    </div>
  );
}

function votesFor(votes: Record<string, number> | undefined, target: number): number[] {
  if (!votes) return [];
  return Object.entries(votes)
    .filter(([, t]) => t === target)
    .map(([v]) => Number(v));
}

function VoterDots({ ctx, ids }: { ctx: Ctx; ids: number[] }) {
  if (ids.length === 0) return null;
  return (
    <span className="game-voters" title={ids.map(ctx.nameOf).join(", ")}>
      {ids.slice(0, 4).map((id) => (
        <Avatar key={id} user={ctx.user(id)} size={16} />
      ))}
      <b>{ids.length}</b>
    </span>
  );
}

/* ---------- Thẻ ván chơi trong tin nhắn ---------- */

export function GameCard({ message }: { message: Message }) {
  const { state, gameAction, openThread } = useChat();
  const game = message.game!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meId = state.me.id;
  const isPlayer = game.players.some((p) => p.id === meId);

  const threadMeta = message.thread;
  const replyCount = threadMeta?.reply_count ?? 0;
  const participantIds = threadMeta?.participant_ids ?? [];
  const playerIds = new Set(game.players.map((p) => p.id));
  const viewerIds = participantIds.filter((id) => !playerIds.has(id));
  const viewerCount = viewerIds.length;

  const act = (action: string, data?: unknown) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    gameAction(message.id, action, data)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Không gửi được, thử lại."))
      .finally(() => setBusy(false));
  };
  const nameOf = (id: number) => game.players.find((p) => p.id === id)?.name ?? "?";
  const user = (id: number): PublicUser =>
    state.users[id] ?? { id, username: nameOf(id), display_name: nameOf(id), avatar: null, status_text: "" };
  const [sharing, setSharing] = useState(false);
  const ctx: Ctx = {
    messageId: message.id,
    game,
    meId,
    isPlayer,
    busy,
    act,
    user,
    nameOf,
    invite: () => setSharing(true),
    openThread: () => openThread(message.id),
    replyCount,
    viewerCount,
  };
  const info = GAME_INFO[game.kind];
  const turn = myTurn(game, meId);
  const night = game.kind === "werewolf" && (game.state as WerewolfState | undefined)?.phase === "night";

  const meta =
    game.status === "lobby"
      ? `Đang chờ người chơi · ${game.players.length}/${game.max_players}`
      : game.status === "playing"
        ? "Đang chơi"
        : "Đã kết thúc";

  return (
    <section
      className={`game game-${game.kind} is-${game.status}${night ? " is-night" : ""}`}
      aria-label={`${game.title}: ${meta}`}
    >
      <header className="game-head">
        <span className="game-icon" aria-hidden>
          {info.icon}
        </span>
        <div className="game-titles">
          <p className="game-title">{game.title}</p>
          <p className="game-meta">
            {meta}
            {game.status !== "ended" && <> · chủ phòng {game.host_id === meId ? "bạn" : nameOf(game.host_id)}</>}
          </p>
        </div>
        {turn && <span className="game-turn">{turn}</span>}
      </header>

      {game.status === "lobby" ? (
        <Lobby ctx={ctx} />
      ) : game.kind === "station" ? (
        <StationSummary messageId={message.id} game={game} meId={meId} />
      ) : game.kind === "werewolf" ? (
        <Werewolf ctx={ctx} />
      ) : game.kind === "spy" ? (
        <Spy ctx={ctx} />
      ) : game.kind === "caro" ? (
        <Caro ctx={ctx} />
      ) : game.kind === "chess" ? (
        <Chess ctx={ctx} />
      ) : game.kind === "xiangqi" ? (
        <Xiangqi ctx={ctx} />
      ) : (
        <Rps ctx={ctx} />
      )}

      {/* Thanh Khán giả & Bình luận của ván cờ */}
      <div className="game-spectator-bar">
        <div className="game-spectator-info">
          <span className="game-spectator-count">
            💬 {replyCount > 0 ? `${replyCount} bình luận` : "Chưa có bình luận"}
            {viewerCount > 0 && ` · 👁️ ${viewerCount} Khán giả`}
          </span>
          {viewerIds.length > 0 && (
            <span className="game-viewer-avatars" aria-hidden>
              {viewerIds.slice(0, 5).map((id) => (
                <Avatar key={id} user={state.users[id]} size={20} />
              ))}
            </span>
          )}
        </div>
        <button
          type="button"
          className="btn btn-xs btn-secondary"
          onClick={() => openThread(message.id)}
          title="Mở luồng bình luận và xem ý kiến khán giả"
        >
          💬 {replyCount > 0 ? "Mở Khán đài" : "Bình luận (Khán đài)"}
        </button>
      </div>

      {game.status === "ended" && game.result && (
        <p className={`game-result${game.winners?.includes(meId) ? " is-win" : ""}`}>
          {game.winners?.includes(meId) ? "🏆 " : ""}
          {game.result}
        </p>
      )}
      <GameLog game={game} />
      <FormError>{error}</FormError>
      {sharing && <ShareDialog message={message} onClose={() => setSharing(false)} />}
    </section>
  );
}

function GameLog({ game }: { game: GameView }) {
  const [all, setAll] = useState(false);
  const many = game.kind === "werewolf" || game.kind === "spy";
  const lines = all ? game.log : game.log.slice(many ? -4 : -2);
  if (game.log.length === 0) return null;
  return (
    <div className="game-log">
      <ol aria-label="Diễn biến">
        {lines.map((l, i) => (
          <li key={game.log.length - lines.length + i}>{l}</li>
        ))}
      </ol>
      {game.log.length > lines.length || all ? (
        <button type="button" className="link-btn" onClick={() => setAll((v) => !v)}>
          {all ? "Thu gọn" : `Xem toàn bộ diễn biến (${game.log.length})`}
        </button>
      ) : null}
    </div>
  );
}

/* ---------- Phòng chờ ---------- */

const RULES: Record<GameKind, string[]> = {
  station: [
    "Mỗi người là một phi hành gia trên trạm. Phần lớn là thuyền viên, vài người là kẻ phản bội (đồng bọn biết nhau).",
    "Thuyền viên đi tới các điểm phát sáng để làm nhiệm vụ (nối dây, nhập mã, căn chỉnh…). Xong hết nhiệm vụ của cả trạm là thắng.",
    "Kẻ phản bội giết người khi đứng gần (có thời gian hồi), phá hoại: cắt điện làm mọi người gần như không thấy gì, hoặc xả oxy (45 giây không sửa là thua).",
    "Thấy xác thì báo, hoặc bấm chuông ở sảnh để họp. Thảo luận rồi bỏ phiếu đẩy một người ra ngoài không gian.",
    "Người chết thành hồn ma: đi xuyên tường, vẫn làm nhiệm vụ được, chỉ nói chuyện với hồn ma khác.",
    "Điều khiển: W A S D hoặc phím mũi tên (điện thoại: cần gạt), E dùng, R báo xác, Q giết, M bản đồ.",
  ],
  werewolf: [
    "Mỗi người nhận một vai bí mật. Sói biết nhau, những người khác không biết ai là ai.",
    "Đêm: Sói chọn chung một người để cắn; Tiên tri soi một người; Bảo vệ che một người; Phù thủy biết ai bị cắn và có thể cứu hoặc đầu độc.",
    "Ngày: thảo luận ngay trong kênh chat rồi bỏ phiếu. Người nhiều phiếu nhất bị treo cổ (hoà phiếu thì không ai chết).",
    "Dân thắng khi hết Sói. Sói thắng khi số Sói bằng số người còn lại.",
  ],
  spy: [
    "Mọi người nhận cùng một từ, riêng gián điệp nhận từ gần giống. Không ai biết mình có phải gián điệp không.",
    "Lần lượt từng người mô tả từ của mình bằng một câu ngắn, không được nói thẳng từ đó.",
    "Hết một vòng thì bỏ phiếu loại một người. Dân thắng khi loại hết gián điệp; gián điệp thắng khi còn ngang số dân.",
  ],
  caro: [
    "Chủ phòng cầm X, đi trước. Có 5 quân liền hàng ngang, dọc hoặc chéo là thắng.",
    "Luật chặn hai đầu: hàng 5 bị đối phương chặn cả hai đầu thì không tính.",
    "Mỗi nước có 3 phút suy nghĩ.",
  ],
  chess: [
    "Cờ vua quốc tế 8×8, Trắng đi trước, Đen đi sau (hệ thống chọn ngẫu nhiên màu quân).",
    "Tuân thủ đầy đủ luật FIDE: nhập thành, bắt tốt qua đường (en passant), phong cấp tốt.",
    "Chiếu bí đối phương để giành chiến thắng. Hoà cờ khi hết nước đi (stalemate), luật 50 nước, không đủ lực lượng hoặc đôi bên đồng ý.",
  ],
  xiangqi: [
    "Cờ tướng 9×10, Đỏ đi trước, Đen đi sau (hệ thống chọn màu quân theo tuỳ chọn phòng).",
    "Tuân thủ luật Cờ tướng chuẩn WXF: cản mắt tượng, cản chân mã, pháo nhảy ăn quân qua đúng 1 ngòi, tướng và sĩ không ra khỏi cung.",
    "Luật Lộ diện tướng: hai tướng không được đối mặt trực tiếp trên cùng một cột.",
    "Bên bị hết nước đi (bức tử / stalemate) bị xử thua cuộc.",
  ],
  rps: ["Búa thắng Kéo, Kéo thắng Bao, Bao thắng Búa.", "Hai người ra cùng lúc, 30 giây mỗi ván."],
};

function Lobby({ ctx }: { ctx: Ctx }) {
  const { game, meId, isPlayer, busy, act } = ctx;
  const isHost = game.host_id === meId;
  const full = game.players.length >= game.max_players;
  const enough = game.players.length >= game.min_players;
  const auto = game.min_players === game.max_players; // trò 2 người: đủ người là vào luôn

  let setup: ReactNode = null;
  if (game.kind === "station") {
    const s = game.state as StationState;
    setup = (
      <p className="game-setup">
        {s.traitor_count} kẻ phản bội · {s.opts.tasks} nhiệm vụ/người · hồi chiêu giết {s.opts.kill_cooldown}s · họp{" "}
        {s.opts.discuss}s + bỏ phiếu {s.opts.vote}s
      </p>
    );
  } else if (game.kind === "werewolf") {
    const s = game.state as WerewolfState;
    setup = (
      <p className="game-setup">
        Vai ({Math.max(game.players.length, 4)} người):{" "}
        {(Object.keys(ROLE_INFO) as WerewolfRole[])
          .filter((r) => s.composition[r])
          .map((r) => `${ROLE_INFO[r].icon} ${s.composition[r]} ${ROLE_INFO[r].name}`)
          .join(" · ")}
        <br />
        Ngày {s.opts.day_seconds}s · đêm {s.opts.night_seconds}s{s.opts.hide_roles ? " · giấu vai người chết" : ""}
      </p>
    );
  } else if (game.kind === "spy") {
    setup = <p className="game-setup">{(game.state as SpyState).spy_count} gián điệp trong phòng</p>;
  } else if (game.kind === "caro") {
    setup = (
      <p className="game-setup">
        Bàn cờ tự do (kéo để di chuyển) · {(game.state as CaroState).free_style ? "không chặn hai đầu" : "luật chặn hai đầu"}
      </p>
    );
  } else if (game.kind === "chess") {
    const s = game.state as ChessState;
    const mins = s?.opts?.turn_minutes || 3;
    const firstStr =
      s?.opts?.first === "host"
        ? "chủ phòng cầm Trắng"
        : s?.opts?.first === "guest"
        ? "khách cầm Trắng"
        : "ngẫu nhiên màu quân";
    setup = (
      <p className="game-setup">
        Bàn cờ 8×8 tiêu chuẩn · Luật FIDE · {mins} phút/nước · {firstStr}
      </p>
    );
  } else if (game.kind === "xiangqi") {
    const s = game.state as XiangqiState;
    const mins = s?.opts?.turn_minutes || 3;
    const firstStr =
      s?.opts?.first === "host"
        ? "chủ phòng cầm Đỏ"
        : s?.opts?.first === "guest"
        ? "khách cầm Đỏ"
        : "ngẫu nhiên màu quân";
    setup = (
      <p className="game-setup">
        Bàn cờ 9×10 chuẩn · Luật WXF · {mins} phút/nước · {firstStr}
      </p>
    );
  } else {
    setup = <p className="game-setup">Chạm {Math.floor((game.state as RpsState).best_of / 2) + 1} ván thắng</p>;
  }

  return (
    <div className="game-lobby">
      {setup}
      <ul className="game-roster" aria-label="Người chơi">
        {game.players.map((p) => (
          <li key={p.id}>
            <PlayerTile ctx={ctx} id={p.id} sub={p.id === game.host_id ? "chủ phòng" : undefined} />
          </li>
        ))}
        {Array.from({ length: Math.max(0, game.min_players - game.players.length) }, (_, i) => (
          <li key={`e${i}`} className="game-seat" aria-hidden>
            Chỗ trống
          </li>
        ))}
      </ul>
      <details className="game-rules">
        <summary>Luật chơi</summary>
        <ul>
          {RULES[game.kind].map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </details>
      <div className="game-actions">
        {!isPlayer && !full && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act("join")}>
            {auto ? "Nhận lời thách đấu" : "Vào chơi"}
          </button>
        )}
        {isPlayer && !isHost && (
          <button type="button" className="btn" disabled={busy} onClick={() => act("leave")}>
            Rời phòng
          </button>
        )}
        {isHost && !auto && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !enough}
            onClick={() => act("start")}
            title={enough ? undefined : `Cần ít nhất ${game.min_players} người`}
          >
            {enough ? "Bắt đầu" : `Cần thêm ${game.min_players - game.players.length} người`}
          </button>
        )}
        {!full && (
          <button type="button" className="btn" onClick={ctx.invite}>
            <Icon name="userPlus" size={16} />
            Mời bạn bè
          </button>
        )}
        {isHost && (
          <button type="button" className="btn" disabled={busy} onClick={() => act("cancel")}>
            Huỷ phòng
          </button>
        )}
        {isHost && auto && <span className="game-hint">Chờ một người nhận lời…</span>}
      </div>
    </div>
  );
}

/* ---------- Ma Sói ---------- */

function Werewolf({ ctx }: { ctx: Ctx }) {
  const { game, meId, busy, act } = ctx;
  const s = game.state as WerewolfState;
  const me = game.me as WerewolfMe | undefined;
  const [pending, setPending] = useState<number | null>(null);
  const [heal, setHeal] = useState(false);
  const [poison, setPoison] = useState(0);
  const step = me?.step;
  const phaseKey = `${s.phase}-${s.round}-${step}`;
  useEffect(() => {
    setPending(null);
    setHeal(false);
    setPoison(0);
  }, [phaseKey]);

  const dead = new Set(s.dead);
  const playing = game.status === "playing";
  const wolfMates = new Set(me?.role === "wolf" ? me.wolves : []);
  const roleOf = (id: number): WerewolfRole | undefined =>
    s.roles[id] ?? (wolfMates.has(id) ? "wolf" : id === meId ? me?.role : undefined);

  // ai bấm được và bấm thì làm gì
  const canPick = (id: number): boolean => {
    if (!playing || dead.has(id) || busy) return false;
    switch (step) {
      case "wolf":
        return !wolfMates.has(id);
      case "seer":
        return id !== meId;
      case "guard":
        return id !== me?.last_guard;
      case "vote":
        return id !== meId;
      case "shoot":
        return id !== meId;
    }
    return false;
  };
  const onPick = (id: number) => {
    if (step === "wolf") act("night", { target: id });
    else if (step === "vote") act("vote", { target: s.votes?.[meId] === id ? 0 : id });
    else setPending(id === pending ? null : id);
  };

  let banner: ReactNode;
  if (!playing) banner = <span>Ván đã kết thúc sau {s.round} đêm</span>;
  else if (s.phase === "night") banner = <span>🌙 Đêm {s.round} · cả làng đi ngủ</span>;
  else if (s.phase === "day") banner = <span>☀️ Ngày {s.round} · thảo luận trong kênh rồi bỏ phiếu treo cổ</span>;
  else banner = <span>🏹 Thợ săn {ctx.nameOf(s.hunter ?? 0)} đang ngắm bắn</span>;

  let hint: ReactNode = null;
  if (playing && me) {
    if (!me.alive && step !== "shoot") hint = "Bạn đã chết. Hãy xem tiếp nhưng đừng tiết lộ gì nhé.";
    else if (step === "wolf")
      hint = me.target
        ? `Bạn chọn cắn ${ctx.nameOf(me.target)}. Đổi được tới khi cả bầy thống nhất.`
        : "Chọn người để cắn. Cả bầy phải chọn cùng một người.";
    else if (step === "seer") hint = "Chọn một người để soi.";
    else if (step === "guard") hint = "Chọn một người để bảo vệ đêm nay.";
    else if (step === "vote")
      hint =
        s.votes?.[meId] === undefined
          ? "Bấm vào người bạn muốn treo cổ, hoặc bỏ qua."
          : s.votes[meId]
            ? `Bạn bỏ phiếu treo ${ctx.nameOf(s.votes[meId])}. Bấm lại để bỏ qua.`
            : "Bạn đã bỏ qua lượt bỏ phiếu.";
    else if (step === "shoot") hint = "Bạn là Thợ săn và vừa chết. Chọn một người để bắn theo.";
    else if (s.phase === "night")
      hint =
        me.role === "seer" || me.role === "guard"
          ? "Bạn đã hành động. Chờ trời sáng…"
          : me.role === "witch"
            ? "Chờ Sói hành động, rồi tới lượt bạn…"
            : "Bạn đang ngủ. Chờ trời sáng…";
  }

  return (
    <div className="ww">
      <div className="game-banner">
        {banner}
        {playing && <Countdown deadline={game.deadline} label="Thời gian còn lại" />}
      </div>

      {me?.role && (
        <SecretCard label="Vai của bạn" tone={me.role === "wolf" ? "wolf" : "plain"}>
          <p className="ww-role">
            <span aria-hidden>{ROLE_INFO[me.role].icon}</span> {ROLE_INFO[me.role].name}
            <small>{ROLE_INFO[me.role].team}</small>
          </p>
          <p className="ww-role-desc">{ROLE_INFO[me.role].desc}</p>
          {me.role === "wolf" && me.wolves && me.wolves.length > 1 && (
            <p className="ww-role-desc">
              Đồng bọn:{" "}
              {me.wolves
                .filter((id) => id !== meId)
                .map(ctx.nameOf)
                .join(", ")}
            </p>
          )}
          {me.role === "witch" && (
            <p className="ww-role-desc">
              Bình cứu: {me.heal_left ? "còn" : "đã dùng"} · Bình độc: {me.poison_left ? "còn" : "đã dùng"}
            </p>
          )}
          {me.seer_log && me.seer_log.length > 0 && (
            <ul className="ww-seer">
              {me.seer_log.map((c) => (
                <li key={c.round}>
                  Đêm {c.round}: {ctx.nameOf(c.target)} — {c.wolf ? <b>🐺 là Sói</b> : "không phải Sói"}
                </li>
              ))}
            </ul>
          )}
        </SecretCard>
      )}

      {hint && <p className="game-hint">{hint}</p>}

      {step === "witch" && me && (
        <WitchPanel ctx={ctx} me={me} s={s} heal={heal} setHeal={setHeal} poison={poison} setPoison={setPoison} />
      )}

      <ul className="game-grid" aria-label="Dân làng">
        {game.players.map((p) => {
          const role = roleOf(p.id);
          const isDead = dead.has(p.id);
          const voters = s.phase === "day" ? votesFor(s.votes, p.id) : [];
          const wolfVoters = step === "wolf" ? votesFor(me?.wolf_votes, p.id) : [];
          const shownRole =
            role && (s.roles[p.id] || p.id === meId || wolfMates.has(p.id)) ? (
              <span className={`ww-badge ww-${role}`} title={ROLE_INFO[role].name} aria-label={ROLE_INFO[role].name}>
                {ROLE_INFO[role].icon}
              </span>
            ) : null;
          // vai đã lộ (người chết / hết ván) ghi dưới tên, để ô hẹp trên điện thoại không cắt tên
          const revealed = s.roles[p.id] ? ROLE_INFO[s.roles[p.id]].name : "";
          const sub = isDead
            ? `đã chết${revealed ? ` · ${revealed}` : ""}`
            : revealed || (wolfMates.has(p.id) && p.id !== meId ? "đồng bọn" : undefined);
          return (
            <li key={p.id}>
              <PlayerTile
                ctx={ctx}
                id={p.id}
                dead={isDead}
                selected={
                  pending === p.id ||
                  (step === "wolf" && me?.target === p.id) ||
                  (step === "vote" && s.votes?.[meId] === p.id)
                }
                winner={game.status === "ended" && game.winners?.includes(p.id)}
                sub={sub}
                badge={shownRole}
                onClick={canPick(p.id) ? () => onPick(p.id) : undefined}
              >
                <VoterDots ctx={ctx} ids={voters.length ? voters : wolfVoters} />
              </PlayerTile>
            </li>
          );
        })}
      </ul>

      {playing && (
        <div className="game-actions">
          {pending !== null && (step === "seer" || step === "guard" || step === "shoot") && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => act(step === "shoot" ? "shoot" : "night", { target: pending })}
            >
              {step === "seer" ? "Soi" : step === "guard" ? "Bảo vệ" : "Bắn"} {ctx.nameOf(pending)}
            </button>
          )}
          {step === "shoot" && (
            <button type="button" className="btn" disabled={busy} onClick={() => act("shoot", { target: 0 })}>
              Không bắn ai
            </button>
          )}
          {step === "vote" && s.votes?.[meId] === undefined && (
            <button type="button" className="btn" disabled={busy} onClick={() => act("vote", { target: 0 })}>
              Bỏ qua
            </button>
          )}
          {s.phase === "day" && game.host_id === meId && (
            <button type="button" className="btn" disabled={busy} onClick={() => act("skip_day")}>
              Chốt phiếu ngay
            </button>
          )}
          {s.phase === "day" && (
            <span className="game-hint">
              {Object.keys(s.votes ?? {}).length}/{game.players.length - s.dead.length} người đã bỏ phiếu
            </span>
          )}
          {ctx.isPlayer && game.host_id === meId && (
            <button type="button" className="link-btn game-cancel" disabled={busy} onClick={() => act("cancel")}>
              Huỷ ván
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function WitchPanel({
  ctx,
  me,
  s,
  heal,
  setHeal,
  poison,
  setPoison,
}: {
  ctx: Ctx;
  me: WerewolfMe;
  s: WerewolfState;
  heal: boolean;
  setHeal: (v: boolean) => void;
  poison: number;
  setPoison: (v: number) => void;
}) {
  const alive = ctx.game.players.filter((p) => !s.dead.includes(p.id) && p.id !== ctx.meId);
  return (
    <div className="ww-witch">
      <p>
        {me.victim ? (
          <>
            Đêm nay Sói cắn <b>{ctx.nameOf(me.victim)}</b>
            {me.victim === ctx.meId ? " (chính bạn!)" : ""}.
          </>
        ) : (
          "Đêm nay Sói không cắn ai."
        )}
      </p>
      {me.victim && me.heal_left ? (
        <label className="check-field">
          <input type="checkbox" checked={heal} onChange={(e) => setHeal(e.target.checked)} />
          <span>Dùng bình cứu cho {ctx.nameOf(me.victim)}</span>
        </label>
      ) : null}
      {me.poison_left && (
        <label className="field">
          <span>Bình độc</span>
          <select value={poison} onChange={(e) => setPoison(Number(e.target.value))}>
            <option value={0}>Không dùng</option>
            {alive.map((p) => (
              <option key={p.id} value={p.id}>
                Đầu độc {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        type="button"
        className="btn btn-primary"
        disabled={ctx.busy}
        onClick={() => ctx.act("witch", { heal, poison })}
      >
        {heal || poison ? "Xác nhận" : "Không làm gì, đi ngủ"}
      </button>
    </div>
  );
}

/* ---------- Ai là gián điệp ---------- */

function Spy({ ctx }: { ctx: Ctx }) {
  const { game, meId, busy, act } = ctx;
  const s = game.state as SpyState;
  const me = game.me as SpyMe | undefined;
  const [clue, setClue] = useState("");
  const playing = game.status === "playing";
  const out = new Set(s.out);
  const spies = new Set(s.spies ?? []);
  const myTurnNow = playing && s.phase === "describe" && s.speaker === meId;
  const myVote = s.votes?.[meId];
  const canVote = playing && s.phase === "vote" && !!me && !me.out;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (clue.trim()) {
      act("clue", { text: clue.trim() });
      setClue("");
    }
  };

  const rounds = new Map<number, SpyState["clues"]>();
  for (const c of s.clues) rounds.set(c.round, [...(rounds.get(c.round) ?? []), c]);

  return (
    <div className="spy">
      <div className="game-banner">
        {!playing ? (
          <span>Ván đã kết thúc sau {s.round} vòng</span>
        ) : s.phase === "describe" ? (
          <span>
            🗣️ Vòng {s.round} · lượt {s.speaker === meId ? "bạn" : ctx.nameOf(s.speaker ?? 0)} mô tả
          </span>
        ) : (
          <span>🗳️ Vòng {s.round} · bỏ phiếu tìm gián điệp</span>
        )}
        {playing && <Countdown deadline={game.deadline} />}
      </div>

      {me?.word && (
        <SecretCard label="Từ khoá của bạn">
          <p className="spy-word">{me.word}</p>
          <p className="ww-role-desc">
            Có {s.spy_count} gián điệp nhận từ khác. Bạn cũng có thể là gián điệp mà không biết: nghe kỹ mọi người mô
            tả!
          </p>
        </SecretCard>
      )}

      {s.words && (
        <p className="spy-reveal">
          Từ của dân: <b>{s.words[0]}</b> · Từ của gián điệp: <b>{s.words[1]}</b>
        </p>
      )}

      {s.clues.length > 0 && (
        <div className="spy-clues">
          {[...rounds.entries()].map(([r, list]) => (
            <section key={r}>
              <h4>Vòng {r}</h4>
              <ul>
                {list.map((c, i) => (
                  <li key={i}>
                    <b>{ctx.nameOf(c.player)}:</b> {c.text ? `“${c.text}”` : <em>(hết giờ, bỏ lượt)</em>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {myTurnNow && (
        <form className="spy-form" onSubmit={submit}>
          <input
            value={clue}
            onChange={(e) => setClue(e.target.value)}
            maxLength={80}
            placeholder="Mô tả từ của bạn (đừng nói thẳng ra)…"
            aria-label="Mô tả từ khoá"
            autoFocus
            disabled={busy}
          />
          <button className="btn btn-primary" disabled={busy || !clue.trim()}>
            Gửi
          </button>
        </form>
      )}

      <ul className="game-grid" aria-label="Người chơi">
        {(s.order && playing
          ? [...s.order, ...game.players.map((p) => p.id).filter((id) => !s.order!.includes(id))]
          : game.players.map((p) => p.id)
        ).map((id) => {
          const voters = s.phase === "vote" ? votesFor(s.votes, id) : [];
          const isOut = out.has(id);
          return (
            <li key={id}>
              <PlayerTile
                ctx={ctx}
                id={id}
                dead={isOut}
                selected={myVote === id || (s.phase === "describe" && s.speaker === id)}
                winner={game.status === "ended" && game.winners?.includes(id)}
                sub={
                  isOut
                    ? `đã bị loại · ${spies.has(id) ? "gián điệp" : "dân"}`
                    : spies.has(id)
                      ? "gián điệp"
                      : s.phase === "describe" && s.speaker === id
                        ? "đang mô tả…"
                        : undefined
                }
                badge={
                  spies.has(id) ? (
                    <span className="ww-badge ww-wolf" title="Gián điệp" aria-label="Gián điệp">
                      🕵️
                    </span>
                  ) : null
                }
                onClick={canVote && !isOut && id !== meId && !busy ? () => act("vote", { target: id }) : undefined}
              >
                <VoterDots ctx={ctx} ids={voters} />
              </PlayerTile>
            </li>
          );
        })}
      </ul>

      {playing && (
        <div className="game-actions">
          {canVote && myVote === undefined && (
            <button type="button" className="btn" disabled={busy} onClick={() => act("vote", { target: 0 })}>
              Bỏ qua
            </button>
          )}
          {canVote && (
            <span className="game-hint">
              {myVote === undefined ? "Bấm vào người bạn nghi là gián điệp." : "Đã bỏ phiếu, bấm người khác để đổi."}
            </span>
          )}
          {game.host_id === meId && (
            <button type="button" className="link-btn game-cancel" disabled={busy} onClick={() => act("cancel")}>
              Huỷ ván
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- Cờ caro ---------- */

function Caro({ ctx }: { ctx: Ctx }) {
  const { game, meId, busy, act } = ctx;
  const s = game.state as CaroState;
  const [x, o] = game.players;
  const myMove = game.status === "playing" && s.turn === meId;
  const myMark = x?.id === meId ? "X" : "O";

  const pieces = useMemo(() => {
    if (s.pieces) return s.pieces;
    const map: Record<string, "x" | "o"> = {};
    if (s.board) {
      for (let i = 0; i < s.board.length; i++) {
        const ch = s.board[i];
        if (ch === "x" || ch === "o") {
          map[`${Math.floor(i / s.size)},${i % s.size}`] = ch;
        }
      }
    }
    return map;
  }, [s.pieces, s.board, s.size]);

  const winCoords = useMemo(() => {
    if (s.win_coords && s.win_coords.length > 0) {
      return new Set(s.win_coords.map((c) => `${c.r},${c.c}`));
    }
    if (s.win && s.win.length > 0) {
      return new Set(s.win.map((idx) => `${Math.floor(idx / s.size)},${idx % s.size}`));
    }
    return new Set<string>();
  }, [s.win_coords, s.win, s.size]);

  const lastCoord = useMemo(() => {
    if (s.last_coord) return s.last_coord;
    if (s.last !== undefined && s.last >= 0) {
      return { r: Math.floor(s.last / s.size), c: s.last % s.size };
    }
    return null;
  }, [s.last_coord, s.last, s.size]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [cellSize, setCellSize] = useState(30);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const initializedRef = useRef(false);
  const [lbOpen, setLbOpen] = useState(false);

  const centerAt = useCallback((row: number, col: number, cs = cellSize) => {
    const c = containerRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    setPan({
      x: rect.width / 2 - (col + 0.5) * cs,
      y: rect.height / 2 - (row + 0.5) * cs,
    });
  }, [cellSize]);

  useEffect(() => {
    if (initializedRef.current) return;
    const c = containerRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      initializedRef.current = true;
      if (lastCoord) {
        centerAt(lastCoord.r, lastCoord.c);
      } else {
        centerAt(7, 7);
      }
    }
  }, [centerAt, lastCoord]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;

    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (width === 0 || height === 0) return;
    const dpr = window.devicePixelRatio || 1;

    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }

    ctx2d.save();
    ctx2d.scale(dpr, dpr);

    const computed = getComputedStyle(canvas);
    const surfaceColor = computed.getPropertyValue("--surface").trim() || "#ffffff";
    const canvasColor = computed.getPropertyValue("--canvas").trim() || "#f8fafc";
    const lineSoft = computed.getPropertyValue("--line-soft").trim() || "rgba(128,128,128,0.2)";
    const lineStrong = computed.getPropertyValue("--line").trim() || "rgba(128,128,128,0.45)";
    const u1Color = computed.getPropertyValue("--u1").trim() || "#2f6fb3";
    const u4Color = computed.getPropertyValue("--u4").trim() || "#e05252";
    const signalColor = computed.getPropertyValue("--signal").trim() || "#3b82f6";
    const signalSoft = computed.getPropertyValue("--signal-soft").trim() || "rgba(59,130,246,0.18)";
    const textSoft = computed.getPropertyValue("--text-soft").trim() || "#94a3b8";

    // 1. Clear full canvas
    ctx2d.fillStyle = canvasColor;
    ctx2d.fillRect(0, 0, width, height);

    // 2. Starting 15x15 court
    const courtLeft = 0 * cellSize + pan.x;
    const courtTop = 0 * cellSize + pan.y;
    const courtSize = 15 * cellSize;
    ctx2d.fillStyle = surfaceColor;
    ctx2d.fillRect(courtLeft, courtTop, courtSize, courtSize);
    ctx2d.strokeStyle = lineStrong;
    ctx2d.lineWidth = 1.5;
    ctx2d.strokeRect(courtLeft, courtTop, courtSize, courtSize);

    // 3. Grid lines
    const startCol = Math.floor(-pan.x / cellSize) - 1;
    const endCol = Math.ceil((width - pan.x) / cellSize) + 1;
    const startRow = Math.floor(-pan.y / cellSize) - 1;
    const endRow = Math.ceil((height - pan.y) / cellSize) + 1;

    ctx2d.lineWidth = 1;
    ctx2d.strokeStyle = lineSoft;
    ctx2d.beginPath();
    for (let c = startCol; c <= endCol; c++) {
      const xPos = Math.round(c * cellSize + pan.x) + 0.5;
      ctx2d.moveTo(xPos, 0);
      ctx2d.lineTo(xPos, height);
    }
    for (let r = startRow; r <= endRow; r++) {
      const yPos = Math.round(r * cellSize + pan.y) + 0.5;
      ctx2d.moveTo(0, yPos);
      ctx2d.lineTo(width, yPos);
    }
    ctx2d.stroke();

    // Hoshi reference points in standard 15x15
    const hoshi = [
      [7, 7],
      [3, 3],
      [3, 11],
      [11, 3],
      [11, 11],
    ];
    ctx2d.fillStyle = textSoft;
    for (const [hr, hc] of hoshi) {
      const cx = hc * cellSize + pan.x + cellSize / 2;
      const cy = hr * cellSize + pan.y + cellSize / 2;
      if (cx >= -5 && cx <= width + 5 && cy >= -5 && cy <= height + 5) {
        ctx2d.beginPath();
        ctx2d.arc(cx, cy, Math.max(2, cellSize * 0.08), 0, Math.PI * 2);
        ctx2d.fill();
      }
    }

    // 4. Winning line highlight
    if (winCoords.size > 0) {
      for (const key of winCoords) {
        const [r, c] = key.split(",").map(Number);
        const cellX = c * cellSize + pan.x;
        const cellY = r * cellSize + pan.y;
        if (cellX + cellSize >= 0 && cellX <= width && cellY + cellSize >= 0 && cellY <= height) {
          ctx2d.fillStyle = signalSoft;
          ctx2d.fillRect(cellX, cellY, cellSize, cellSize);
          ctx2d.strokeStyle = signalColor;
          ctx2d.lineWidth = 2;
          ctx2d.strokeRect(cellX + 1, cellY + 1, cellSize - 2, cellSize - 2);
        }
      }
    }

    // 5. Last move highlight
    if (lastCoord) {
      const cellX = lastCoord.c * cellSize + pan.x;
      const cellY = lastCoord.r * cellSize + pan.y;
      if (cellX + cellSize >= 0 && cellX <= width && cellY + cellSize >= 0 && cellY <= height) {
        ctx2d.fillStyle = signalSoft;
        ctx2d.fillRect(cellX, cellY, cellSize, cellSize);
        ctx2d.strokeStyle = signalColor;
        ctx2d.lineWidth = 1.5;
        ctx2d.setLineDash([3, 3]);
        ctx2d.strokeRect(cellX + 1.5, cellY + 1.5, cellSize - 3, cellSize - 3);
        ctx2d.setLineDash([]);
      }
    }

    // 6. Hover preview (ghost mark)
    if (hover && myMove && !pieces[`${hover.r},${hover.c}`] && !busy) {
      const cellX = hover.c * cellSize + pan.x;
      const cellY = hover.r * cellSize + pan.y;
      if (cellX + cellSize >= 0 && cellX <= width && cellY + cellSize >= 0 && cellY <= height) {
        ctx2d.fillStyle = signalSoft;
        ctx2d.fillRect(cellX, cellY, cellSize, cellSize);

        ctx2d.font = `800 ${Math.round(cellSize * 0.65)}px sans-serif`;
        ctx2d.textAlign = "center";
        ctx2d.textBaseline = "middle";
        ctx2d.fillStyle = myMark === "X" ? u1Color : u4Color;
        ctx2d.globalAlpha = 0.45;
        ctx2d.fillText(myMark, cellX + cellSize / 2, cellY + cellSize / 2);
        ctx2d.globalAlpha = 1.0;
      }
    }

    // 7. Placed pieces
    ctx2d.font = `800 ${Math.round(cellSize * 0.65)}px sans-serif`;
    ctx2d.textAlign = "center";
    ctx2d.textBaseline = "middle";

    for (const [key, mark] of Object.entries(pieces)) {
      const [r, c] = key.split(",").map(Number);
      const cellX = c * cellSize + pan.x;
      const cellY = r * cellSize + pan.y;
      if (cellX + cellSize < 0 || cellX > width || cellY + cellSize < 0 || cellY > height) {
        continue;
      }
      const upper = mark.toUpperCase();
      const isWin = winCoords.has(key);
      ctx2d.fillStyle = isWin ? signalColor : upper === "X" ? u1Color : u4Color;
      ctx2d.fillText(upper, cellX + cellSize / 2, cellY + cellSize / 2);
    }

    ctx2d.restore();
  }, [cellSize, pan, pieces, winCoords, lastCoord, hover, myMove, busy, myMark]);

  const pointerRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
    isDrag: boolean;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerRef.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      panX: pan.x,
      panY: pan.y,
      isDrag: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = pointerRef.current;
    const rect = e.currentTarget.getBoundingClientRect();
    if (p && p.id === e.pointerId) {
      const dx = e.clientX - p.startX;
      const dy = e.clientY - p.startY;
      if (!p.isDrag && Math.hypot(dx, dy) > 4) {
        p.isDrag = true;
        setDragging(true);
      }
      if (p.isDrag) {
        setPan({ x: p.panX + dx, y: p.panY + dy });
        return;
      }
    }
    const col = Math.floor((e.clientX - rect.left - pan.x) / cellSize);
    const row = Math.floor((e.clientY - rect.top - pan.y) / cellSize);
    if (!hover || hover.r !== row || hover.c !== col) {
      setHover({ r: row, c: col });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = pointerRef.current;
    if (!p || p.id !== e.pointerId) return;
    pointerRef.current = null;
    setDragging(false);

    if (!p.isDrag) {
      const rect = e.currentTarget.getBoundingClientRect();
      const col = Math.floor((e.clientX - rect.left - pan.x) / cellSize);
      const row = Math.floor((e.clientY - rect.top - pan.y) / cellSize);
      if (myMove && !pieces[`${row},${col}`] && !busy) {
        act("move", { r: row, c: col });
      }
    }
  };

  const onPointerCancel = () => {
    pointerRef.current = null;
    setDragging(false);
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
    const newCellSize = Math.max(18, Math.min(64, Math.round(cellSize * zoomFactor)));
    if (newCellSize === cellSize) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const scale = newCellSize / cellSize;
    const newPanX = mouseX - (mouseX - pan.x) * scale;
    const newPanY = mouseY - (mouseY - pan.y) * scale;

    setCellSize(newCellSize);
    setPan({ x: newPanX, y: newPanY });
  };

  return (
    <div className="caro">
      <div className="caro-players">
        {[x, o].map((p, i) =>
          p ? (
            <span key={p.id} className={`caro-side${s.turn === p.id ? " is-turn" : ""}`}>
              <b className={`caro-mark caro-${i ? "o" : "x"}`}>{i ? "O" : "X"}</b>
              <Avatar user={ctx.user(p.id)} size={20} />
              {p.id === meId ? "Bạn" : p.name}
            </span>
          ) : null,
        )}
        {game.status === "playing" && <Countdown deadline={game.deadline} label="Thời gian nước đi" />}
      </div>
      <div className="caro-board-container" ref={containerRef}>
        <canvas
          ref={canvasRef}
          className={`caro-canvas${dragging ? " is-dragging" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onPointerLeave={() => setHover(null)}
          onWheel={onWheel}
          aria-label="Bàn cờ caro vô hạn. Kéo để di chuyển bàn cờ, bấm để đánh cờ."
        />
        <div className="caro-toolbar">
          <button
            type="button"
            className="caro-tool-btn"
            title="Về trung tâm (bàn 15×15 ban đầu)"
            onClick={() => centerAt(7, 7)}
          >
            🎯 Về tâm
          </button>
          {lastCoord && (
            <button
              type="button"
              className="caro-tool-btn"
              title="Xem nước đi mới nhất"
              onClick={() => centerAt(lastCoord.r, lastCoord.c)}
            >
              📍 Nước cuối
            </button>
          )}
          <button
            type="button"
            className="caro-tool-btn"
            title="Phóng to"
            onClick={() => {
              const newSize = Math.min(64, cellSize + 4);
              setCellSize(newSize);
            }}
          >
            +
          </button>
          <button
            type="button"
            className="caro-tool-btn"
            title="Thu nhỏ"
            onClick={() => {
              const newSize = Math.max(18, cellSize - 4);
              setCellSize(newSize);
            }}
          >
            −
          </button>
        </div>
        <span className="caro-pan-hint">🖱️ Kéo để di chuyển</span>
      </div>
      <div className="game-actions">
        {game.status === "playing" && (
          <span className="game-hint">
            {myMove ? "Tới lượt bạn." : `Chờ ${ctx.nameOf(s.turn ?? 0)} đánh…`} Nước thứ {s.moves + 1}.
          </span>
        )}
        <button type="button" className="link-btn" onClick={() => setLbOpen(true)}>
          🏆 Bảng xếp hạng
        </button>
        {game.status === "playing" && ctx.isPlayer && (
          <button type="button" className="link-btn game-cancel" disabled={busy} onClick={() => act("resign")}>
            Chịu thua
          </button>
        )}
      </div>
      {lbOpen && <GameLeaderboardDialog initialKind="caro" onClose={() => setLbOpen(false)} />}
    </div>
  );
}

/* ---------- Cờ vua (Chess) ---------- */

function Chess({ ctx }: { ctx: Ctx }) {
  const { game, meId, busy, act } = ctx;
  const s = game.state as ChessState;
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: string; to: string } | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [manualFlip, setManualFlip] = useState<boolean | null>(null);
  const [lbOpen, setLbOpen] = useState(false);

  const whitePlayer = game.players.find((p) => p.id === s.white_player_id);
  const blackPlayer = game.players.find((p) => p.id === s.black_player_id);
  const isWhite = s.white_player_id === meId;
  const isBlack = s.black_player_id === meId;
  const isPlayer = isWhite || isBlack;
  const isMyTurn = game.status === "playing" && s.turn_player_id === meId;

  // Tự động xoay bàn cờ nếu mình cầm Đen (có thể lật tay tuỳ ý)
  const flipped = manualFlip !== null ? manualFlip : isBlack;

  // Danh sách nước đi hợp lệ từ ô đang chọn
  const validTargets = useMemo(() => {
    if (!selectedSquare || !s.legal_moves) return new Set<string>();
    const moves = s.legal_moves[selectedSquare] || [];
    return new Set(moves.map((m) => m.slice(0, 2)));
  }, [selectedSquare, s.legal_moves]);

  // Kiểm tra quân cờ có thuộc phe mình không
  const isMyPiece = useCallback(
    (pieceChar: string) => {
      if (!pieceChar || pieceChar === ".") return false;
      if (isWhite) return pieceChar >= "A" && pieceChar <= "Z";
      if (isBlack) return pieceChar >= "a" && pieceChar <= "z";
      return false;
    },
    [isWhite, isBlack]
  );

  const onSquareClick = (sq: string, pieceChar: string) => {
    if (!isMyTurn || busy) return;

    if (selectedSquare) {
      if (selectedSquare === sq) {
        setSelectedSquare(null);
        return;
      }
      if (validTargets.has(sq)) {
        // Nước đi hợp lệ!
        // Kiểm tra phong cấp: Tốt trắng tới hàng 8 hoặc Tốt đen tới hàng 1
        const selIdx = (selectedSquare.charCodeAt(1) - 49) * 8 + (selectedSquare.charCodeAt(0) - 97);
        const movingPiece = s.board ? s.board[selIdx] : "";
        const isPromo =
          (movingPiece === "P" && sq[1] === "8") ||
          (movingPiece === "p" && sq[1] === "1");

        if (isPromo) {
          setPendingPromotion({ from: selectedSquare, to: sq });
        } else {
          act("move", { from: selectedSquare, to: sq });
          setSelectedSquare(null);
        }
        return;
      }
      // Nếu bấm vào quân khác của phe mình -> đổi chọn quân đó
      if (isMyPiece(pieceChar)) {
        setSelectedSquare(sq);
        return;
      }
      // Bấm ra ngoài -> bỏ chọn
      setSelectedSquare(null);
    } else {
      if (isMyPiece(pieceChar)) {
        setSelectedSquare(sq);
      }
    }
  };

  const ranks = flipped ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const files = flipped ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];

  // Tính điểm chênh lệch lực lượng
  const pieceValues: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  let whiteMaterialLoss = 0;
  let blackMaterialLoss = 0;
  if (s.captured) {
    for (const [p, count] of Object.entries(s.captured)) {
      const val = pieceValues[p.toLowerCase()] || 0;
      if (p >= "A" && p <= "Z") {
        whiteMaterialLoss += val * count;
      } else {
        blackMaterialLoss += val * count;
      }
    }
  }
  const whiteAdvantage = blackMaterialLoss - whiteMaterialLoss;
  const blackAdvantage = whiteMaterialLoss - blackMaterialLoss;

  const topPlayer = flipped ? whitePlayer : blackPlayer;
  const topColor = flipped ? "white" : "black";
  const topAdvantage = flipped ? whiteAdvantage : blackAdvantage;

  const bottomPlayer = flipped ? blackPlayer : whitePlayer;
  const bottomColor = flipped ? "black" : "white";
  const bottomAdvantage = flipped ? blackAdvantage : whiteAdvantage;

  return (
    <div className="chess-container">
      {/* Thông báo chiếu */}
      {game.status === "playing" && s.in_check && (
        <div className="chess-banner is-check">
          <span>⚠️ {s.turn_color === "w" ? "Trắng" : "Đen"} đang bị chiếu!</span>
        </div>
      )}

      {/* Thông báo đề nghị hoà */}
      {game.status === "playing" && s.draw_offered && (
        <div className="chess-banner is-draw-offer">
          {s.draw_offered_by === meId ? (
            <span>Bạn đã đề nghị hoà cờ. Đang chờ đối thủ trả lời...</span>
          ) : (
            <>
              <span>Đối thủ đề nghị hoà cờ:</span>
              <div style={{ display: "flex", gap: "0.4rem" }}>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => act("draw_accept")}
                >
                  Đồng ý hoà
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  disabled={busy}
                  onClick={() => act("draw_decline")}
                >
                  Từ chối
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Thông tin đối thủ (ở trên) */}
      <div className="chess-player-bar">
        <div className="chess-player-info">
          <span className={`chess-color-badge ${topColor}`} aria-hidden>
            {topColor === "white" ? "⚪" : "⚫"}
          </span>
          <span>
            {topPlayer?.name || (topColor === "white" ? "Quân Trắng" : "Quân Đen")}
            {topPlayer?.id === meId ? " (Bạn)" : ""}
          </span>
          {topAdvantage > 0 && <span className="chess-advantage">+{topAdvantage}</span>}
          {/* Quân bị ăn */}
          <div className="chess-captured-list">
            {Object.entries(s.captured || {}).map(([p, count]) => {
              const isThisSide = topColor === "white" ? p >= "a" && p <= "z" : p >= "A" && p <= "Z";
              if (!isThisSide) return null;
              return Array.from({ length: count }).map((_, i) => (
                <span key={`${p}-${i}`} className="chess-captured-item">
                  <ChessPiece piece={p} />
                </span>
              ));
            })}
          </div>
        </div>
        {game.status === "playing" && s.turn_color === (topColor === "white" ? "w" : "b") && (
          <Countdown deadline={game.deadline} label="Thời gian nước đi" />
        )}
      </div>

      {/* Bàn cờ 8×8 */}
      <div className="chess-board-wrapper">
        <div className="chess-board" role="grid" aria-label="Bàn cờ vua">
          {ranks.map((r, rIdx) =>
            files.map((f, fIdx) => {
              const sq = `${String.fromCharCode(97 + f)}${r + 1}`;
              const idx = r * 8 + f;
              const pieceChar = s.board ? s.board[idx] : ".";
              const isLight = (r + f) % 2 === 1;
              const isSelected = selectedSquare === sq;
              const isLastMove = s.last_move && (s.last_move.from === sq || s.last_move.to === sq);
              const isInCheck = s.in_check && s.check_square === sq;
              const isTarget = validTargets.has(sq);
              const hasEnemy = pieceChar !== "." && !isMyPiece(pieceChar);

              return (
                <button
                  key={sq}
                  type="button"
                  className={`chess-square ${isLight ? "is-light" : "is-dark"}${
                    isSelected ? " is-selected" : ""
                  }${isLastMove ? " is-last-move" : ""}${isInCheck ? " is-in-check" : ""}`}
                  onClick={() => onSquareClick(sq, pieceChar)}
                  onDragOver={(e) => {
                    if (isTarget) {
                      e.preventDefault();
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = e.dataTransfer.getData("text/plain");
                    if (from && isTarget) {
                      const selIdx = (from.charCodeAt(1) - 49) * 8 + (from.charCodeAt(0) - 97);
                      const movingPiece = s.board ? s.board[selIdx] : "";
                      const isPromo =
                        (movingPiece === "P" && sq[1] === "8") ||
                        (movingPiece === "p" && sq[1] === "1");
                      if (isPromo) {
                        setPendingPromotion({ from, to: sq });
                      } else {
                        act("move", { from, to: sq });
                        setSelectedSquare(null);
                      }
                    }
                  }}
                  aria-label={`${sq}: ${pieceChar !== "." ? pieceChar : "ô trống"}`}
                >
                  {/* Toạ độ hàng/cột */}
                  {fIdx === 0 && <span className="chess-coord-rank">{r + 1}</span>}
                  {rIdx === 7 && <span className="chess-coord-file">{String.fromCharCode(97 + f)}</span>}

                  {/* Quân cờ */}
                  {pieceChar !== "." && (
                    <span
                      draggable={isMyTurn && isMyPiece(pieceChar)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", sq);
                        setSelectedSquare(sq);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "100%",
                        height: "100%",
                        cursor: isMyTurn && isMyPiece(pieceChar) ? "grab" : "default",
                      }}
                    >
                      <ChessPiece piece={pieceChar} />
                    </span>
                  )}

                  {/* Chấm gợi ý nước đi */}
                  {isTarget && (
                    <span className={hasEnemy ? "chess-hint-capture" : "chess-hint-dot"} />
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Modal phong cấp Tốt */}
        {pendingPromotion && (
          <div className="chess-promotion-modal">
            <div className="chess-promotion-content">
              <div className="chess-promotion-title">Chọn quân phong cấp:</div>
              <div className="chess-promotion-choices">
                {(["q", "r", "b", "n"] as const).map((pr) => {
                  const promoChar = isWhite ? pr.toUpperCase() : pr;
                  const label = pr === "q" ? "Hậu" : pr === "r" ? "Xe" : pr === "b" ? "Tượng" : "Mã";
                  return (
                    <button
                      key={pr}
                      type="button"
                      className="chess-promotion-btn"
                      onClick={() => {
                        act("move", { from: pendingPromotion.from, to: pendingPromotion.to, promotion: pr });
                        setPendingPromotion(null);
                        setSelectedSquare(null);
                      }}
                    >
                      <ChessPiece piece={promoChar} />
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ width: "100%" }}
                onClick={() => setPendingPromotion(null)}
              >
                Huỷ
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Thông tin phe ở dưới (thường là mình) */}
      <div className="chess-player-bar" style={{ marginTop: "0.35rem" }}>
        <div className="chess-player-info">
          <span className={`chess-color-badge ${bottomColor}`} aria-hidden>
            {bottomColor === "white" ? "⚪" : "⚫"}
          </span>
          <span>
            {bottomPlayer?.name || (bottomColor === "white" ? "Quân Trắng" : "Quân Đen")}
            {bottomPlayer?.id === meId ? " (Bạn)" : ""}
          </span>
          {bottomAdvantage > 0 && <span className="chess-advantage">+{bottomAdvantage}</span>}
          {/* Quân bị ăn */}
          <div className="chess-captured-list">
            {Object.entries(s.captured || {}).map(([p, count]) => {
              const isThisSide = bottomColor === "white" ? p >= "a" && p <= "z" : p >= "A" && p <= "Z";
              if (!isThisSide) return null;
              return Array.from({ length: count }).map((_, i) => (
                <span key={`${p}-${i}`} className="chess-captured-item">
                  <ChessPiece piece={p} />
                </span>
              ));
            })}
          </div>
        </div>
        {game.status === "playing" && s.turn_color === (bottomColor === "white" ? "w" : "b") && (
          <Countdown deadline={game.deadline} label="Thời gian nước đi" />
        )}
      </div>

      {/* Thanh công cụ / Hành động */}
      <div className="chess-actions">
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setManualFlip((prev) => (prev === null ? !isBlack : !prev))}
            title="Xoay bàn cờ"
          >
            🔄 Lật bàn
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={ctx.openThread}
            title="Mở luồng bình luận / Khán đài"
          >
            💬 Khán đài {ctx.replyCount ? `(${ctx.replyCount})` : ""}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setLbOpen(true)}
          >
            🏆 Xếp hạng
          </button>
        </div>

        {game.status === "playing" && isPlayer && (
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy || s.draw_offered}
              onClick={() => act("draw_offer")}
              title="Gửi lời đề nghị hoà cho đối thủ"
            >
              🤝 Cầu hoà
            </button>
            {confirmResign ? (
              <div style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={busy}
                  onClick={() => {
                    act("resign");
                    setConfirmResign(false);
                  }}
                >
                  Xác nhận chịu thua
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setConfirmResign(false)}
                >
                  Huỷ
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() => setConfirmResign(true)}
              >
                🏳️ Chịu thua
              </button>
            )}
          </div>
        )}
      </div>

      {lbOpen && <GameLeaderboardDialog initialKind="chess" onClose={() => setLbOpen(false)} />}
    </div>
  );
}

/* ---------- Cờ tướng (Xiangqi) ---------- */

function Xiangqi({ ctx }: { ctx: Ctx }) {
  const [lbOpen, setLbOpen] = useState(false);
  return (
    <>
      <XiangqiGame
        ctx={{
          ...ctx,
          onOpenLeaderboard: () => setLbOpen(true),
          onOpenThread: ctx.openThread,
        }}
      />
      {lbOpen && <GameLeaderboardDialog initialKind="xiangqi" onClose={() => setLbOpen(false)} />}
    </>
  );
}

/* ---------- Oẳn tù tì ---------- */

const RPS: { id: RpsChoice; icon: string; name: string }[] = [
  { id: "rock", icon: "✊", name: "Búa" },
  { id: "paper", icon: "✋", name: "Bao" },
  { id: "scissors", icon: "✌️", name: "Kéo" },
];
const rpsIcon = (c: string) => RPS.find((r) => r.id === c)?.icon ?? "—";

function Rps({ ctx }: { ctx: Ctx }) {
  const { game, meId, busy, act } = ctx;
  const s = game.state as RpsState;
  const me = game.me as RpsMe | undefined;
  const playing = game.status === "playing";
  return (
    <div className="rps">
      <div className="rps-score">
        {game.players.map((p, i) => (
          <div key={p.id} className="rps-side">
            <Avatar user={ctx.user(p.id)} size={34} />
            <span className="rps-name">{p.id === meId ? "Bạn" : p.name}</span>
            {playing && <span className="rps-ready">{s.ready[i] ? "đã ra ✓" : "đang nghĩ…"}</span>}
          </div>
        ))}
        <p className="rps-points" aria-label="Tỉ số">
          {s.score[0]} – {s.score[1]}
        </p>
      </div>
      {playing && (
        <div className="game-banner">
          <span>Ván {s.rounds.length + 1}</span>
          <Countdown deadline={game.deadline} />
        </div>
      )}
      {playing && ctx.isPlayer && (
        <div className="rps-picks" role="group" aria-label="Ra tay">
          {RPS.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`rps-pick${me?.pick === r.id ? " is-picked" : ""}`}
              disabled={busy || !!me?.pick}
              onClick={() => act("pick", { choice: r.id })}
            >
              <span aria-hidden>{r.icon}</span>
              {r.name}
            </button>
          ))}
        </div>
      )}
      {s.rounds.length > 0 && (
        <ol className="rps-rounds">
          {s.rounds
            .map((r, i) => (
              <li key={i}>
                Ván {i + 1}: {rpsIcon(r.picks[0])} vs {rpsIcon(r.picks[1])} →{" "}
                {r.winner ? (r.winner === meId ? "bạn thắng" : `${ctx.nameOf(r.winner)} thắng`) : "hoà"}
              </li>
            ))
            .reverse()}
        </ol>
      )}
      {playing && ctx.isPlayer && (
        <div className="game-actions">
          <button type="button" className="link-btn game-cancel" disabled={busy} onClick={() => act("resign")}>
            Chịu thua
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- Mở phòng chơi ---------- */

export function CreateGameDialog({ channelId, dm, onClose }: { channelId: number; dm: boolean; onClose: () => void }) {
  const { createGame } = useChat();
  const kinds = (Object.keys(GAME_INFO) as GameKind[]).filter((k) => !dm || k === "caro" || k === "rps" || k === "chess" || k === "xiangqi");
  const [kind, setKind] = useState<GameKind>(kinds[0]);
  const [day, setDay] = useState(120);
  const [night, setNight] = useState(45);
  const [hideRoles, setHideRoles] = useState(false);
  const [spies, setSpies] = useState(0);
  const [blockRule, setBlockRule] = useState(true);
  const [chessMinutes, setChessMinutes] = useState(3);
  const [chessFirst, setChessFirst] = useState<"random" | "host" | "guest">("random");
  const [xiangqiMinutes, setXiangqiMinutes] = useState(3);
  const [xiangqiFirst, setXiangqiFirst] = useState<"random" | "host" | "guest">("random");
  const [bestOf, setBestOf] = useState(3);
  const [st, setSt] = useState({
    traitors: 0,
    kill_cooldown: 25,
    tasks: 5,
    discuss: 30,
    vote: 60,
    emergencies: 1,
    hide_ejects: false,
  });
  const setOpt = (k: keyof typeof st, v: number | boolean) => setSt((o) => ({ ...o, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const options: Record<GameKind, Record<string, unknown>> = {
      station: st,
      werewolf: { day_seconds: day, night_seconds: night, hide_roles: hideRoles },
      spy: { spies },
      caro: { free_style: !blockRule },
      chess: { turn_minutes: chessMinutes, first: chessFirst },
      xiangqi: { turn_minutes: xiangqiMinutes, first: xiangqiFirst },
      rps: { best_of: bestOf },
    };
    try {
      await createGame(channelId, kind, options[kind]);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Không mở được phòng.");
      setBusy(false);
    }
  };

  return (
    <Dialog title="Chơi game" onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        <div className="game-picker" role="radiogroup" aria-label="Trò chơi">
          {kinds.map((k) => (
            <label key={k} className={`game-pick${kind === k ? " is-chosen" : ""}`}>
              <input type="radio" name="game-kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
              <span className="game-pick-icon" aria-hidden>
                {GAME_INFO[k].icon}
              </span>
              <span className="game-pick-text">
                <b>{GAME_INFO[k].title}</b>
                <small>{GAME_INFO[k].players}</small>
                <span>{GAME_INFO[k].blurb}</span>
              </span>
            </label>
          ))}
        </div>

        {kind === "station" && (
          <>
            <div className="game-opts">
              <label className="field">
                <span>Số kẻ phản bội</span>
                <select value={st.traitors} onChange={(e) => setOpt("traitors", Number(e.target.value))}>
                  <option value={0}>Tự động (1 / 2 / 3)</option>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                </select>
              </label>
              <label className="field">
                <span>Hồi chiêu giết</span>
                <select value={st.kill_cooldown} onChange={(e) => setOpt("kill_cooldown", Number(e.target.value))}>
                  {[15, 20, 25, 30, 45].map((v) => (
                    <option key={v} value={v}>
                      {v} giây
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Nhiệm vụ mỗi người</span>
                <select value={st.tasks} onChange={(e) => setOpt("tasks", Number(e.target.value))}>
                  {[3, 4, 5, 6, 8].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Lượt họp khẩn mỗi người</span>
                <select value={st.emergencies} onChange={(e) => setOpt("emergencies", Number(e.target.value))}>
                  {[1, 2, 3].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Thảo luận</span>
                <select value={st.discuss} onChange={(e) => setOpt("discuss", Number(e.target.value))}>
                  {[15, 30, 45, 60, 90].map((v) => (
                    <option key={v} value={v}>
                      {v} giây
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Bỏ phiếu</span>
                <select value={st.vote} onChange={(e) => setOpt("vote", Number(e.target.value))}>
                  {[30, 60, 90, 120].map((v) => (
                    <option key={v} value={v}>
                      {v} giây
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="check-field">
              <input
                type="checkbox"
                checked={st.hide_ejects}
                onChange={(e) => setOpt("hide_ejects", e.target.checked)}
              />
              <span>
                Giấu danh tính người bị đẩy ra
                <small>Không cho biết người bị loại có phải kẻ phản bội không (khó hơn).</small>
              </span>
            </label>
          </>
        )}
        {kind === "werewolf" && (
          <>
            <div className="game-opts">
              <label className="field">
                <span>Ban ngày (thảo luận + bỏ phiếu)</span>
                <select value={day} onChange={(e) => setDay(Number(e.target.value))}>
                  <option value={60}>1 phút</option>
                  <option value={120}>2 phút</option>
                  <option value={180}>3 phút</option>
                  <option value={300}>5 phút</option>
                </select>
              </label>
              <label className="field">
                <span>Ban đêm</span>
                <select value={night} onChange={(e) => setNight(Number(e.target.value))}>
                  <option value={30}>30 giây</option>
                  <option value={45}>45 giây</option>
                  <option value={60}>1 phút</option>
                  <option value={90}>1 phút 30</option>
                </select>
              </label>
            </div>
            <label className="check-field">
              <input type="checkbox" checked={hideRoles} onChange={(e) => setHideRoles(e.target.checked)} />
              <span>
                Giấu vai người chết
                <small>Chỉ lộ vai của mọi người khi hết ván (khó hơn).</small>
              </span>
            </label>
          </>
        )}
        {kind === "spy" && (
          <label className="field">
            <span>Số gián điệp</span>
            <select value={spies} onChange={(e) => setSpies(Number(e.target.value))}>
              <option value={0}>Tự động (1, từ 8 người là 2)</option>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
        )}
        {kind === "caro" && (
          <label className="check-field">
            <input type="checkbox" checked={blockRule} onChange={(e) => setBlockRule(e.target.checked)} />
            <span>
              Luật chặn hai đầu
              <small>Hàng 5 bị chặn cả hai đầu thì không tính thắng.</small>
            </span>
          </label>
        )}
        {kind === "chess" && (
          <>
            <label className="field">
              <span>Thời gian mỗi nước đi</span>
              <select value={chessMinutes} onChange={(e) => setChessMinutes(Number(e.target.value))}>
                <option value={1}>1 phút (Chớp - Blitz)</option>
                <option value={3}>3 phút (Tiêu chuẩn)</option>
                <option value={5}>5 phút (Nhanh - Rapid)</option>
                <option value={10}>10 phút (Dài)</option>
              </select>
            </label>
            <label className="field">
              <span>Cầm quân Trắng (đi trước)</span>
              <select value={chessFirst} onChange={(e) => setChessFirst(e.target.value as any)}>
                <option value="random">Ngẫu nhiên (50/50)</option>
                <option value="host">Chủ phòng cầm Trắng</option>
                <option value="guest">Khách cầm Trắng</option>
              </select>
            </label>
          </>
        )}
        {kind === "xiangqi" && (
          <>
            <label className="field">
              <span>Thời gian mỗi nước đi</span>
              <select value={xiangqiMinutes} onChange={(e) => setXiangqiMinutes(Number(e.target.value))}>
                <option value={1}>1 phút (Chớp)</option>
                <option value={3}>3 phút (Tiêu chuẩn)</option>
                <option value={5}>5 phút (Nhanh)</option>
                <option value={10}>10 phút (Dài)</option>
              </select>
            </label>
            <label className="field">
              <span>Cầm quân Đỏ (đi trước)</span>
              <select value={xiangqiFirst} onChange={(e) => setXiangqiFirst(e.target.value as any)}>
                <option value="random">Ngẫu nhiên (50/50)</option>
                <option value="host">Chủ phòng cầm Đỏ</option>
                <option value="guest">Khách cầm Đỏ</option>
              </select>
            </label>
          </>
        )}
        {kind === "rps" && (
          <label className="field">
            <span>Thể thức</span>
            <select value={bestOf} onChange={(e) => setBestOf(Number(e.target.value))}>
              <option value={1}>1 ván quyết định</option>
              <option value={3}>Chạm 2 (3 ván)</option>
              <option value={5}>Chạm 3 (5 ván)</option>
            </select>
          </label>
        )}

        <FormError>{error}</FormError>
        <div className="dialog-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setLeaderboardOpen(true)}
            style={{ marginRight: "auto" }}
          >
            🏆 Bảng xếp hạng
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Huỷ
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "Đang mở…" : "Mở phòng"}
          </button>
        </div>
      </form>
      {leaderboardOpen && <GameLeaderboardDialog initialKind={kind} onClose={() => setLeaderboardOpen(false)} />}
    </Dialog>
  );
}

/* ---------- Bảng xếp hạng trò chơi ---------- */

export function GameLeaderboardDialog({
  initialKind = "caro",
  onClose,
}: {
  initialKind?: string;
  onClose: () => void;
}) {
  const { api } = useChat();
  const [kind, setKind] = useState<string>(initialKind);
  const [data, setData] = useState<GameLeaderboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      ?.gameLeaderboard(kind)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Không tải được bảng xếp hạng.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, kind]);

  const tabs: { id: string; label: string }[] = [
    { id: "caro", label: "Cờ caro" },
    { id: "chess", label: "Cờ vua" },
    { id: "xiangqi", label: "Cờ tướng" },
    { id: "all", label: "Tất cả game" },
    { id: "rps", label: "Oẳn tù tì" },
    { id: "werewolf", label: "Ma Sói" },
    { id: "spy", label: "Gián điệp" },
    { id: "station", label: "Trạm vũ trụ" },
  ];

  return (
    <Dialog title="🏆 Bảng xếp hạng trò chơi" onClose={onClose} wide>
      <div className="lb-container">
        <div className="lb-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`lb-tab${kind === t.id ? " is-active" : ""}`}
              onClick={() => setKind(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="lb-loading">Đang tải bảng xếp hạng…</div>
        ) : error ? (
          <div className="lb-error">{error}</div>
        ) : !data || data.total_ended === 0 ? (
          <div className="lb-empty">
            <p>Chưa có ván chơi nào hoàn thành cho mục này.</p>
            <small>Hãy rủ bạn bè vào phòng cùng chơi để vinh danh trên bảng xếp hạng nhé!</small>
          </div>
        ) : (
          <div className="lb-body">
            {/* Top 10 Thắng & Top 10 Thua */}
            <div className="lb-top-grid">
              {/* Top 10 Thắng */}
              <div className="lb-top-card lb-top-wins">
                <div className="lb-card-header">
                  <h3>🥇 Top 10 Số Bàn Thắng</h3>
                  <span>{data.top_wins.length} thành viên</span>
                </div>
                <div className="lb-top-list">
                  {data.top_wins.length === 0 ? (
                    <p className="lb-subtle">Chưa có ai thắng trận nào.</p>
                  ) : (
                    data.top_wins.map((m, idx) => (
                      <div key={m.user_id} className={`lb-item rank-${idx + 1}`}>
                        <span className="lb-rank">
                          {idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `#${idx + 1}`}
                        </span>
                        <Avatar
                          user={
                            {
                              id: m.user_id,
                              username: m.username,
                              display_name: m.display_name,
                              avatar: m.avatar,
                            } as PublicUser
                          }
                          size={28}
                        />
                        <div className="lb-user-info">
                          <span className="lb-name">{m.display_name || m.username}</span>
                          <span className="lb-sub">
                            {m.tier_badge || "🥈"} {m.rating ?? 1200} Elo · Thắng: {m.win_rate}%
                          </span>
                        </div>
                        <div className="lb-stat-badge win-badge">
                          <b>{m.wins}</b> thắng
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Top 10 Thua */}
              <div className="lb-top-card lb-top-losses">
                <div className="lb-card-header">
                  <h3>💀 Top 10 Số Bàn Thua</h3>
                  <span>{data.top_losses.length} thành viên</span>
                </div>
                <div className="lb-top-list">
                  {data.top_losses.length === 0 ? (
                    <p className="lb-subtle">Chưa có ai thua trận nào.</p>
                  ) : (
                    data.top_losses.map((m, idx) => (
                      <div key={m.user_id} className={`lb-item rank-${idx + 1}`}>
                        <span className="lb-rank">#{idx + 1}</span>
                        <Avatar
                          user={
                            {
                              id: m.user_id,
                              username: m.username,
                              display_name: m.display_name,
                              avatar: m.avatar,
                            } as PublicUser
                          }
                          size={28}
                        />
                        <div className="lb-user-info">
                          <span className="lb-name">{m.display_name || m.username}</span>
                          <span className="lb-sub">Tổng: {m.total_games} ván</span>
                        </div>
                        <div className="lb-stat-badge loss-badge">
                          <b>{m.losses}</b> thua
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Bảng xếp hạng chi tiết tất cả thành viên */}
            <div className="lb-table-wrap">
              <div className="lb-card-header">
                <h3>📋 Bảng Xếp Hạng Chi Tiết ({data.members.length} người chơi)</h3>
                <span>Tổng cộng {data.total_ended} ván đã hoàn thành</span>
              </div>
              <div className="lb-table-scroll">
                <table className="lb-table">
                  <thead>
                    <tr>
                      <th style={{ width: "3.5rem" }}>Hạng</th>
                      <th>Thành viên</th>
                      <th style={{ textAlign: "center" }}>Cấp Bậc & Elo</th>
                      <th style={{ textAlign: "center" }}>Tổng ván</th>
                      <th style={{ textAlign: "center" }}>Thắng</th>
                      <th style={{ textAlign: "center" }}>Thua</th>
                      <th style={{ textAlign: "center" }}>Hoà</th>
                      <th style={{ textAlign: "right" }}>Tỉ lệ thắng</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.members.map((m, idx) => (
                      <tr key={m.user_id}>
                        <td className="lb-td-rank">
                          {idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : idx + 1}
                        </td>
                        <td className="lb-td-user">
                          <div className="lb-td-user-inner">
                            <Avatar
                              user={
                                {
                                  id: m.user_id,
                                  username: m.username,
                                  display_name: m.display_name,
                                  avatar: m.avatar,
                                } as PublicUser
                              }
                              size={24}
                            />
                            <span className="lb-td-name">{m.display_name || m.username}</span>
                            {m.username && <span className="lb-td-handle">@{m.username}</span>}
                          </div>
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <span className="lb-elo-badge" title={`Đỉnh cao: ${m.peak_rating || m.rating || 1200} Elo`}>
                            <span className="lb-tier-icon">{m.tier_badge || "🥈"}</span>
                            <b>{m.rating ?? 1200}</b>
                            <span className="lb-tier-name">{m.rank_tier || "Bạc"}</span>
                          </span>
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <b>{m.total_games}</b>
                        </td>
                        <td style={{ textAlign: "center", color: "var(--u1)", fontWeight: 700 }}>
                          {m.wins}
                        </td>
                        <td style={{ textAlign: "center", color: "var(--u4)", fontWeight: 700 }}>
                          {m.losses}
                        </td>
                        <td style={{ textAlign: "center", color: "var(--text-soft)" }}>{m.draws}</td>
                        <td style={{ textAlign: "right", fontWeight: 700 }}>{m.win_rate}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
