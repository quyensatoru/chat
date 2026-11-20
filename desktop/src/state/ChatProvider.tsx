import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CallController } from "../lib/calls";
import { GroupCallController } from "../lib/groupcall";
import { servedByServer } from "../lib/platform";

declare const __BUILD_ID__: string;
import {
  ApiError,
  type Api,
  type Embed,
  type GameKind,
  type GameView,
  type Message,
  type User,
  socketUrl,
} from "../lib/api";
import { myTurn } from "../lib/games";
import { stationStore } from "../lib/station";
import { embedSummary } from "../components/Embeds";
import { previewText } from "../components/MessageExtras";
import { ChatSocket } from "../lib/socket";
import { ServerUrlContext } from "../components/ui";
import { displayName, newClientId } from "../lib/format";
import { showNotification } from "../lib/notify";
import { playMentionSound, playMessageSound } from "../lib/sound";
import { channelLabel, dmPeerId, isDM } from "../lib/channel";
import { e2ee } from "../lib/e2ee";
import { load, save } from "../lib/storage";
import {
  type Action,
  type ChatState,
  type PendingMessage,
  channelMessages,
  findMessage,
  initialState,
  reducer,
} from "./chat";

const TYPING_TTL_MS = 6_000;
const TYPING_THROTTLE_MS = 3_000;

type ChatContextValue = {
  state: ChatState;
  dispatch: React.Dispatch<Action>;
  /** Gọi thoại / video (null khi chưa kết nối). */
  calls: CallController | null;
  /** Gọi nhóm trong kênh. */
  groupCalls: GroupCallController | null;
  api: Api;
  serverUrl: string;
  selectChannel: (id: number | null) => void;
  /** parentId: trả lời trong luồng của tin đó. */
  sendMessage: (channelId: number, content: string, files?: File[], parentId?: number, extra?: SendExtra) => void;
  /** Gửi sticker / GIF (một mình, không kèm chữ). */
  sendEmbed: (channelId: number, embed: Embed, parentId?: number, extra?: SendExtra) => void;
  /** Bắt đầu / huỷ trả lời trích dẫn trong ô soạn có khoá key ("c<kênh>" / "t<tin gốc>"). */
  setReply: (key: string, messageId: number | null) => void;
  /** Ghim / bỏ ghim. */
  pinMessage: (messageId: number, pinned: boolean) => Promise<void>;
  loadPins: (channelId: number) => Promise<void>;
  /** Mở kênh (và luồng nếu cần), tải thêm tin cũ tới khi thấy tin rồi làm nổi bật nó. */
  jumpToMessage: (m: { id: number; channel_id: number; parent_id?: number }) => Promise<void>;
  /** Chuyển tiếp tin (chữ, sticker/GIF, file) sang kênh / tin nhắn riêng khác. */
  forwardMessage: (message: Message, toChannelId: number) => Promise<void>;
  /**
   * Chia sẻ tin sang kênh / tin nhắn riêng khác: "copy" = bản sao (như chuyển tiếp),
   * "link" = thẻ liên kết tới tin gốc (game, bình chọn… hoặc bất kỳ tin nào trong kênh).
   */
  shareMessage: (message: Message, toChannelId: number, mode: "copy" | "link") => Promise<void>;
  /** Mở link …/m/<id>: vào thẳng tin nếu xem được, không thì hiện lời mời tham gia / báo không có quyền. */
  openMessageLink: (id: number) => Promise<void>;
  /** Thả/bỏ cảm xúc; cập nhật ngay trên máy mình rồi đồng bộ với server. */
  toggleReaction: (messageId: number, emoji: string) => void;
  /** Mở luồng của tin gốc (null để đóng). */
  openThread: (parentId: number | null) => void;
  /** Sửa nội dung tin của mình. Lỗi thì ném ApiError. */
  editMessage: (messageId: number, content: string) => Promise<void>;
  /** Xoá tin (của mình, hoặc bất kỳ tin nào nếu là chủ kênh). */
  deleteMessage: (messageId: number) => Promise<void>;
  /** Tạo bình chọn trong kênh. Lỗi thì ném ApiError. */
  createPoll: (
    channelId: number,
    p: {
      question: string;
      options: string[];
      multiple: boolean;
      anonymous: boolean;
      closes_at?: string;
      allow_add?: boolean;
    },
  ) => Promise<void>;
  /** Mở phòng chơi trong kênh (mình là chủ phòng). Lỗi thì ném ApiError. */
  createGame: (channelId: number, kind: GameKind, options?: Record<string, unknown>) => Promise<void>;
  /** Hành động trong ván (join, start, move...). Lỗi thì ném ApiError. */
  gameAction: (messageId: number, action: string, data?: unknown) => Promise<void>;
  /** Bỏ phiếu (thay toàn bộ lựa chọn của mình; [] = rút phiếu). */
  vote: (messageId: number, optionIds: number[]) => Promise<void>;
  closePoll: (messageId: number, closed: boolean) => Promise<void>;
  addPollOption: (messageId: number, text: string) => Promise<void>;
  /** Nhắc việc: đặt / hoãn / xong. at: thời điểm (Date). */
  remind: (messageId: number, at: Date, note: string) => Promise<void>;
  snoozeReminder: (id: number, at: Date) => Promise<void>;
  doneReminder: (id: number) => Promise<void>;
  /** Mở (tạo nếu chưa có) cuộc trò chuyện riêng với userId và chuyển tới đó. */
  openDM: (userId: number) => Promise<void>;
  retryMessage: (clientId: string) => void;
  discardMessage: (clientId: string) => void;
  notifyTyping: (channelId: number, parentId?: number) => void;
  spectateGame: (messageId: number) => void;
  unspectateGame: (messageId: number) => void;
  loadOlder: (channelId: number) => Promise<void>;
  loadMembers: (channelId: number) => Promise<void>;
  loadLiveGames: (channelId: number) => Promise<void>;
  reconnectNow: () => void;
  onLogout: () => void;
};

export type SendExtra = { replyToId?: number; forwarded?: boolean };

const sendOpts = (p: PendingMessage) => ({
  parentId: p.parentId,
  replyToId: p.replyToId,
  forwarded: p.forwarded,
});

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat phải nằm trong <ChatProvider>");
  return ctx;
}

type Props = {
  api: Api;
  serverUrl: string;
  token: string;
  me: User;
  onLogout: () => void;
  onUnauthorized: () => void;
  children: ReactNode;
};

export function ChatProvider({ api, serverUrl, token, me, onLogout, onUnauthorized, children }: Props) {
  const [state, dispatch] = useReducer(reducer, me, initialState);

  // Ref để các callback của socket luôn đọc state mới nhất mà không phải đăng ký lại.
  const stateRef = useRef(state);
  stateRef.current = state;

  const socketRef = useRef<ChatSocket | null>(null);
  const [calls, setCalls] = useState<CallController | null>(null);
  const [groupCalls, setGroupCalls] = useState<GroupCallController | null>(null);
  const lastTypingSent = useRef<Record<string | number, number>>({});

  const isViewing = useCallback((channelId: number) => {
    return stateRef.current.activeId === channelId && document.hasFocus() && !document.hidden;
  }, []);

  const markActiveRead = useCallback(() => {
    const s = stateRef.current;
    if (s.activeId === null) return;
    const items = channelMessages(s, s.activeId).items;
    const last = items[items.length - 1];
    if (last) socketRef.current?.markRead(s.activeId, last.id);
    dispatch({ type: "channel.read", channelId: s.activeId });
  }, []);

  const loadLatest = useCallback(
    async (channelId: number) => {
      try {
        const res = await api.messages(channelId);
        dispatch({ type: "messages.loaded", channelId, messages: res.messages, hasMore: res.has_more, older: false });
        if (res.reads) dispatch({ type: "reads.set", channelId, reads: res.reads });
        if (isViewing(channelId)) markActiveRead();
      } catch (err) {
        console.error("tải tin nhắn:", err);
      }
    },
    [api, isViewing, markActiveRead],
  );

  const refreshChannels = useCallback(async () => {
    try {
      const channels = await api.channels();
      dispatch({ type: "channels.loaded", channels });
      const s = stateRef.current;
      if (s.activeId === null && channels.length > 0) {
        const saved = load<number | null>("activeChannel", null);
        const pick = channels.find((c) => c.id === saved) ?? channels[0];
        dispatch({ type: "channel.select", channelId: pick.id, auto: true });
      }
    } catch (err) {
      console.error("tải danh sách kênh:", err);
    }
  }, [api]);

  // Bị nhắc tên ở kênh không đang xem (hoặc cửa sổ không được focus): hiện thông báo hệ thống.
  // Bị nhắc tên, hoặc có người trả lời tin của mình, ở nơi mình không đang xem:
  // hiện thông báo hệ thống (mỗi tin tối đa 1 thông báo).
  const notifyIfMentioned = useCallback((m: Message, viewing: boolean) => {
    const s = stateRef.current;
    if (m.user_id === s.me.id) return;
    const channel = s.channels[m.channel_id];
    const direct = isDM(channel);
    const mentioned = !!m.mentions?.includes(s.me.id);
    const repliedToMe = !!m.parent_id && m.parent_user_id === s.me.id;
    const seeingIt = viewing && (!m.parent_id || s.openThreadId === m.parent_id);
    if (seeingIt || (!direct && !mentioned && !repliedToMe)) return;
    const where = channel ? channelLabel(channel, s.users, s.me.id) : "kênh";
    const who = displayName(s.users[m.user_id] ?? m.user);
    let content = m.content;
    let embed = m.embed;
    if (m.cipher) {
      const dec = e2ee.decrypt(m);
      content = dec.ok ? (dec.payload.text ?? "") : "🔒 Tin nhắn được mã hoá đầu cuối";
      embed = dec.ok ? dec.payload.embed : undefined;
    }
    const body =
      content ||
      (m.poll
        ? `📊 Bình chọn: ${m.poll.question}`
        : m.game
          ? `🎮 Mở phòng ${m.game.title}, vào chơi không?`
          : embed
            ? embedSummary(embed)
            : m.attachments?.length
              ? `Đã gửi ${m.attachments.length} file`
              : "");
    const title = direct
      ? `${who} nhắn cho bạn`
      : mentioned
        ? `${who} nhắc bạn trong ${where}`
        : `${who} trả lời bạn trong ${where}`;
    void showNotification(title, body.slice(0, 200), () => {
      dispatch({ type: "channel.select", channelId: m.channel_id });
      if (m.parent_id) dispatch({ type: "thread.open", parentId: m.parent_id });
    });
  }, []);

  const playSoundForMessage = useCallback((m: Message) => {
    const s = stateRef.current;
    if (m.user_id === s.me.id) return;
    const channel = s.channels[m.channel_id];
    const direct = isDM(channel);
    const mentioned = !!m.mentions?.includes(s.me.id);
    const repliedToMe = !!m.parent_id && m.parent_user_id === s.me.id;

    if (direct || mentioned || repliedToMe) {
      playMentionSound();
    } else {
      playMessageSound();
    }
  }, []);

  const loadThread = useCallback(
    async (parentId: number) => {
      try {
        const res = await api.thread(parentId);
        dispatch({ type: "thread.loaded", parent: res.parent, replies: res.replies });
      } catch (err) {
        console.error("tải luồng:", err);
      }
    },
    [api],
  );

  // Gửi tin kèm file qua HTTP. Thành công thì tự thêm tin vào danh sách (phòng khi socket
  // đang rớt chưa kịp nhận "message.new"); reducer bỏ trùng theo id.
  const upload = useCallback(
    async (p: PendingMessage, content: string, files: (File | Blob)[], cipher?: string) => {
      const { clientId, channelId } = p;
      try {
        const msg = await api.sendWithFiles(
          channelId,
          { content, clientId, files, parentId: p.parentId, cipher, replyToId: p.replyToId, forwarded: p.forwarded },
          (progress) => dispatch({ type: "pending.progress", clientId, progress }),
        );
        dispatch({ type: "message.new", message: msg, clientId, countUnread: false });
      } catch (err) {
        dispatch({
          type: "pending.failed",
          clientId,
          error: err instanceof ApiError ? err.message : "Không tải được file lên.",
        });
      }
    },
    [api],
  );

  /**
   * Gửi một tin đang chờ. Trong tin nhắn riêng: nếu cả hai đã có khoá thì mã hoá đầu cuối
   * (chữ, sticker/GIF, file), không thì gửi thường (giao diện đã báo "chưa được mã hoá").
   */
  const deliver = useCallback(
    async (p: PendingMessage) => {
      const fail = (error: string) => dispatch({ type: "pending.failed", clientId: p.clientId, error });
      const s = stateRef.current;
      const ch = s.channels[p.channelId];
      let theirPub: string | null = null;
      if (isDM(ch)) {
        const status = await e2ee.settled();
        if (status === "locked") return fail("Hãy nhập mã PIN để gửi tin được mã hoá.");
        if (status === "ready") {
          try {
            theirPub = await e2ee.peerKey(dmPeerId(ch!, s.me.id)!);
          } catch {
            return fail("Không lấy được khoá mã hoá của người nhận, thử gửi lại.");
          }
        }
      }
      if (theirPub) {
        try {
          if (p.files?.length) {
            const enc = await Promise.all(p.files.map((f) => e2ee.encryptFile(f)));
            const cipher = e2ee.encrypt(
              { ...(p.content ? { text: p.content } : {}), files: enc.map((e) => e.meta) },
              p.channelId,
              theirPub,
            );
            await upload(
              p,
              "",
              enc.map((e) => e.blob),
              cipher,
            );
          } else {
            const cipher = e2ee.encrypt(p.embed ? { embed: p.embed } : { text: p.content }, p.channelId, theirPub);
            socketRef.current?.sendMessage(p.channelId, "", p.clientId, { ...sendOpts(p), cipher });
          }
        } catch (err) {
          console.error("mã hoá:", err);
          fail("Không mã hoá được tin nhắn.");
        }
        return;
      }
      if (p.files?.length) await upload(p, p.content, p.files);
      else socketRef.current?.sendMessage(p.channelId, p.content, p.clientId, { ...sendOpts(p), embed: p.embed });
    },
    [upload],
  );

  // Khoá mã hoá đầu cuối của tài khoản này.
  useEffect(() => {
    void e2ee.start(api, me.id, serverUrl);
    return () => e2ee.stop();
  }, [api, me.id, serverUrl]);

  const loadOlder = useCallback(
    async (channelId: number) => {
      const cm = channelMessages(stateRef.current, channelId);
      if (cm.loadingOlder || !cm.hasMore || cm.items.length === 0) return;
      dispatch({ type: "messages.loadingOlder", channelId, loading: true });
      try {
        const res = await api.messages(channelId, cm.items[0].id);
        dispatch({ type: "messages.loaded", channelId, messages: res.messages, hasMore: res.has_more, older: true });
      } catch (err) {
        console.error("tải tin cũ:", err);
        dispatch({ type: "messages.loadingOlder", channelId, loading: false });
      }
    },
    [api],
  );

  const loadLiveGames = useCallback(
    async (channelId: number) => {
      try {
        const games = await api.liveGames(channelId);
        dispatch({ type: "liveGames.loaded", channelId, games });
      } catch (err) {
        console.error("loadLiveGames:", err);
      }
    },
    [api],
  );

  // để các hành động gọi lẫn nhau (chuyển tiếp -> gửi tin) mà không phụ thuộc vòng
  const actionsRef = useRef<Omit<ChatContextValue, "state" | "calls" | "groupCalls"> | null>(null);

  /* ---------- Kết nối socket ---------- */

  useEffect(() => {
    const sock = new ChatSocket(socketUrl(serverUrl, token));
    stationStore.setSender((req) => sock.sendGame(req));
    socketRef.current = sock;
    let everReady = false;
    const calls = new CallController(
      api,
      (req) => sock.sendCall(req),
      (title, body) => {
        if (!document.hasFocus()) void showNotification(title, body, () => window.focus());
      },
    );
    setCalls(calls);
    const groups = new GroupCallController(
      api,
      (req) => sock.sendGroup(req),
      (title, body, channelId) =>
        void showNotification(title, body, () => {
          window.focus();
          dispatch({ type: "channel.select", channelId });
        }),
      () => {
        const p = calls.getSnapshot().phase;
        return p !== "idle" && p !== "ended";
      },
    );
    setGroupCalls(groups);

    const offs = [
      sock.onStatus((status) => {
        dispatch({ type: "status", status });
        if (status !== "open") {
          calls.onDisconnected();
          groups.onDisconnected();
        }
        if (status === "unauthorized") onUnauthorized();
      }),

      sock.on("ready", (ev) => {
        dispatch({ type: "ready", me: ev.user, online: ev.online_user_ids, ai: ev.ai ?? null });
        stationStore.resubscribe();
        groups.setRooms(ev.group_calls ?? []);
        // bản web đang chạy cũ hơn bản máy chủ phục vụ: nhắc tải lại (app desktop có bản riêng)
        if (servedByServer && ev.ui_build && ev.ui_build !== __BUILD_ID__) dispatch({ type: "update.available" });
        api
          .reminders()
          .then((reminders) => dispatch({ type: "reminders.loaded", reminders }))
          .catch(() => {});
        if (everReady) {
          // Kết nối lại: có thể đã lỡ tin trong lúc mất mạng.
          dispatch({ type: "messages.stale" });
          void refreshChannels();
          const active = stateRef.current.activeId;
          if (active !== null) void loadLatest(active);
          const thread = stateRef.current.openThreadId;
          if (thread !== null) void loadThread(thread);
        }
        everReady = true;
      }),

      sock.on("message.new", (ev) => {
        const viewing = isViewing(ev.message.channel_id);
        dispatch({ type: "message.new", message: ev.message, clientId: ev.client_id, countUnread: !viewing });
        if (ev.message.embed?.type === "game") {
          void loadLiveGames(ev.message.channel_id);
        }
        if (viewing && ev.message.user_id !== stateRef.current.me.id) {
          sock.markRead(ev.message.channel_id, ev.message.id);
        }
        notifyIfMentioned(ev.message, viewing);
        playSoundForMessage(ev.message);
      }),

      sock.on("message.updated", (ev) => {
        dispatch({ type: "message.updated", message: ev.message });
        if (ev.message.deleted_at) {
          dispatch({ type: "liveGames.remove", channelId: ev.message.channel_id, messageId: ev.message.id });
        }
      }),
      sock.on("key.updated", (ev) => e2ee.onKeyUpdated(ev.user_id, ev.public_key)),
      sock.on("poll.updated", (ev) => dispatch({ type: "poll.set", messageId: ev.message_id, poll: ev.poll })),
      sock.on("game.spectators", (ev) => {
        dispatch({
          type: "game.spectators",
          channelId: ev.channel_id,
          messageId: ev.message_id,
          count: ev.count,
          spectators: ev.spectators,
        });
      }),
      sock.on("game.map", (ev) => stationStore.onMap(ev.message_id, ev.map)),
      sock.on("game.frame", (ev) => stationStore.onFrame(ev.message_id, ev.frame)),
      sock.on("game.updated", (ev) => {
        const s = stateRef.current;
        const prev = findMessage(s, ev.message_id)?.game;
        dispatch({ type: "game.set", messageId: ev.message_id, game: ev.game });

        if (ev.game.status === "ended") {
          dispatch({ type: "liveGames.remove", channelId: ev.channel_id, messageId: ev.message_id });
        } else {
          const existing = s.liveGames[ev.channel_id]?.find((g) => g.message_id === ev.message_id);
          if (existing) {
            const isMyTurn = myTurn(ev.game, s.me.id) !== null;
            dispatch({
              type: "liveGames.upsert",
              channelId: ev.channel_id,
              game: {
                ...existing,
                status: ev.game.status === "playing" ? "playing" : "lobby",
                players: ev.game.players,
                is_my_turn: isMyTurn,
                game: ev.game,
              },
            });
          } else {
            void loadLiveGames(ev.channel_id);
          }
        }

        // Trạm Vũ Trụ vừa bắt đầu mà mình có chơi: mở luôn màn hình chơi
        if (
          ev.game.kind === "station" &&
          ev.game.status === "playing" &&
          prev?.status === "lobby" &&
          ev.game.players.some((p) => p.id === s.me.id)
        ) {
          stationStore.open(ev.message_id);
        }
        // báo khi vừa tới lượt mình mà mình đang không nhìn vào kênh đó
        if (ev.game.me === undefined) return;
        const turn = myTurn(ev.game, s.me.id);
        if (turn && turn !== myTurn(prev, s.me.id) && (!document.hasFocus() || !isViewing(ev.channel_id))) {
          void showNotification(`🎮 ${ev.game.title}`, turn, () => {
            window.focus();
            void actionsRef.current?.jumpToMessage({ id: ev.message_id, channel_id: ev.channel_id });
          });
        }
      }),
      sock.on("groupcall.state", (ev) => void groups.onEvent(ev)),
      sock.on("groupcall.started", (ev) => void groups.onEvent(ev)),
      sock.on("groupcall.welcome", (ev) => void groups.onEvent(ev)),
      sock.on("groupcall.signal", (ev) => void groups.onEvent(ev)),
      sock.on("groupcall.error", (ev) => void groups.onEvent(ev)),
      sock.on("call.incoming", (ev) => void calls.onEvent(ev)),
      sock.on("call.accepted", (ev) => void calls.onEvent(ev)),
      sock.on("call.signal", (ev) => void calls.onEvent(ev)),
      sock.on("call.ended", (ev) => void calls.onEvent(ev)),
      sock.on("reminder.due", (ev) => {
        const r = ev.reminder;
        dispatch({ type: "reminder.upsert", reminder: r });
        const m = r.message;
        const s = stateRef.current;
        let body = r.note || "";
        if (m) {
          const ch = s.channels[m.channel_id];
          const text = previewText({ ...m, deleted: !!m.deleted_at, poll: m.poll }, m.channel_id);
          body = [
            r.note,
            `${displayName(s.users[m.user_id] ?? m.user)}${ch ? " · " + channelLabel(ch, s.users, s.me.id) : ""}: ${text || "(tin nhắn)"}`,
          ]
            .filter(Boolean)
            .join("\n");
        }
        void showNotification("⏰ Nhắc việc", body.slice(0, 240), () => {
          if (m) void actionsRef.current?.jumpToMessage(m);
        });
      }),

      sock.onSendFailed((clientId, reason) => dispatch({ type: "pending.failed", clientId, error: reason })),

      sock.on("typing", (ev) =>
        dispatch({ type: "typing", channelId: ev.channel_id, userId: ev.user_id, until: Date.now() + TYPING_TTL_MS }),
      ),
      sock.on("presence", (ev) => dispatch({ type: "presence", userId: ev.user_id, online: ev.online })),
      sock.on("user.updated", (ev) => {
        dispatch({ type: "user.updated", user: ev.user });
      }),

      sock.on("channel.joined", (ev) => dispatch({ type: "channel.upsert", channel: ev.channel })),
      sock.on("channel.updated", (ev) => dispatch({ type: "channel.upsert", channel: ev.channel, keepUnread: true })),
      sock.on("channel.left", (ev) => dispatch({ type: "channel.removed", channelId: ev.channel_id })),
      sock.on("channel.deleted", (ev) => dispatch({ type: "channel.removed", channelId: ev.channel_id })),
      sock.on("member.joined", (ev) => dispatch({ type: "member.joined", channelId: ev.channel_id, user: ev.user })),
      sock.on("member.left", (ev) => dispatch({ type: "member.left", channelId: ev.channel_id, userId: ev.user_id })),
      sock.on("reaction.updated", (ev) =>
        dispatch({ type: "reactions.set", messageId: ev.message_id, reactions: ev.reactions }),
      ),
      sock.on("thread.updated", (ev) =>
        dispatch({ type: "thread.updated", messageId: ev.message_id, thread: ev.thread }),
      ),
      sock.on("read.updated", (ev) =>
        dispatch({ type: "read.updated", channelId: ev.channel_id, userId: ev.user_id, messageId: ev.message_id }),
      ),
    ];

    sock.connect();
    void refreshChannels();

    return () => {
      offs.forEach((off) => off());
      calls.hangup();
      groups.leave();
      setCalls(null);
      setGroupCalls(null);
      stationStore.close();
      stationStore.setSender(null);
      sock.close();
      socketRef.current = null;
    };
  }, [serverUrl, token, onUnauthorized, refreshChannels, loadLatest, isViewing, notifyIfMentioned, playSoundForMessage, loadThread]);

  // Số tin chưa đọc trên tiêu đề tab (bản web), ví dụ "(3) Go Chat".
  useEffect(() => {
    const total = Object.values(state.channels).reduce((n, c) => n + c.unread_count, 0);
    document.title = total > 0 ? `(${total}) Go Chat` : "Go Chat";
  }, [state.channels]);

  /* ---------- Kênh đang mở ---------- */

  useEffect(() => {
    if (state.activeId === null) return;
    save("activeChannel", state.activeId);
    if (!channelMessages(stateRef.current, state.activeId).loaded) void loadLatest(state.activeId);
    else markActiveRead();
  }, [state.activeId, loadLatest, markActiveRead]);

  // Quay lại cửa sổ: đánh dấu đã đọc kênh đang mở.
  useEffect(() => {
    const onFocus = () => markActiveRead();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [markActiveRead]);

  // Dọn trạng thái "đang gõ" đã hết hạn.
  useEffect(() => {
    const t = window.setInterval(() => dispatch({ type: "typing.expire", now: Date.now() }), 1_000);
    return () => window.clearInterval(t);
  }, []);

  /* ---------- Hành động cho UI ---------- */

  // Các hành động KHÔNG phụ thuộc state (đọc state qua stateRef), nên giữ nguyên identity giữa
  // các lần render. Nếu không, effect nào dùng chúng làm dependency sẽ chạy lại sau mỗi tin nhắn.
  const actions = useMemo<Omit<ChatContextValue, "state" | "calls" | "groupCalls">>(
    () => ({
      dispatch,
      api,
      serverUrl,
      onLogout: () => {
        e2ee.forget(); // khoá bí mật không ở lại máy sau khi đăng xuất
        onLogout();
      },
      selectChannel: (id) => dispatch({ type: "channel.select", channelId: id }),

      sendMessage: (channelId, content, files, parentId, extra) => {
        const hasFiles = !!files && files.length > 0;
        const p: PendingMessage = {
          ...extra,
          clientId: newClientId(),
          channelId,
          content,
          createdAt: new Date().toISOString(),
          status: "sending",
          ...(hasFiles ? { files, progress: 0 } : {}),
          ...(parentId ? { parentId } : {}),
        };
        dispatch({ type: "pending.add", pending: p });
        void deliver(p);
        lastTypingSent.current[channelId] = 0;
      },

      sendEmbed: (channelId, embed, parentId, extra) => {
        const p: PendingMessage = {
          ...extra,
          clientId: newClientId(),
          channelId,
          content: "",
          createdAt: new Date().toISOString(),
          status: "sending",
          embed,
          ...(parentId ? { parentId } : {}),
        };
        dispatch({ type: "pending.add", pending: p });
        void deliver(p);
      },

      retryMessage: (clientId) => {
        const p = stateRef.current.pending.find((x) => x.clientId === clientId);
        if (!p) return;
        dispatch({ type: "pending.retry", clientId });
        void deliver(p);
      },

      toggleReaction: (messageId, emoji) => {
        dispatch({ type: "reaction.toggleLocal", messageId, emoji });
        api
          .toggleReaction(messageId, emoji)
          .then((res) => dispatch({ type: "reactions.set", messageId, reactions: res.reactions }))
          .catch((err) => {
            console.error("thả cảm xúc:", err);
            dispatch({ type: "reaction.toggleLocal", messageId, emoji }); // hoàn tác
          });
      },

      editMessage: async (messageId, content) => {
        const s = stateRef.current;
        const old = findMessage(s, messageId);
        let msg: Message;
        if (old?.cipher) {
          // tin mã hoá: mã hoá lại nội dung mới (giữ nguyên file/sticker đi kèm)
          const dec = e2ee.decrypt(old);
          const ch = s.channels[old.channel_id];
          if (!dec.ok || !ch) throw new ApiError(0, "Không giải mã được tin này để sửa.");
          const theirPub = await e2ee.peerKey(dmPeerId(ch, s.me.id)!);
          if (!theirPub) throw new ApiError(0, "Người nhận không còn khoá mã hoá.");
          const cipher = e2ee.encrypt({ ...dec.payload, text: content }, old.channel_id, theirPub);
          msg = await api.editMessage(messageId, { cipher });
        } else {
          msg = await api.editMessage(messageId, { content });
        }
        dispatch({ type: "message.updated", message: msg });
      },

      deleteMessage: async (messageId) => {
        const msg = await api.deleteMessage(messageId);
        dispatch({ type: "message.updated", message: msg });
      },

      createPoll: async (channelId, p) => {
        const clientId = newClientId();
        const msg = await api.createPoll(channelId, { ...p, client_id: clientId });
        dispatch({ type: "message.new", message: msg, clientId, countUnread: false });
      },

      createGame: async (channelId, kind, options) => {
        const clientId = newClientId();
        const msg = await api.createGame(channelId, { kind, options, client_id: clientId });
        dispatch({ type: "message.new", message: msg, clientId, countUnread: false });
      },

      gameAction: async (messageId, action, data) => {
        const game: GameView = await api.gameAction(messageId, action, data);
        dispatch({ type: "game.set", messageId, game });
      },

      vote: async (messageId, optionIds) => {
        const poll = await api.vote(messageId, optionIds);
        dispatch({ type: "poll.set", messageId, poll, mine: true });
      },

      addPollOption: async (messageId, text) => {
        const poll = await api.addPollOption(messageId, text);
        dispatch({ type: "poll.set", messageId, poll, mine: true });
      },

      remind: async (messageId, at, note) => {
        const reminder = await api.remind(messageId, at.toISOString(), note);
        dispatch({ type: "reminder.upsert", reminder });
      },

      snoozeReminder: async (id, at) => {
        const reminder = await api.snoozeReminder(id, at.toISOString());
        dispatch({ type: "reminder.upsert", reminder });
      },

      doneReminder: async (id) => {
        await api.deleteReminder(id);
        dispatch({ type: "reminder.remove", id });
      },

      closePoll: async (messageId, closed) => {
        const poll = await api.closePoll(messageId, closed);
        dispatch({ type: "poll.set", messageId, poll, mine: true });
      },

      openDM: async (userId) => {
        const ch = await api.openDM(userId);
        dispatch({ type: "channel.upsert", channel: ch, keepUnread: true });
        dispatch({ type: "channel.select", channelId: ch.id });
      },

      openThread: (parentId) => {
        dispatch({ type: "thread.open", parentId });
        if (parentId !== null) void loadThread(parentId);
      },

      discardMessage: (clientId) => {
        socketRef.current?.cancelMessage(clientId);
        dispatch({ type: "pending.remove", clientId });
      },

      notifyTyping: (channelId, parentId) => {
        const key = parentId ? `${channelId}_${parentId}` : `${channelId}`;
        const now = Date.now();
        if (now - (lastTypingSent.current[key] ?? 0) < TYPING_THROTTLE_MS) return;
        lastTypingSent.current[key] = now;
        socketRef.current?.sendTyping(channelId, parentId);
      },

      spectateGame: (messageId) => {
        socketRef.current?.spectateGame(messageId);
      },

      unspectateGame: (messageId) => {
        socketRef.current?.unspectateGame(messageId);
      },

      loadOlder,

      setReply: (key, messageId) => dispatch({ type: "reply.set", key, messageId }),

      pinMessage: async (messageId, pinned) => {
        const msg = await api.pin(messageId, pinned);
        dispatch({ type: "message.updated", message: msg });
      },

      loadPins: async (channelId) => {
        const messages = await api.pins(channelId);
        dispatch({ type: "pins.loaded", channelId, messages });
      },

      jumpToMessage: async (m) => {
        dispatch({ type: "channel.select", channelId: m.channel_id });
        if (m.parent_id) {
          dispatch({ type: "thread.open", parentId: m.parent_id });
          await loadThread(m.parent_id);
          dispatch({ type: "highlight", messageId: m.id });
          return;
        }
        const tick = () => new Promise((r) => setTimeout(r, 30)); // chờ React cập nhật stateRef
        if (!channelMessages(stateRef.current, m.channel_id).loaded) {
          await loadLatest(m.channel_id);
          await tick();
        }
        // tin cũ: tải thêm từng trang (tối đa ~1500 tin) tới khi thấy
        for (let i = 0; i < 30; i++) {
          const cm = channelMessages(stateRef.current, m.channel_id);
          if (cm.items.some((x) => x.id === m.id) || !cm.hasMore) break;
          await loadOlder(m.channel_id);
          await tick();
        }
        dispatch({ type: "highlight", messageId: m.id });
      },

      forwardMessage: async (message, toChannelId) => {
        let text = message.content;
        let embed = message.embed;
        let files: File[] = [];
        if (message.cipher) {
          const dec = e2ee.decrypt(message);
          if (!dec.ok) throw new ApiError(0, "Không giải mã được tin này để chuyển tiếp.");
          text = dec.payload.text ?? "";
          embed = dec.payload.embed;
          const metas = dec.payload.files ?? [];
          files = await Promise.all(
            metas.map(async (meta, i) => {
              const att = message.attachments?.[i];
              if (!att) throw new ApiError(0, "Thiếu file đính kèm.");
              const buf = await (await fetch(api.fileUrl(att, true))).arrayBuffer();
              return new File([await e2ee.decryptFile(buf, meta)], meta.name, { type: meta.type });
            }),
          );
        } else if (message.attachments?.length) {
          files = await Promise.all(
            message.attachments.map(async (att) => {
              const res = await fetch(api.fileUrl(att, true));
              if (!res.ok) throw new ApiError(res.status, `Không tải được ${att.file_name}.`);
              return new File([await res.blob()], att.file_name, { type: att.content_type });
            }),
          );
        }
        if (embed) actionsRef.current!.sendEmbed(toChannelId, embed, undefined, { forwarded: true });
        else
          actionsRef.current!.sendMessage(toChannelId, text, files.length ? files : undefined, undefined, {
            forwarded: true,
          });
      },

      shareMessage: async (message, toChannelId, mode) => {
        if (mode === "copy") return actionsRef.current!.forwardMessage(message, toChannelId);
        const s = stateRef.current;
        actionsRef.current!.sendEmbed(toChannelId, shareSnapshot(message, s));
      },

      openMessageLink: async (id) => {
        try {
          const info = await api.messageLink(id);
          if (info.member && info.message) {
            const m = info.message;
            if (!stateRef.current.channels[m.channel_id]) await refreshChannels();
            await actionsRef.current!.jumpToMessage({ id: m.id, channel_id: m.channel_id, parent_id: m.parent_id });
            return;
          }
          dispatch({ type: "link.prompt", prompt: { id, info } });
        } catch (err) {
          dispatch({
            type: "link.prompt",
            prompt: { id, error: err instanceof ApiError ? err.message : "Không mở được tin nhắn này." },
          });
        }
      },

      loadMembers: async (channelId) => {
        const members = await api.members(channelId);
        dispatch({ type: "members.loaded", channelId, members });
      },

      loadLiveGames,

      reconnectNow: () => socketRef.current?.reconnectNow(),
    }),
    [api, serverUrl, onLogout, deliver, loadThread, loadOlder, loadLiveGames, loadLatest, refreshChannels],
  );

  actionsRef.current = actions;
  const value = useMemo<ChatContextValue>(
    () => ({ state, ...actions, calls, groupCalls }),
    [state, calls, groupCalls, actions],
  );

  return (
    <ChatContext.Provider value={value}>
      <ServerUrlContext.Provider value={serverUrl}>{children}</ServerUrlContext.Provider>
    </ChatContext.Provider>
  );
}

/**
 * Bản tóm tắt tin gốc cho thẻ chia sẻ. Kênh thường: máy chủ dựng lại từ DB (không tin bản này);
 * tin nhắn riêng được mã hoá nên máy chủ không đọc được, bản này đi nguyên trong tin.
 */
function shareSnapshot(m: Message, s: ChatState): Embed {
  const fromAI = m.user?.username === "ai";
  let text = (m.content || "").trim();
  if (fromAI) text = text.replace(/\n*_— [^\n]*_\s*$/, "").trim();
  const e: Embed = {
    type: "share",
    id: String(m.embed?.type === "share" ? m.embed.id : m.id),
    kind: "message",
    author: fromAI ? "Trợ lý AI" : displayName(s.users[m.user_id] ?? m.user),
    channel: s.channels[m.channel_id]?.name,
    channel_id: m.channel_id,
  };
  if (m.embed?.type === "share") return { ...m.embed };
  if (m.poll) (Object.assign(e, { kind: "poll", title: "Bình chọn" }), (text = m.poll.question));
  else if (m.embed?.type === "game")
    (Object.assign(e, { kind: "game", title: m.embed.title }), (text = `Phòng chơi ${m.embed.title ?? ""}`));
  else if (m.embed?.type === "call")
    (Object.assign(e, { kind: "call", title: "Cuộc gọi" }), (text = "Nhật ký cuộc gọi"));
  else if (m.embed?.type === "sticker") Object.assign(e, { kind: "sticker", title: "Sticker" });
  else if (m.embed?.type === "gif") Object.assign(e, { kind: "gif", title: "GIF" });
  const img = m.attachments?.find((a) => /^image\/(png|jpeg|webp)$/.test(a.content_type));
  if (img) {
    e.preview = img.url;
    if (e.kind === "message" && !text) e.kind = "image";
  }
  if (!text && m.attachments?.length) {
    text = m.attachments.map((a) => a.file_name).join(", ");
    if (e.kind === "message") e.kind = "file";
  }
  e.text = text.length > 300 ? text.slice(0, 300) + "…" : text;
  return e;
}
