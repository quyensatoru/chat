import type {
  Channel,
  Embed,
  GameView,
  LiveGameItem,
  Message,
  Poll,
  Reminder,
  PublicUser,
  ReadState,
  Reaction,
  SpectatorInfo,
  ThreadSummary,
  User,
} from "../lib/api";
import type { AIInfo } from "../lib/socket";
import type { MessageLinkInfo } from "../lib/api";

export type LinkPrompt = { id: number; info?: MessageLinkInfo; error?: string };
import type { SocketStatus } from "../lib/socket";

/* ---------- State ---------- */

export type PendingMessage = {
  clientId: string;
  channelId: number;
  content: string;
  createdAt: string;
  status: "sending" | "failed";
  error?: string;
  /** File gửi kèm (giữ lại để gửi lại khi lỗi). */
  files?: File[];
  /** Tiến trình tải file lên, 0–1. */
  progress?: number;
  /** Có nếu đang trả lời trong luồng của tin này. */
  parentId?: number;
  /** Sticker / GIF đang gửi. */
  embed?: Embed;
  /** Trả lời trích dẫn tin này. */
  replyToId?: number;
  forwarded?: boolean;
};

/** Một luồng trả lời đã mở: tin gốc + các trả lời (cũ -> mới). */
export type ThreadState = {
  parent: Message;
  replies: Message[];
};

export type ChannelMessages = {
  items: Message[]; // đã sắp xếp theo id tăng dần, không trùng
  hasMore: boolean;
  loaded: boolean;
  loadingOlder: boolean;
};

export type ChatState = {
  me: User;
  status: SocketStatus;
  channels: Record<number, Channel>;
  activeId: number | null;
  /** true nếu kênh đang mở là do app tự chọn lúc khởi động (không phải người dùng bấm). */
  activeAuto: boolean;
  messages: Record<number, ChannelMessages>;
  pending: PendingMessage[];
  users: Record<number, PublicUser>;
  online: Record<number, true>;
  /** channelId -> userId -> thời điểm hết hiệu lực (ms) */
  typing: Record<number, Record<number, number>>;
  /** channelId -> danh sách userId (chỉ có khi đã mở panel thành viên) */
  members: Record<number, number[]>;
  /** parentId -> luồng đã tải */
  threads: Record<number, ThreadState>;
  /** Luồng đang mở trong panel bên phải (id tin gốc). */
  openThreadId: number | null;
  /** Tin đang được sửa tại chỗ (mỗi lúc chỉ một tin). */
  editingId: number | null;
  /** Đang trả lời trích dẫn: khoá ô soạn ("c<kênh>" / "t<tin gốc>") -> id tin được trả lời. */
  replyTo: Record<string, number>;
  /** Tin đang được làm nổi bật sau khi nhảy tới (từ tìm kiếm, tin ghim, bản trích). */
  highlight: { id: number; at: number } | null;
  /** Tin đang ghim của từng kênh (đã tải). */
  pins: Record<number, Message[]>;
  /** Nhắc việc của mình (null: chưa tải). */
  reminders: Reminder[] | null;
  /** Máy chủ đang phục vụ bản giao diện mới hơn bản đang chạy. */
  updateAvailable: boolean;
  /** Trợ lý AI của máy chủ (null: tắt). */
  ai: AIInfo | null;
  /** Mở link tới một tin mà mình chưa xem được (chưa vào kênh / không có quyền / tin đã xoá). */
  linkPrompt: LinkPrompt | null;
  /** channelId -> userId -> id tin đã xem tới (để hiện "đã xem"). */
  reads: Record<number, Record<number, number>>;
  /** channelId -> danh sách các ván game đang hoạt động */
  liveGames: Record<number, LiveGameItem[]>;
  /** messageId -> danh sách khán giả đang xem ván đấu */
  spectators: Record<number, SpectatorInfo[]>;
};

export function initialState(me: User): ChatState {
  return {
    me,
    status: "idle",
    channels: {},
    activeId: null,
    activeAuto: false,
    messages: {},
    pending: [],
    users: { [me.id]: me },
    online: {},
    typing: {},
    members: {},
    threads: {},
    openThreadId: null,
    editingId: null,
    replyTo: {},
    highlight: null,
    pins: {},
    reminders: null,
    updateAvailable: false,
    ai: null,
    linkPrompt: null,
    reads: {},
    liveGames: {},
    spectators: {},
  };
}

/* ---------- Actions ---------- */

export type Action =
  | { type: "status"; status: SocketStatus }
  | { type: "ready"; me: User; online: number[]; ai: AIInfo | null }
  | { type: "me.updated"; me: User }
  | { type: "channels.loaded"; channels: Channel[] }
  | { type: "channel.upsert"; channel: Channel; keepUnread?: boolean }
  | { type: "channel.removed"; channelId: number }
  | { type: "channel.select"; channelId: number | null; auto?: boolean }
  | { type: "channel.read"; channelId: number }
  | { type: "messages.loaded"; channelId: number; messages: Message[]; hasMore: boolean; older: boolean }
  | { type: "messages.loadingOlder"; channelId: number; loading: boolean }
  | { type: "messages.stale" }
  | { type: "message.new"; message: Message; clientId?: string; countUnread: boolean }
  | { type: "message.updated"; message: Message }
  | { type: "edit.start"; messageId: number | null }
  | { type: "reply.set"; key: string; messageId: number | null }
  | { type: "highlight"; messageId: number | null }
  | { type: "pins.loaded"; channelId: number; messages: Message[] }
  | { type: "reminders.loaded"; reminders: Reminder[] }
  | { type: "update.available" }
  | { type: "reminder.upsert"; reminder: Reminder }
  | { type: "reminder.remove"; id: number }
  | { type: "pending.add"; pending: PendingMessage }
  | { type: "pending.failed"; clientId: string; error: string }
  | { type: "pending.retry"; clientId: string }
  | { type: "pending.progress"; clientId: string; progress: number }
  | { type: "pending.remove"; clientId: string }
  | { type: "typing"; channelId: number; userId: number; until: number }
  | { type: "typing.expire"; now: number }
  | { type: "presence"; userId: number; online: boolean }
  | { type: "user.updated"; user: PublicUser }
  | { type: "members.loaded"; channelId: number; members: PublicUser[] }
  | { type: "member.joined"; channelId: number; user: PublicUser }
  | { type: "member.left"; channelId: number; userId: number }
  | { type: "thread.open"; parentId: number | null }
  | { type: "thread.loaded"; parent: Message; replies: Message[] }
  | { type: "thread.updated"; messageId: number; thread: ThreadSummary }
  | { type: "reactions.set"; messageId: number; reactions: Reaction[] }
  /** mine: phản hồi riêng cho mình (my_votes đầy đủ); không có: sự kiện chung, giữ my_votes cũ. */
  | { type: "poll.set"; messageId: number; poll: Poll; mine?: boolean }
  | { type: "game.set"; messageId: number; game: GameView }
  | { type: "liveGames.loaded"; channelId: number; games: LiveGameItem[] }
  | { type: "liveGames.upsert"; channelId: number; game: LiveGameItem }
  | { type: "liveGames.remove"; channelId: number; messageId: number }
  | { type: "game.spectators"; channelId: number; messageId: number; count: number; spectators: SpectatorInfo[] }
  | { type: "link.prompt"; prompt: LinkPrompt | null }
  | { type: "reaction.toggleLocal"; messageId: number; emoji: string }
  | { type: "reads.set"; channelId: number; reads: ReadState[] }
  | { type: "read.updated"; channelId: number; userId: number; messageId: number };

/* ---------- Helpers ---------- */

/** Vị trí đã xem chỉ tiến lên. */
function advanceRead(s: ChatState, channelId: number, userId: number, messageId: number): ChatState["reads"] {
  const cur = s.reads[channelId];
  if ((cur?.[userId] ?? 0) >= messageId) return s.reads;
  return { ...s.reads, [channelId]: { ...cur, [userId]: messageId } };
}

/**
 * Ván chơi mới nhất. Sự kiện phát chung cho cả kênh không có "me" (phần bí mật của mình),
 * bản riêng tới ngay sau: giữ "me" cũ trong lúc chờ. Bản cũ hơn (version nhỏ hơn) thì bỏ.
 */
export function mergeGame(old: GameView | undefined, next: GameView | undefined): GameView | undefined {
  if (!next) return old;
  if (!old) return next;
  if (next.version < old.version) return old;
  if (next.me === undefined && old.me !== undefined) return { ...next, me: old.me };
  return next;
}

function mergeMessages(a: Message[], b: Message[]): Message[] {
  const byId = new Map<number, Message>();
  for (const m of a) byId.set(m.id, m);
  for (const m of b) {
    const prev = byId.get(m.id);
    byId.set(m.id, prev?.game && !m.deleted_at ? { ...m, game: mergeGame(prev.game, m.game) } : m);
  }
  return [...byId.values()].sort((x, y) => x.id - y.id);
}

function withUsers(users: Record<number, PublicUser>, list: (PublicUser | undefined)[]) {
  let next = users;
  for (const u of list) {
    if (!u) continue;
    if (next === users) next = { ...users };
    next[u.id] = { ...next[u.id], ...u };
  }
  return next;
}

/** Áp fn lên tin có id = messageId ở mọi nơi nó xuất hiện (dòng chính, tin gốc và trả lời trong luồng). */
function updateMessage(s: ChatState, messageId: number, fn: (m: Message) => Message): ChatState {
  let messages = s.messages;
  for (const [cid, cm] of Object.entries(s.messages)) {
    const i = cm.items.findIndex((m) => m.id === messageId);
    if (i < 0) continue;
    const items = cm.items.slice();
    items[i] = fn(items[i]);
    messages = { ...messages, [Number(cid)]: { ...cm, items } };
  }
  let threads = s.threads;
  for (const [pid, t] of Object.entries(s.threads)) {
    if (t.parent.id === messageId) {
      threads = { ...threads, [Number(pid)]: { ...t, parent: fn(t.parent) } };
      continue;
    }
    const i = t.replies.findIndex((m) => m.id === messageId);
    if (i < 0) continue;
    const replies = t.replies.slice();
    replies[i] = fn(replies[i]);
    threads = { ...threads, [Number(pid)]: { ...t, replies } };
  }
  return messages === s.messages && threads === s.threads ? s : { ...s, messages, threads };
}

/** Tìm tin ở dòng chính hoặc trong luồng đã tải. */
export function findMessage(s: ChatState, messageId: number): Message | undefined {
  for (const cm of Object.values(s.messages)) {
    const m = cm.items.find((x) => x.id === messageId);
    if (m) return m;
  }
  for (const t of Object.values(s.threads)) {
    if (t.parent.id === messageId) return t.parent;
    const m = t.replies.find((x) => x.id === messageId);
    if (m) return m;
  }
  return undefined;
}

const emptyMessages: ChannelMessages = { items: [], hasMore: true, loaded: false, loadingOlder: false };

export function channelMessages(s: ChatState, id: number): ChannelMessages {
  return s.messages[id] ?? emptyMessages;
}

/* ---------- Reducer ---------- */

export function reducer(s: ChatState, a: Action): ChatState {
  switch (a.type) {
    case "status":
      return { ...s, status: a.status };

    case "ready": {
      const online: Record<number, true> = {};
      for (const id of a.online) online[id] = true;
      return { ...s, me: a.me, online, users: withUsers(s.users, [a.me]), ai: a.ai };
    }

    case "me.updated":
      return { ...s, me: a.me, users: withUsers(s.users, [a.me]) };

    case "channels.loaded": {
      const channels: Record<number, Channel> = {};
      for (const c of a.channels) channels[c.id] = c;
      const activeId = s.activeId !== null && channels[s.activeId] ? s.activeId : null;
      return {
        ...s,
        channels,
        activeId,
        users: withUsers(
          s.users,
          a.channels.flatMap((c) => c.dm_members ?? []),
        ),
      };
    }

    case "channel.upsert": {
      const prev = s.channels[a.channel.id];
      const channel =
        a.keepUnread && prev
          ? { ...a.channel, unread_count: prev.unread_count, mention_count: prev.mention_count }
          : { ...a.channel, mention_count: a.channel.mention_count ?? 0 };
      return {
        ...s,
        channels: { ...s.channels, [channel.id]: channel },
        users: withUsers(s.users, channel.dm_members ?? []),
      };
    }

    case "channel.removed": {
      const { [a.channelId]: _gone, ...channels } = s.channels;
      const { [a.channelId]: _msgs, ...messages } = s.messages;
      return {
        ...s,
        channels,
        messages,
        activeId: s.activeId === a.channelId ? null : s.activeId,
        pending: s.pending.filter((p) => p.channelId !== a.channelId),
      };
    }

    case "channel.select":
      return { ...s, activeId: a.channelId, activeAuto: !!a.auto };

    case "channel.read": {
      const c = s.channels[a.channelId];
      if (!c || (c.unread_count === 0 && !c.mention_count)) return s;
      return { ...s, channels: { ...s.channels, [c.id]: { ...c, unread_count: 0, mention_count: 0 } } };
    }

    case "messages.loaded": {
      const cur = channelMessages(s, a.channelId);
      const items = mergeMessages(a.older ? cur.items : cur.loaded ? cur.items : [], a.messages);
      return {
        ...s,
        users: withUsers(
          s.users,
          a.messages.map((m) => m.user),
        ),
        messages: {
          ...s.messages,
          [a.channelId]: {
            items,
            // tải trang mới nhất (không phải "older") thì giữ hasMore cũ nếu đã có dữ liệu cũ hơn
            hasMore: a.older || !cur.loaded ? a.hasMore : cur.hasMore,
            loaded: true,
            loadingOlder: false,
          },
        },
      };
    }

    case "messages.loadingOlder": {
      const cur = channelMessages(s, a.channelId);
      return { ...s, messages: { ...s.messages, [a.channelId]: { ...cur, loadingOlder: a.loading } } };
    }

    case "messages.stale": {
      // Sau khi kết nối lại có thể đã lỡ tin: đánh dấu cần tải lại trang mới nhất.
      const messages: Record<number, ChannelMessages> = {};
      for (const [id, m] of Object.entries(s.messages)) messages[Number(id)] = { ...m, loaded: false };
      return { ...s, messages };
    }

    case "message.new": {
      const m = a.message;
      let messages = s.messages;
      let threads = s.threads;
      if (m.parent_id) {
        // Trả lời trong luồng: chỉ thêm vào luồng (nếu đang tải), không chen vào dòng chính.
        const t = s.threads[m.parent_id];
        if (t) threads = { ...s.threads, [m.parent_id]: { ...t, replies: mergeMessages(t.replies, [m]) } };
      } else {
        const cur = s.messages[m.channel_id];
        if (cur) messages = { ...s.messages, [m.channel_id]: { ...cur, items: mergeMessages(cur.items, [m]) } };
      }
      const pending = a.clientId ? s.pending.filter((p) => p.clientId !== a.clientId) : s.pending;
      let channels = s.channels;
      const c = s.channels[m.channel_id];
      if (c && a.countUnread && m.user_id !== s.me.id) {
        // Trả lời trong luồng không tính vào số chưa đọc của kênh, trừ khi nhắc tên mình.
        const mentioned = m.mentions?.includes(s.me.id) ? 1 : 0;
        const unread = m.parent_id ? 0 : 1;
        if (unread || mentioned) {
          channels = {
            ...s.channels,
            [c.id]: {
              ...c,
              unread_count: c.unread_count + unread,
              mention_count: (c.mention_count ?? 0) + mentioned,
            },
          };
        }
      }
      // người vừa gửi tin thì không còn "đang gõ"
      const t = s.typing[m.channel_id];
      let typing = s.typing;
      if (t?.[m.user_id]) {
        const { [m.user_id]: _x, ...rest } = t;
        typing = { ...s.typing, [m.channel_id]: rest };
      }
      // người gửi một tin ở dòng chính hiển nhiên đã xem tới tin đó
      const reads = m.parent_id ? s.reads : advanceRead(s, m.channel_id, m.user_id, m.id);
      return { ...s, messages, threads, pending, channels, typing, reads, users: withUsers(s.users, [m.user]) };
    }

    case "message.updated": {
      // giữ tóm tắt luồng hiện có (sự kiện sửa/xoá không đổi luồng)
      const m = a.message;
      const next = updateMessage(s, m.id, (old) => ({
        ...m,
        thread: m.thread ?? old.thread,
        poll: m.poll && old.poll ? { ...m.poll, my_votes: old.poll.my_votes } : m.poll,
        // sự kiện sửa/ghim không kèm ván chơi
        game: m.deleted_at ? undefined : mergeGame(old.game, m.game),
      }));
      // danh sách tin ghim của kênh (nếu đã tải): thêm / bỏ / cập nhật
      const list = s.pins[m.channel_id];
      if (!list) return next;
      const rest = list.filter((x) => x.id !== m.id);
      const pins = m.pinned_at && !m.deleted_at ? [m, ...rest] : rest;
      return { ...next, pins: { ...next.pins, [m.channel_id]: pins } };
    }

    case "reply.set": {
      const { [a.key]: _old, ...rest } = s.replyTo;
      return { ...s, replyTo: a.messageId ? { ...rest, [a.key]: a.messageId } : rest };
    }

    case "highlight":
      return { ...s, highlight: a.messageId ? { id: a.messageId, at: Date.now() } : null };

    case "update.available":
      return s.updateAvailable ? s : { ...s, updateAvailable: true };

    case "reminders.loaded":
      return { ...s, reminders: a.reminders };

    case "reminder.upsert": {
      const list = (s.reminders ?? []).filter((r) => r.id !== a.reminder.id);
      list.push(a.reminder);
      list.sort((x, y) => x.remind_at.localeCompare(y.remind_at));
      return { ...s, reminders: list };
    }

    case "reminder.remove":
      return { ...s, reminders: (s.reminders ?? []).filter((r) => r.id !== a.id) };

    case "pins.loaded":
      return {
        ...s,
        users: withUsers(
          s.users,
          a.messages.map((m) => m.user),
        ),
        pins: { ...s.pins, [a.channelId]: a.messages },
      };

    case "edit.start":
      return s.editingId === a.messageId ? s : { ...s, editingId: a.messageId };

    case "thread.open":
      return { ...s, openThreadId: a.parentId };

    case "thread.loaded":
      return updateMessage(
        {
          ...s,
          threads: { ...s.threads, [a.parent.id]: { parent: a.parent, replies: a.replies } },
          users: withUsers(s.users, [a.parent.user, ...a.replies.map((m) => m.user)]),
        },
        a.parent.id,
        () => a.parent,
      );

    case "thread.updated":
      return updateMessage(s, a.messageId, (m) => ({ ...m, thread: a.thread }));

    case "poll.set":
      return updateMessage(s, a.messageId, (m) => ({
        ...m,
        poll: { ...a.poll, my_votes: a.mine ? (a.poll.my_votes ?? []) : (m.poll?.my_votes ?? a.poll.my_votes) },
      }));

    case "link.prompt":
      return { ...s, linkPrompt: a.prompt };

    case "game.set":
      return updateMessage(s, a.messageId, (m) => (m.deleted_at ? m : { ...m, game: mergeGame(m.game, a.game) }));

    case "reactions.set":
      return updateMessage(s, a.messageId, (m) => ({ ...m, reactions: a.reactions }));

    case "reaction.toggleLocal": {
      // Cập nhật ngay trên máy mình; server sẽ gửi lại danh sách chuẩn qua "reaction.updated".
      const me = s.me.id;
      return updateMessage(s, a.messageId, (m) => {
        const list = (m.reactions ?? []).map((r) => ({ ...r, user_ids: [...r.user_ids] }));
        const r = list.find((x) => x.emoji === a.emoji);
        if (!r) list.push({ emoji: a.emoji, user_ids: [me] });
        else if (r.user_ids.includes(me)) r.user_ids = r.user_ids.filter((id) => id !== me);
        else r.user_ids.push(me);
        return { ...m, reactions: list.filter((x) => x.user_ids.length > 0) };
      });
    }

    case "pending.add":
      return { ...s, pending: [...s.pending, a.pending] };

    case "pending.failed":
      return {
        ...s,
        pending: s.pending.map((p) => (p.clientId === a.clientId ? { ...p, status: "failed", error: a.error } : p)),
      };

    case "pending.retry":
      return {
        ...s,
        pending: s.pending.map((p) => (p.clientId === a.clientId ? { ...p, status: "sending", error: undefined } : p)),
      };

    case "pending.progress":
      return {
        ...s,
        pending: s.pending.map((p) => (p.clientId === a.clientId ? { ...p, progress: a.progress } : p)),
      };

    case "pending.remove":
      return { ...s, pending: s.pending.filter((p) => p.clientId !== a.clientId) };

    case "typing":
      if (a.userId === s.me.id) return s;
      return {
        ...s,
        typing: { ...s.typing, [a.channelId]: { ...s.typing[a.channelId], [a.userId]: a.until } },
      };

    case "typing.expire": {
      let changed = false;
      const typing: ChatState["typing"] = {};
      for (const [cid, users] of Object.entries(s.typing)) {
        const keep: Record<number, number> = {};
        for (const [uid, until] of Object.entries(users)) {
          if (until > a.now) keep[Number(uid)] = until;
          else changed = true;
        }
        typing[Number(cid)] = keep;
      }
      return changed ? { ...s, typing } : s;
    }

    case "presence": {
      if (!!s.online[a.userId] === a.online) return s;
      const online = { ...s.online };
      if (a.online) online[a.userId] = true;
      else delete online[a.userId];
      return { ...s, online };
    }

    case "user.updated":
      return { ...s, users: withUsers(s.users, [a.user]) };

    case "members.loaded":
      return {
        ...s,
        users: withUsers(s.users, a.members),
        members: { ...s.members, [a.channelId]: a.members.map((u) => u.id) },
      };

    case "member.joined": {
      const c = s.channels[a.channelId];
      const list = s.members[a.channelId];
      return {
        ...s,
        users: withUsers(s.users, [a.user]),
        channels: c ? { ...s.channels, [c.id]: { ...c, member_count: c.member_count + 1 } } : s.channels,
        members: list && !list.includes(a.user.id) ? { ...s.members, [a.channelId]: [...list, a.user.id] } : s.members,
      };
    }

    case "reads.set": {
      const map: Record<number, number> = {};
      for (const r of a.reads) map[r.user_id] = r.message_id;
      return {
        ...s,
        users: withUsers(
          s.users,
          a.reads.map((r) => r.user),
        ),
        reads: { ...s.reads, [a.channelId]: map },
      };
    }

    case "read.updated": {
      const reads = advanceRead(s, a.channelId, a.userId, a.messageId);
      return reads === s.reads ? s : { ...s, reads };
    }

    case "member.left": {
      const c = s.channels[a.channelId];
      const list = s.members[a.channelId];
      const r = s.reads[a.channelId];
      let reads = s.reads;
      if (r?.[a.userId] !== undefined) {
        const { [a.userId]: _gone, ...rest } = r;
        reads = { ...s.reads, [a.channelId]: rest };
      }
      return {
        ...s,
        reads,
        channels: c ? { ...s.channels, [c.id]: { ...c, member_count: Math.max(0, c.member_count - 1) } } : s.channels,
        members: list ? { ...s.members, [a.channelId]: list.filter((id) => id !== a.userId) } : s.members,
      };
    }

    case "liveGames.loaded": {
      return {
        ...s,
        liveGames: {
          ...s.liveGames,
          [a.channelId]: a.games,
        },
      };
    }

    case "liveGames.upsert": {
      const list = s.liveGames[a.channelId] ?? [];
      const idx = list.findIndex((g) => g.message_id === a.game.message_id);
      let nextList: LiveGameItem[];
      if (idx >= 0) {
        nextList = [...list];
        nextList[idx] = a.game;
      } else {
        nextList = [a.game, ...list];
      }
      return {
        ...s,
        liveGames: {
          ...s.liveGames,
          [a.channelId]: nextList,
        },
      };
    }

    case "liveGames.remove": {
      const list = s.liveGames[a.channelId];
      if (!list) return s;
      const nextList = list.filter((g) => g.message_id !== a.messageId);
      if (nextList.length === list.length) return s;
      return {
        ...s,
        liveGames: {
          ...s.liveGames,
          [a.channelId]: nextList,
        },
      };
    }

    case "game.spectators": {
      const nextSpectators = {
        ...s.spectators,
        [a.messageId]: a.spectators,
      };

      let nextLiveGames = s.liveGames;
      const list = s.liveGames[a.channelId];
      if (list) {
        const idx = list.findIndex((g) => g.message_id === a.messageId);
        if (idx >= 0) {
          const nextList = [...list];
          nextList[idx] = {
            ...nextList[idx],
            viewer_count: a.count,
            spectators: a.spectators,
          };
          nextLiveGames = {
            ...s.liveGames,
            [a.channelId]: nextList,
          };
        }
      }

      return {
        ...s,
        spectators: nextSpectators,
        liveGames: nextLiveGames,
      };
    }
  }
}
