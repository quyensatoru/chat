import type { GroupParticipant, GroupRoom } from "./groupcall";
import type { StationMap, StFrame } from "./station";

/** edit: vẽ lại được từ ảnh gốc. */
export type AIInfo = { bot_id: number; chat: boolean; image: boolean; edit?: boolean };
import type {
  Embed,
  GameView,
  Poll,
  Reminder,
  Message,
  Channel,
  PublicUser,
  Reaction,
  SpectatorInfo,
  ThreadSummary,
  User,
} from "./api";

/* ---------- Giao thức (khớp controller/events.go và controller/socket.go) ---------- */

export type ServerEvent =
  | {
      type: "ready";
      user: User;
      online_user_ids: number[];
      /** Mã bản build giao diện máy chủ đang phục vụ. */
      ui_build?: string;
      group_calls?: GroupRoom[];
      /** Trợ lý AI (không có: máy chủ tắt AI). */
      ai?: AIInfo;
    }
  | { type: "groupcall.state"; channel_id: number; started_at?: string; participants?: GroupParticipant[] }
  | { type: "groupcall.started"; channel_id: number; by: PublicUser; video?: boolean }
  | { type: "groupcall.welcome"; channel_id: number; self: string; participants?: GroupParticipant[] }
  | {
      type: "groupcall.signal";
      channel_id: number;
      from: string;
      from_user: PublicUser;
      data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
    }
  | { type: "groupcall.error"; channel_id: number; message: string }
  | { type: "message.new"; message: Message; client_id?: string }
  | { type: "message.updated"; message: Message }
  | { type: "key.updated"; user_id: number; public_key: string }
  | { type: "poll.updated"; channel_id: number; message_id: number; poll: Poll }
  | { type: "game.updated"; channel_id: number; message_id: number; game: GameView }
  | { type: "game.spectators"; channel_id: number; message_id: number; count: number; spectators: SpectatorInfo[] }
  | { type: "game.map"; message_id: number; map: StationMap }
  | { type: "game.frame"; message_id: number; frame: StFrame }
  | { type: "reminder.due"; reminder: Reminder }
  | { type: "call.incoming"; call_id: string; channel_id: number; from: PublicUser; video: boolean }
  | { type: "call.accepted"; call_id: string }
  | { type: "call.signal"; call_id: string; data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }
  | { type: "call.ended"; call_id: string; reason: string }
  | { type: "typing"; channel_id: number; user_id: number; parent_id?: number }
  | { type: "presence"; user_id: number; online: boolean }
  | { type: "user.updated"; user: PublicUser }
  | { type: "channel.joined"; channel: Channel }
  | { type: "channel.left"; channel_id: number }
  | { type: "channel.updated"; channel: Channel }
  | { type: "channel.deleted"; channel_id: number }
  | { type: "member.joined"; channel_id: number; user: PublicUser }
  | { type: "member.left"; channel_id: number; user_id: number }
  | { type: "reaction.updated"; channel_id: number; message_id: number; parent_id?: number; reactions: Reaction[] }
  | { type: "thread.updated"; channel_id: number; message_id: number; thread: ThreadSummary }
  | { type: "read.updated"; channel_id: number; user_id: number; message_id: number }
  | { type: "error"; message: string; client_id?: string }
  | { type: "pong" };

/** Tuỳ chọn khi gửi tin. */
export type SendOptions = {
  parentId?: number; // trả lời trong luồng
  embed?: Embed; // sticker / GIF
  cipher?: string; // tin mã hoá đầu cuối
  replyToId?: number; // trả lời trích dẫn
  forwarded?: boolean;
};

/** Yêu cầu gọi điện gửi lên máy chủ (xem controller/calls.go). */
export type CallRequest =
  | { type: "call.invite"; call_id: string; channel_id: number; video: boolean }
  | { type: "call.accept" | "call.decline" | "call.hangup"; call_id: string }
  | { type: "call.signal"; call_id: string; data: unknown };

export type ClientRequest =
  | CallRequest
  | {
      type: "message.send";
      channel_id: number;
      content: string;
      client_id: string;
      parent_id?: number;
      embed?: Embed;
      cipher?: string;
      reply_to_id?: number;
      forwarded?: boolean;
    }
  | { type: "game.spectate" | "game.unspectate"; message_id: number }
  | { type: "typing"; channel_id: number; parent_id?: number }
  | { type: "read"; channel_id: number; message_id: number }
  | { type: "ping" };

/**
 * idle          chưa kết nối
 * connecting    đang kết nối lần đầu
 * open          đã kết nối và nhận "ready"
 * reconnecting  rớt kết nối, đang chờ để thử lại
 * offline       máy mất mạng, sẽ thử lại khi có mạng
 * unauthorized  token hết hạn (server đóng với mã 4001), không thử lại
 * closed        đã đóng chủ động (đăng xuất)
 */
export type SocketStatus = "idle" | "connecting" | "open" | "reconnecting" | "offline" | "unauthorized" | "closed";

type EventOf<T extends ServerEvent["type"]> = Extract<ServerEvent, { type: T }>;
type Handler<T extends ServerEvent["type"]> = (ev: EventOf<T>) => void;

const CLOSE_UNAUTHORIZED = 4001;

const HEARTBEAT_INTERVAL_MS = 25_000; // gửi ping nếu im lặng quá lâu
const HEARTBEAT_TIMEOUT_MS = 10_000; // không nhận được gì sau ping -> coi như kết nối chết
const CONNECT_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const SEND_ACK_TIMEOUT_MS = 15_000; // tin gửi đi không thấy server xác nhận -> báo lỗi
const OUTBOX_MAX = 200;

/**
 * Kết nối websocket tới server chat:
 *  - tự kết nối lại với exponential backoff + jitter,
 *  - heartbeat ping/pong để phát hiện kết nối "treo" (trình duyệt không tự báo),
 *  - tạm dừng khi máy mất mạng và kết nối lại ngay khi có mạng,
 *  - xếp hàng tin nhắn gửi lúc đang mất kết nối, gửi lại khi kết nối xong,
 *  - theo dõi tin đã gửi: server phát lại "message.new" kèm client_id thì coi là thành công,
 *    quá SEND_ACK_TIMEOUT_MS thì phát "send-failed".
 */
export class ChatSocket {
  private ws: WebSocket | null = null;
  private status: SocketStatus = "idle";
  private attempt = 0;
  private retryTimer: number | undefined;
  private connectTimer: number | undefined;
  private heartbeatTimer: number | undefined;
  private heartbeatDeadline: number | undefined;
  private stopped = false;

  private handlers = new Map<string, Set<(ev: ServerEvent) => void>>();
  private statusHandlers = new Set<(s: SocketStatus) => void>();
  private failHandlers = new Set<(clientId: string, reason: string) => void>();

  /** Tin chưa gửi được vì đang mất kết nối. */
  private outbox: Extract<ClientRequest, { type: "message.send" }>[] = [];
  /** Tin đã gửi, đang chờ server xác nhận: client_id -> timer. */
  private awaitingAck = new Map<string, number>();

  constructor(private url: string) {}

  /* ---------- Vòng đời ---------- */

  connect() {
    this.stopped = false;
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
    this.open();
  }

  /** Đóng hẳn, không kết nối lại (đăng xuất / unmount). */
  close() {
    this.stopped = true;
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
    this.clearTimers();
    for (const t of this.awaitingAck.values()) window.clearTimeout(t);
    this.awaitingAck.clear();
    this.outbox = [];
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "client closed");
    this.setStatus("closed");
  }

  /** Thử kết nối lại ngay (ví dụ người dùng bấm "Thử lại"). */
  reconnectNow() {
    if (this.stopped || this.status === "open" || this.status === "connecting") return;
    window.clearTimeout(this.retryTimer);
    this.open();
  }

  getStatus() {
    return this.status;
  }

  /* ---------- Đăng ký sự kiện ---------- */

  on<T extends ServerEvent["type"]>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler as (ev: ServerEvent) => void);
    return () => set!.delete(handler as (ev: ServerEvent) => void);
  }

  onStatus(handler: (s: SocketStatus) => void): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  /** Tin nhắn không gửi được (lỗi từ server hoặc quá thời gian chờ). */
  onSendFailed(handler: (clientId: string, reason: string) => void): () => void {
    this.failHandlers.add(handler);
    return () => this.failHandlers.delete(handler);
  }

  /* ---------- Gửi ---------- */

  /**
   * Gửi tin nhắn. Đang mất kết nối thì xếp hàng, kết nối lại sẽ tự gửi.
   * Kết quả trả về qua sự kiện "message.new" (cùng client_id) hoặc onSendFailed.
   */
  sendMessage(channelId: number, content: string, clientId: string, o: SendOptions = {}) {
    const req = {
      type: "message.send",
      channel_id: channelId,
      content,
      client_id: clientId,
      ...(o.parentId ? { parent_id: o.parentId } : {}),
      ...(o.embed ? { embed: o.embed } : {}),
      ...(o.cipher ? { cipher: o.cipher } : {}),
      ...(o.replyToId ? { reply_to_id: o.replyToId } : {}),
      ...(o.forwarded ? { forwarded: true } : {}),
    } as const;
    if (this.status === "open" && this.rawSend(req)) {
      this.trackAck(clientId);
      return;
    }
    if (this.outbox.length >= OUTBOX_MAX) {
      this.fail(clientId, "Quá nhiều tin đang chờ gửi.");
      return;
    }
    this.outbox.push(req);
  }

  /** Bỏ một tin khỏi hàng đợi (người dùng huỷ tin đang chờ). */
  cancelMessage(clientId: string) {
    this.outbox = this.outbox.filter((m) => m.client_id !== clientId);
    const t = this.awaitingAck.get(clientId);
    if (t !== undefined) window.clearTimeout(t);
    this.awaitingAck.delete(clientId);
  }

  /** Sự kiện phụ (typing, read): mất kết nối thì bỏ qua, không xếp hàng. */
  /** Tín hiệu gọi điện: chỉ gửi khi đang kết nối (không xếp hàng). Trả về false nếu không gửi được. */
  sendCall(req: CallRequest): boolean {
    return this.status === "open" && this.rawSend(req);
  }

  /** Tín hiệu gọi nhóm (không xếp hàng). */
  sendGroup(req: Record<string, unknown>): boolean {
    return this.status === "open" && this.rawSend(req as unknown as ClientRequest);
  }

  /** Trò chơi thời gian thực: game.watch / game.unwatch / game.pos (mất kết nối thì bỏ). */
  sendGame(req: Record<string, unknown>): boolean {
    return this.status === "open" && this.rawSend(req as unknown as ClientRequest);
  }

  sendTyping(channelId: number, parentId?: number) {
    if (this.status === "open") this.rawSend({ type: "typing", channel_id: channelId, parent_id: parentId });
  }

  spectateGame(messageId: number) {
    if (this.status === "open") this.rawSend({ type: "game.spectate", message_id: messageId });
  }

  unspectateGame(messageId: number) {
    if (this.status === "open") this.rawSend({ type: "game.unspectate", message_id: messageId });
  }

  markRead(channelId: number, messageId: number) {
    if (this.status === "open") this.rawSend({ type: "read", channel_id: channelId, message_id: messageId });
  }

  /* ---------- Nội bộ ---------- */

  private open() {
    this.clearTimers();
    if (this.stopped) return;
    if (!navigator.onLine) {
      this.setStatus("offline");
      return;
    }

    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    // Kết nối treo ở bước bắt tay (ví dụ server không trả lời) thì huỷ để thử lại.
    this.connectTimer = window.setTimeout(() => {
      if (this.ws === ws && ws.readyState === WebSocket.CONNECTING) ws.close();
    }, CONNECT_TIMEOUT_MS);

    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.armHeartbeat(); // có dữ liệu tới tức là kết nối còn sống
      let ev: ServerEvent;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (ev.type === "ready") {
        window.clearTimeout(this.connectTimer);
        this.attempt = 0;
        this.setStatus("open");
        this.flushOutbox();
      } else if (ev.type === "message.new" && ev.client_id) {
        this.resolveAck(ev.client_id);
      } else if (ev.type === "error" && ev.client_id) {
        this.resolveAck(ev.client_id);
        this.fail(ev.client_id, ev.message);
        return; // đã báo qua onSendFailed
      }
      this.emit(ev);
    };

    ws.onclose = (e) => {
      if (this.ws !== ws) return; // kết nối cũ, đã thay bằng kết nối mới
      this.ws = null;
      this.clearTimers();
      // Tin đã gửi nhưng chưa được xác nhận: không chắc server đã nhận, báo lỗi để người dùng gửi lại.
      for (const id of [...this.awaitingAck.keys()]) {
        this.resolveAck(id);
        this.fail(id, "Mất kết nối trước khi server xác nhận.");
      }
      if (this.stopped) return;
      if (e.code === CLOSE_UNAUTHORIZED) {
        this.stopped = true;
        this.setStatus("unauthorized");
        return;
      }
      this.scheduleReconnect();
    };

    // onerror luôn đi kèm onclose, xử lý ở onclose là đủ.
    ws.onerror = () => {};
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (!navigator.onLine) {
      this.setStatus("offline");
      return;
    }
    this.setStatus("reconnecting");
    const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    const delay = exp / 2 + Math.random() * (exp / 2); // jitter: tránh mọi client cùng thử lại một lúc
    this.attempt += 1;
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }

  private armHeartbeat() {
    window.clearTimeout(this.heartbeatTimer);
    window.clearTimeout(this.heartbeatDeadline);
    this.heartbeatTimer = window.setTimeout(() => {
      if (!this.rawSend({ type: "ping" })) return;
      this.heartbeatDeadline = window.setTimeout(() => {
        // Không nhận được gì: kết nối đã chết dù trình duyệt chưa biết. Đóng để kích hoạt kết nối lại.
        this.ws?.close(4000, "heartbeat timeout");
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private flushOutbox() {
    const queued = this.outbox;
    this.outbox = [];
    for (const req of queued) {
      if (this.rawSend(req)) this.trackAck(req.client_id);
      else this.outbox.push(req);
    }
  }

  private trackAck(clientId: string) {
    this.awaitingAck.set(
      clientId,
      window.setTimeout(() => {
        this.awaitingAck.delete(clientId);
        this.fail(clientId, "Server không phản hồi.");
      }, SEND_ACK_TIMEOUT_MS),
    );
  }

  private resolveAck(clientId: string) {
    const t = this.awaitingAck.get(clientId);
    if (t !== undefined) window.clearTimeout(t);
    this.awaitingAck.delete(clientId);
  }

  private fail(clientId: string, reason: string) {
    for (const h of this.failHandlers) h(clientId, reason);
  }

  private rawSend(req: ClientRequest): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(req));
    return true;
  }

  private emit(ev: ServerEvent) {
    const set = this.handlers.get(ev.type);
    if (!set) return;
    for (const h of set) {
      try {
        h(ev);
      } catch (err) {
        console.error(`socket handler "${ev.type}" lỗi:`, err);
      }
    }
  }

  private setStatus(s: SocketStatus) {
    if (this.status === s) return;
    this.status = s;
    for (const h of this.statusHandlers) h(s);
  }

  private clearTimers() {
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.connectTimer);
    window.clearTimeout(this.heartbeatTimer);
    window.clearTimeout(this.heartbeatDeadline);
  }

  private handleOnline = () => {
    if (this.stopped) return;
    this.attempt = 0;
    if (this.status === "offline" || this.status === "reconnecting") {
      window.clearTimeout(this.retryTimer);
      this.open();
    }
  };

  private handleOffline = () => {
    if (this.stopped) return;
    // Đóng chủ động: onclose sẽ thấy navigator.onLine = false và chuyển sang "offline".
    this.ws?.close();
  };
}
