// REST client cho server go-chat. Kiểu dữ liệu khớp với package model bên Go.

export type User = {
  id: number;
  username: string;
  email: string;
  display_name: string;
  avatar: string | null;
  status_text: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type PublicUser = Pick<User, "id" | "username" | "display_name" | "avatar" | "status_text">;

export type Channel = {
  id: number;
  name: string;
  description: string;
  owner_id: number;
  /** Kênh riêng tư: không hiện ở "Khám phá kênh", chỉ vào được bằng link mời. */
  is_private: boolean;
  /** Mã trong link mời; chỉ có khi mình là thành viên. */
  invite_code?: string;
  created_at: string;
  updated_at: string;
  member_count: number;
  unread_count: number;
  /** Số tin chưa đọc có nhắc tên mình. */
  mention_count: number;
  /** "channel" = kênh thường, "dm" = tin nhắn riêng giữa hai người. */
  kind: "channel" | "dm";
  /** Tin nhắn riêng: hai người trong cuộc (một người nếu tự nhắn cho mình). */
  dm_members?: PublicUser[];
};

export type Attachment = {
  id: number;
  message_id: number;
  file_name: string;
  content_type: string;
  size: number;
  width: number;
  height: number;
  created_at: string;
  /** Đường dẫn tương đối trên server, ví dụ "/api/files/<key>". */
  url: string;
};

/** Sticker (bộ có sẵn trong app) hoặc GIF (GIPHY) gửi thay cho nội dung chữ. */
export type Embed = {
  type: "sticker" | "gif" | "call" | "game" | "share";
  id: string;
  url?: string;
  preview?: string;
  width?: number;
  height?: number;
  title?: string;
  /** Thẻ chia sẻ (type "share", id = id tin gốc): bản tóm tắt tin gốc lúc chia sẻ. */
  kind?: "message" | "game" | "poll" | "image" | "file" | "sticker" | "gif" | "call";
  text?: string;
  author?: string;
  channel?: string;
  channel_id?: number;
  /** Nhật ký cuộc gọi (type "call"). */
  video?: boolean;
  duration?: number;
  participants?: number;
};

/** GET /api/messages/{id}/link: người xem có tới được tin không (member) và tin đầy đủ nếu có. */
export type MessageLinkInfo = {
  channel: { id: number; name: string; kind: "channel" | "dm"; is_private: boolean; member_count?: number };
  member: boolean;
  message?: Message;
};

export type GameKind = "station" | "werewolf" | "spy" | "caro" | "rps" | "chess" | "xiangqi";
export type GamePlayer = { id: number; name: string };

export type GameMemberStats = {
  user_id: number;
  username: string;
  display_name: string;
  avatar: string | null;
  rating?: number;
  peak_rating?: number;
  rank_tier?: string;
  tier_badge?: string;
  wins: number;
  losses: number;
  draws: number;
  total_games: number;
  win_rate: number;
  current_streak?: number;
  best_streak?: number;
};

export type GameLeaderboard = {
  kind: string;
  top_wins: GameMemberStats[];
  top_losses: GameMemberStats[];
  members: GameMemberStats[];
  total_ended: number;
};

export type SpectatorInfo = {
  user_id: number;
  username: string;
  display_name: string;
  avatar?: string | null;
};

export type LiveGameItem = {
  message_id: number;
  channel_id: number;
  kind: GameKind;
  title: string;
  status: "lobby" | "playing";
  created_at: string;
  host: PublicUser;
  players: GamePlayer[];
  turn_user_id?: number | null;
  is_my_turn: boolean;
  reply_count: number;
  viewer_count: number;
  spectators?: SpectatorInfo[];
  game: GameView;
};

/** Ván chơi trong kênh, theo góc nhìn của mình (me: phần bí mật của riêng mình nếu mình đang chơi). */
export type GameView<S = Record<string, unknown>, M = Record<string, unknown>> = {
  kind: GameKind;
  title: string;
  status: "lobby" | "playing" | "ended";
  host_id: number;
  players: GamePlayer[];
  min_players: number;
  max_players: number;
  deadline?: string;
  log: string[];
  result?: string;
  winners?: number[];
  version: number;
  state?: S;
  me?: M;
};

export type PollOption = { id: number; text: string; votes: number; voter_ids?: number[] };

/** Bình chọn. my_votes chỉ có trong phản hồi riêng cho người xem (sự kiện phát chung thì không). */
export type Poll = {
  question: string;
  multiple: boolean;
  anonymous: boolean;
  closed_at?: string;
  /** Hạn chót tự kết thúc. */
  closes_at?: string;
  /** Cho mọi người thêm lựa chọn. */
  allow_add?: boolean;
  options: PollOption[];
  voters: number;
  my_votes?: number[];
};

/** Bản trích của tin được trả lời. */
export type QuotedMessage = {
  id: number;
  user_id: number;
  content: string;
  cipher?: string;
  embed?: Embed;
  attachments?: number;
  poll?: string;
  parent_id?: number;
  deleted?: boolean;
};

/** Nhắc việc: "nhắc tôi về tin này lúc …". */
export type Reminder = {
  id: number;
  message_id: number;
  remind_at: string;
  note?: string;
  /** Đã tới giờ (đã nhắc). */
  fired_at?: string;
  created_at: string;
  message?: Message;
};

/** Câu báo khi trang chạy trên http (trình duyệt chặn micro/camera), kèm địa chỉ https nếu có. */
export async function insecureMediaMessage(api: { rtcConfig: () => Promise<{ secure_url?: string }> }) {
  const url = await api
    .rtcConfig()
    .then((r) => r.secure_url)
    .catch(() => undefined);
  return url
    ? `Trình duyệt chỉ cho dùng micro/camera trên https. Hãy mở ${url} (lần đầu bấm "Nâng cao" → "Tiếp tục" vì chứng chỉ tự ký) hoặc dùng app desktop.`
    : "Trình duyệt chặn micro/camera vì trang không chạy trên https. Hãy mở bằng địa chỉ https hoặc app desktop.";
}

export type GifResult = { id: string; title: string; url: string; preview: string; width: number; height: number };

export type Message = {
  id: number;
  channel_id: number;
  user_id: number;
  content: string;
  created_at: string;
  /** Lần sửa gần nhất. */
  edited_at?: string;
  /** Tin đã bị xoá: không còn nội dung, file, cảm xúc. */
  deleted_at?: string;
  embed?: Embed;
  /** Tin mã hoá đầu cuối (tin nhắn riêng): nội dung thật nằm trong đây, content để trống. */
  cipher?: string;
  poll?: Poll;
  /** Ván chơi (tin có embed type "game"). */
  game?: GameView;
  pinned_at?: string;
  pinned_by?: number;
  reply_to_id?: number;
  reply_to?: QuotedMessage;
  forwarded?: boolean;
  user?: PublicUser;
  attachments?: Attachment[];
  /** Id những người được nhắc tên trong tin. */
  mentions?: number[];
  /** Cảm xúc đã thả, theo thứ tự emoji được thả đầu tiên. */
  reactions?: Reaction[];
  /** Có nếu tin là trả lời trong luồng: id tin gốc và người viết tin gốc. */
  parent_id?: number;
  parent_user_id?: number;
  /** Tóm tắt luồng (chỉ có ở tin gốc đã có người trả lời). */
  thread?: ThreadSummary;
};

export type Reaction = { emoji: string; user_ids: number[] };

/** Thông tin xem trước một link (khớp controller.LinkPreview bên Go). */
export type LinkPreview = {
  url: string;
  kind: "page" | "image" | "video" | "audio" | "youtube" | "none";
  title?: string;
  description?: string;
  site_name?: string;
  image?: string;
  embed_url?: string;
};

// Bộ nhớ đệm phía app: cùng một link trong nhiều tin chỉ hỏi server một lần.
const previewCache = new Map<string, Promise<LinkPreview>>();

export type ThreadSummary = {
  reply_count: number;
  last_reply_at: string;
  /** Tối đa 3 người, ai trả lời gần nhất đứng trước. */
  participant_ids: number[];
};

/** Thành viên user_id đã xem tới tin message_id. */
export type ReadState = { user_id: number; message_id: number; user?: PublicUser };

/** Giới hạn khớp với server (controller/files.go). */
export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_FILES = 10;

/** Lấy mã mời từ link (".../invite/<mã>") hoặc từ chính mã người dùng dán vào. */
export function parseInviteCode(input: string): string | null {
  const s = input.trim();
  const m = s.match(/invite\/([0-9a-f]{24})/i) ?? s.match(/^([0-9a-f]{24})$/i);
  return m ? m[1].toLowerCase() : null;
}

export const isInlineImage = (a: Pick<Attachment, "content_type">) =>
  ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(a.content_type);

export type AuthResponse = { token: string; user: User };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Chuẩn hoá địa chỉ server người dùng nhập ("localhost:4000", "http://host:4000/")
 * thành URL gốc http(s) không có dấu "/" cuối.
 */
export function normalizeServerUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = "http://" + s;
  s = s.replace(/^ws(s?):\/\//i, "http$1://");
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function socketUrl(serverUrl: string, token: string) {
  return serverUrl.replace(/^http/, "ws") + "/ws?token=" + encodeURIComponent(token);
}

type Options = {
  serverUrl: string;
  token?: string | null;
  /** Gọi khi server trả 401 (token hết hạn) để app quay về màn đăng nhập. */
  onUnauthorized?: () => void;
};

export function createApi({ serverUrl, token, onUnauthorized }: Options) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      const form = body instanceof FormData;
      res = await fetch(serverUrl + path, {
        method,
        headers: {
          ...(body !== undefined && !form ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, `Không kết nối được tới ${serverUrl}. Kiểm tra server đã chạy chưa.`);
    }

    if (res.status === 204) return undefined as T;

    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* body rỗng hoặc không phải JSON */
    }

    if (!res.ok) {
      if (res.status === 401 && token) onUnauthorized?.();
      const serverMsg = (data as { error?: unknown } | null)?.error;
      throw new ApiError(res.status, typeof serverMsg === "string" ? serverMsg : `Server trả lỗi ${res.status}.`);
    }
    return data as T;
  }

  return {
    register: (b: { username: string; email: string; password: string; display_name: string }) =>
      request<AuthResponse>("POST", "/api/auth/register", b),
    login: (b: { login: string; password: string }) => request<AuthResponse>("POST", "/api/auth/login", b),
    logout: () => request<void>("POST", "/api/auth/logout"),

    me: () => request<User>("GET", "/api/me"),
    updateMe: (b: { display_name?: string; avatar?: string; status_text?: string }) =>
      request<User>("PATCH", "/api/me", b),
    /** Tải ảnh đại diện lên (server lưu và đặt luôn làm ảnh đại diện). */
    uploadAvatar: (file: File) => {
      const fd = new FormData();
      fd.append("file", file, file.name);
      return request<User>("POST", "/api/me/avatar", fd);
    },
    changePassword: (b: { current_password: string; new_password: string }) =>
      request<void>("PUT", "/api/me/password", b),

    channels: () => request<Channel[]>("GET", "/api/channels"),
    /** Tìm người dùng (để nhắn riêng). */
    searchUsers: (q: string) => request<PublicUser[]>("GET", `/api/users?q=${encodeURIComponent(q)}`),
    /** Mở (hoặc tạo) cuộc trò chuyện riêng với userId. */
    openDM: (userId: number) => request<Channel>("POST", "/api/dms", { user_id: userId }),
    /** Tìm GIF (q rỗng: đang thịnh hành). enabled=false: server chưa cấu hình GIPHY. */
    gifs: (q: string, offset = 0) =>
      request<{ enabled: boolean; results: GifResult[]; next_offset?: number }>(
        "GET",
        `/api/gifs?q=${encodeURIComponent(q)}&offset=${offset}`,
      ),
    pin: (messageId: number, pinned: boolean) => request<Message>("POST", `/api/messages/${messageId}/pin`, { pinned }),
    pins: (channelId: number) => request<Message[]>("GET", `/api/channels/${channelId}/pins`),
    search: (q: string, channelId = 0, before = 0) =>
      request<{ messages: Message[]; has_more: boolean }>(
        "GET",
        `/api/search?q=${encodeURIComponent(q)}${channelId ? `&channel_id=${channelId}` : ""}${before ? `&before=${before}` : ""}`,
      ),
    createPoll: (
      channelId: number,
      b: {
        question: string;
        options: string[];
        multiple: boolean;
        anonymous: boolean;
        client_id: string;
        closes_at?: string;
        allow_add?: boolean;
      },
    ) => request<Message>("POST", `/api/channels/${channelId}/polls`, b),
    createGame: (channelId: number, b: { kind: GameKind; options?: Record<string, unknown>; client_id: string }) =>
      request<Message>("POST", `/api/channels/${channelId}/games`, b),
    liveGames: (channelId: number) => request<LiveGameItem[]>("GET", `/api/channels/${channelId}/live-games`),
    gameLeaderboard: (kind?: string) =>
      request<GameLeaderboard>("GET", `/api/games/leaderboard${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`),
    gameAction: (messageId: number, action: string, data?: unknown) =>
      request<GameView>("POST", `/api/messages/${messageId}/game`, data === undefined ? { action } : { action, data }),
    vote: (messageId: number, optionIds: number[]) =>
      request<Poll>("POST", `/api/messages/${messageId}/votes`, { option_ids: optionIds }),
    addPollOption: (messageId: number, text: string) =>
      request<Poll>("POST", `/api/messages/${messageId}/poll/options`, { text }),
    remind: (messageId: number, at: string, note: string) =>
      request<Reminder>("POST", `/api/messages/${messageId}/remind`, { at, note }),
    rtcConfig: () => request<{ ice_servers: RTCIceServer[]; secure_url?: string }>("GET", "/api/rtc-config"),
    reminders: () => request<Reminder[]>("GET", "/api/reminders"),
    snoozeReminder: (id: number, at: string) => request<Reminder>("PATCH", `/api/reminders/${id}`, { at }),
    deleteReminder: (id: number) => request<void>("DELETE", `/api/reminders/${id}`),
    closePoll: (messageId: number, closed: boolean) =>
      request<Poll>("POST", `/api/messages/${messageId}/poll/close`, { closed }),
    editMessage: (id: number, body: { content: string } | { cipher: string }) =>
      request<Message>("PATCH", `/api/messages/${id}`, body),
    /* Mã hoá đầu cuối */
    myKey: () => request<{ public_key: string; backup?: string }>("GET", "/api/keys/me"),
    putMyKey: (b: { public_key: string; backup: string; replace?: boolean }) =>
      request<{ public_key: string; backup?: string }>("PUT", "/api/keys/me", b),
    userKey: (id: number) => request<{ public_key: string }>("GET", `/api/users/${id}/key`),
    deleteMessage: (id: number) => request<Message>("DELETE", `/api/messages/${id}`),
    discover: () => request<Channel[]>("GET", "/api/channels/discover"),
    createChannel: (b: { name: string; description: string; is_private: boolean }) =>
      request<Channel>("POST", "/api/channels", b),
    updateChannel: (id: number, b: { name?: string; description?: string; is_private?: boolean }) =>
      request<Channel>("PATCH", `/api/channels/${id}`, b),
    regenerateInvite: (id: number) => request<Channel>("POST", `/api/channels/${id}/invite`),
    invitePreview: (code: string) => request<{ channel: Channel; is_member: boolean }>("GET", `/api/invites/${code}`),
    joinByInvite: (code: string) => request<Channel>("POST", `/api/invites/${code}/join`),
    /** Link mời đầy đủ; mở trên trình duyệt sẽ vào bản web của chính server này. */
    inviteLink: (code: string) => `${serverUrl}/invite/${code}`,
    /** Link mở thẳng tới một tin (…/m/<id>). */
    messageUrl: (id: number) => `${serverUrl}/m/${id}`,
    /** id tin nếu url là link tới tin trên máy chủ này (hoặc trang web đang mở). */
    messageIdFromUrl: (url: string): number | null => {
      try {
        const u = new URL(url);
        const m = u.pathname.match(/^\/m\/(\d{1,15})\/?$/);
        if (!m) return null;
        const same = [serverUrl, window.location.origin].some((o) => {
          try {
            return new URL(o).host === u.host;
          } catch {
            return false;
          }
        });
        return same ? Number(m[1]) : null;
      } catch {
        return null;
      }
    },
    messageLink: (id: number) => request<MessageLinkInfo>("GET", `/api/messages/${id}/link`),
    deleteChannel: (id: number) => request<void>("DELETE", `/api/channels/${id}`),
    joinChannel: (id: number) => request<Channel>("POST", `/api/channels/${id}/join`),
    leaveChannel: (id: number) => request<void>("POST", `/api/channels/${id}/leave`),
    members: (id: number) => request<PublicUser[]>("GET", `/api/channels/${id}/members`),
    /**
     * Gửi tin kèm file (multipart). Dùng XHR thay vì fetch để theo dõi tiến trình tải lên.
     * Server cũng phát "message.new" (kèm client_id) qua websocket như tin thường.
     */
    sendWithFiles: (
      channelId: number,
      b: {
        content: string;
        clientId: string;
        files: (File | Blob)[];
        parentId?: number;
        cipher?: string;
        replyToId?: number;
        forwarded?: boolean;
      },
      onProgress?: (fraction: number) => void,
    ) =>
      new Promise<Message>((resolve, reject) => {
        const form = new FormData();
        form.append("content", b.content);
        form.append("client_id", b.clientId);
        if (b.parentId) form.append("parent_id", String(b.parentId));
        if (b.cipher) form.append("cipher", b.cipher);
        if (b.replyToId) form.append("reply_to_id", String(b.replyToId));
        if (b.forwarded) form.append("forwarded", "1");
        // file đã mã hoá không gửi tên thật lên server
        b.files.forEach((f, i) => form.append("files", f, f instanceof File ? f.name : `encrypted-${i + 1}.bin`));

        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${serverUrl}/api/channels/${channelId}/messages`);
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress?.(e.loaded / e.total);
        };
        xhr.onload = () => {
          let data: unknown = null;
          try {
            data = JSON.parse(xhr.responseText);
          } catch {
            /* không phải JSON */
          }
          if (xhr.status >= 200 && xhr.status < 300) return resolve(data as Message);
          if (xhr.status === 401 && token) onUnauthorized?.();
          const serverMsg = (data as { error?: unknown } | null)?.error;
          reject(new ApiError(xhr.status, typeof serverMsg === "string" ? serverMsg : `Server trả lỗi ${xhr.status}.`));
        };
        xhr.onerror = () => reject(new ApiError(0, "Mất kết nối khi đang tải file lên."));
        xhr.send(form);
      }),

    /** URL tuyệt đối để hiển thị/tải file. download=true: buộc tải về thay vì mở. */
    fileUrl: (a: Pick<Attachment, "url">, download = false) =>
      a.url.startsWith("blob:") ? a.url : serverUrl + a.url + (download ? "?download=1" : ""),

    /** Thả/bỏ cảm xúc (bấm lại cùng emoji để bỏ). */
    toggleReaction: (messageId: number, emoji: string) =>
      request<{ reactions: Reaction[] }>("POST", `/api/messages/${messageId}/reactions`, { emoji }),
    /** Xem trước link (server tự tải trang, chặn địa chỉ nội bộ). */
    unfurl: (link: string): Promise<LinkPreview> => {
      let p = previewCache.get(link);
      if (!p) {
        p = request<LinkPreview>("GET", `/api/unfurl?url=${encodeURIComponent(link)}`).catch(() => {
          previewCache.delete(link); // lỗi mạng: lần sau thử lại
          return { url: link, kind: "none" } as LinkPreview;
        });
        previewCache.set(link, p);
      }
      return p;
    },
    /** Tin gốc và toàn bộ trả lời trong luồng. */
    thread: (messageId: number) =>
      request<{ parent: Message; replies: Message[] }>("GET", `/api/messages/${messageId}/thread`),

    messages: (id: number, before?: number, limit = 50) =>
      request<{ messages: Message[]; has_more: boolean; reads?: ReadState[] }>(
        "GET",
        `/api/channels/${id}/messages?limit=${limit}${before ? `&before=${before}` : ""}`,
      ),
  };
}

export type Api = ReturnType<typeof createApi>;
