import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Enterprise notification fan-out (ARTEX notify): channels (feishu/wecom/
 * dingtalk/generic webhook) + an event/delivery ledger with per-channel rate
 * limiting. Events are enqueued in the same logical step as the finding
 * change; delivery is best-effort with one retry and never blocks the API.
 */

export type ChannelKind = "feishu" | "wecom" | "dingtalk" | "webhook";
export type DeliveryStatus = "pending" | "delivered" | "failed";

export interface NotifyChannel {
  id: string; name: string; kind: ChannelKind; enabled: boolean;
  config: Record<string, unknown>;
  mode: "realtime" | "digest";
  minSeverity: "" | "low" | "medium" | "high" | "critical";
  ratePerMin: number;
  createdAt: string; updatedAt: string;
}
export interface NotifyEvent {
  id: string; kind: "finding.created" | "finding.status" | "retest.verdict";
  title: string; body: string; severity: string; snapshot: Record<string, unknown>; createdAt: string;
}
export interface NotifyDelivery {
  id: string; eventId: string; channelId: string; status: DeliveryStatus;
  attempts: number; lastError?: string; lastAttemptAt?: string; deliveredAt?: string; createdAt: string;
}

interface NotifyDocument {
  schemaVersion: 1; channels: NotifyChannel[]; events: NotifyEvent[]; deliveries: NotifyDelivery[]; updatedAt: string;
}

const SEVERITY_ORDER = ["", "low", "medium", "high", "critical"];
const BOUNDS = { channels: 32, events: 1_000, deliveries: 2_000 };
const bodyOf = (input: Record<string, unknown>, channel: NotifyChannel): Record<string, unknown> => {
  const text = `${input.title ?? ""}\n${input.body ?? ""}`.trim();
  switch (channel.kind) {
    case "feishu": return { msg_type: "text", content: { text } };
    case "wecom": return { msgtype: "text", text: { content: text } };
    case "dingtalk": return { msgtype: "text", text: { content: text } };
    default: return { ...(input as Record<string, unknown>) };
  }
};
const headersOf = (channel: NotifyChannel): Record<string, string> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const extra = channel.config.headers;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra as Record<string, unknown>)) if (typeof value === "string") headers[key] = value;
  }
  return headers;
};
function urlOf(channel: NotifyChannel): string {
  if (channel.kind === "webhook") return String(channel.config.url ?? "");
  return String(channel.config.webhook ?? "");
}

export class NotifyStore {
  private doc: NotifyDocument = { schemaVersion: 1, channels: [], events: [], deliveries: [], updatedAt: new Date().toISOString() };
  private ready = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly buckets = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly file: string, private readonly fetcher: typeof fetch = fetch) {}

  private async load(): Promise<NotifyDocument> {
    if (this.ready) return this.doc;
    try { this.doc = { ...this.doc, ...(JSON.parse(await readFile(this.file, "utf8")) as Partial<NotifyDocument>) }; } catch { /* fresh store */ }
    this.ready = true;
    return this.doc;
  }

  private persist(): void {
    this.doc.updatedAt = new Date().toISOString();
    const snapshot = this.doc;
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(join(this.file, ".."), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, `${JSON.stringify(snapshot)}\n`, "utf8");
        await rename(tmp, this.file);
      } catch { /* best-effort persistence */ }
    });
  }

  // ------------------------------------------------------------ channels

  async listChannels(): Promise<NotifyChannel[]> { return (await this.load()).channels; }

  async upsertChannel(input: Partial<NotifyChannel> & { name: string; kind: ChannelKind }): Promise<NotifyChannel> {
    const doc = await this.load();
    if (!["feishu", "wecom", "dingtalk", "webhook"].includes(input.kind)) throw new Error("kind must be feishu, wecom, dingtalk, or webhook");
    const url = input.kind === "webhook" ? input.config?.url : input.config?.webhook;
    if (!url || typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error(`${input.kind === "webhook" ? "config.url" : "config.webhook"} must be an http(s) URL`);
    let channel = input.id ? doc.channels.find((item) => item.id === input.id) : undefined;
    if (input.id && !channel) throw new Error("channel not found");
    if (!channel) {
      channel = { id: `nc_${randomUUID().slice(0, 8)}`, name: input.name.slice(0, 120), kind: input.kind, enabled: true, config: {}, mode: "realtime", minSeverity: "", ratePerMin: 20, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      doc.channels.push(channel);
    }
    Object.assign(channel, {
      name: input.name.slice(0, 120), kind: input.kind, enabled: input.enabled ?? channel.enabled,
      config: input.config ?? channel.config, mode: input.mode ?? channel.mode,
      minSeverity: input.minSeverity ?? channel.minSeverity, ratePerMin: Math.max(0, Math.min(input.ratePerMin ?? channel.ratePerMin, 120)),
      updatedAt: new Date().toISOString(),
    });
    doc.channels = doc.channels.slice(0, BOUNDS.channels);
    this.persist();
    return channel;
  }

  async removeChannel(id: string): Promise<boolean> {
    const doc = await this.load();
    const index = doc.channels.findIndex((item) => item.id === id);
    if (index === -1) return false;
    doc.channels.splice(index, 1);
    this.persist();
    return true;
  }

  // ------------------------------------------------------------ events/deliveries

  /** Enqueue an event and fan out to matching channels (severity filter, rate limit). */
  async record(kind: NotifyEvent["kind"], payload: { title: string; body: string; severity?: string; snapshot?: Record<string, unknown> }): Promise<NotifyEvent> {
    const doc = await this.load();
    const event: NotifyEvent = { id: `ne_${randomUUID().slice(0, 8)}`, kind, title: payload.title.slice(0, 200), body: payload.body.slice(0, 2_000), severity: payload.severity ?? "", snapshot: payload.snapshot ?? {}, createdAt: new Date().toISOString() };
    doc.events.push(event);
    doc.events = doc.events.slice(-BOUNDS.events);
    const severity = payload.severity ?? "";
    for (const channel of doc.channels) {
      if (!channel.enabled || channel.mode !== "realtime") continue;
      if (SEVERITY_ORDER.indexOf(severity) < SEVERITY_ORDER.indexOf(channel.minSeverity)) continue;
      doc.deliveries.push({ id: `nd_${randomUUID().slice(0, 8)}`, eventId: event.id, channelId: channel.id, status: "pending", attempts: 0, createdAt: new Date().toISOString() });
    }
    doc.deliveries = doc.deliveries.slice(-BOUNDS.deliveries);
    this.persist();
    void this.flush();
    return event;
  }

  private rateAllow(channel: NotifyChannel): boolean {
    if (channel.ratePerMin === 0) return true;
    const now = Date.now();
    const bucket = this.buckets.get(channel.id);
    if (!bucket || now - bucket.windowStart >= 60_000) { this.buckets.set(channel.id, { windowStart: now, count: 1 }); return true; }
    if (bucket.count >= channel.ratePerMin) return false;
    bucket.count += 1;
    return true;
  }

  /** Deliver pending realtime deliveries; failures keep pending until the next trigger (one retry per flush). */
  async flush(): Promise<void> {
    const doc = await this.load();
    const pending = doc.deliveries.filter((item) => item.status === "pending").slice(0, 20);
    if (pending.length === 0) return;
    for (const delivery of pending) {
      const channel = doc.channels.find((item) => item.id === delivery.channelId);
      const event = doc.events.find((item) => item.id === delivery.eventId);
      if (!channel || !event || !channel.enabled) { delivery.status = "failed"; delivery.lastError = "channel missing or disabled"; continue; }
      if (!this.rateAllow(channel)) continue; // stays pending for the next flush
      let body: string;
      try {
        const payload = channel.kind === "webhook"
          ? { event: event.kind, title: event.title, body: event.body, severity: event.severity, snapshot: event.snapshot, at: event.createdAt }
          : bodyOf({ title: `[玄枢] ${event.title}`, body: event.body }, channel);
        if (channel.kind === "dingtalk" && typeof channel.config.secret === "string" && channel.config.secret) {
          const timestamp = Date.now();
          const sign = createHmac("sha256", channel.config.secret).update(`${timestamp}\n${channel.config.secret}`).digest("base64");
          const url = new URL(urlOf(channel));
          url.searchParams.set("timestamp", String(timestamp));
          url.searchParams.set("sign", sign);
          body = JSON.stringify(payload);
          const response = await this.fetcher(url.toString(), { method: "POST", headers: headersOf(channel), body });
          delivery.status = response.ok ? "delivered" : "failed";
          if (!response.ok) delivery.lastError = `HTTP ${response.status}`;
        } else {
          body = JSON.stringify(payload);
          const response = await this.fetcher(urlOf(channel), { method: "POST", headers: headersOf(channel), body });
          delivery.status = response.ok ? "delivered" : "failed";
          if (!response.ok) delivery.lastError = `HTTP ${response.status}`;
        }
      } catch (error) {
        delivery.status = "failed";
        delivery.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      }
      delivery.attempts += 1;
      delivery.lastAttemptAt = new Date().toISOString();
      if (delivery.status === "delivered") delivery.deliveredAt = delivery.lastAttemptAt;
      if (delivery.status === "failed" && delivery.attempts < 2) delivery.status = "pending"; // one retry on next flush
    }
    this.persist();
  }

  /** Manual test send (UI 验证按钮): a synthetic event through exactly this channel. */
  async testSend(channelId: string): Promise<{ delivered: boolean; error?: string }> {
    const doc = await this.load();
    const channel = doc.channels.find((item) => item.id === channelId);
    if (!channel) throw new Error("channel not found");
    try {
      const payload = channel.kind === "webhook" ? { event: "channel.test", title: "玄枢通知通道测试", at: new Date().toISOString() } : bodyOf({ title: "[玄枢] 通知通道测试", body: `通道 ${channel.name} 配置验证成功` }, channel);
      const response = await this.fetcher(urlOf(channel), { method: "POST", headers: headersOf(channel), body: JSON.stringify(payload) });
      return { delivered: response.ok, ...(response.ok ? {} : { error: `HTTP ${response.status}` }) };
    } catch (error) {
      return { delivered: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
    }
  }

  async snapshot(): Promise<NotifyDocument> { return await this.load(); }
}
