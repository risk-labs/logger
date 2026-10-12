import Transport from "winston-transport";
import axios from "axios";
import { createHash, randomUUID } from "crypto";
import * as ss from "superstruct";
import { TransportError } from "./TransportError";

const Destination = ss.object({
  url: ss.pattern(ss.string(), /^https:\/\/api\.incident\.io\/v2\/alert_events\/http\/[A-Za-z0-9_-]+$/),
  token: ss.size(ss.string(), 1, Infinity),
  urgency: ss.optional(ss.enums(["high", "low", "severity_based"])),
  supportHours: ss.optional(
    ss.object({
      timeZone: ss.string(),
      startHour: ss.min(ss.max(ss.integer(), 23), 0),
      endHour: ss.min(ss.max(ss.integer(), 24), 1),
    }),
  ),
});
const ConfigSchema = ss.object({
  destination: Destination,
  customServices: ss.optional(ss.record(ss.string(), Destination)),
});
export type Config = ss.Infer<typeof ConfigSchema>;
export function createConfig(value: unknown): Config {
  const config = ss.create(value, ConfigSchema);
  for (const destination of [config.destination, ...Object.values(config.customServices ?? {})]) {
    if (destination.supportHours) {
      const { timeZone, startHour, endHour } = destination.supportHours;
      new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
      if (startHour >= endHour) throw new Error("supportHours requires startHour < endHour");
    }
  }
  return config;
}

export function pagingUrgency(destination: Config["destination"], level: string, now = new Date()): string {
  if (destination.supportHours) {
    const { timeZone, startHour, endHour } = destination.supportHours;
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now));
    return hour >= startHour && hour < endHour ? "high" : "low";
  }
  const urgency = destination.urgency ?? "high";
  return urgency === "severity_based" ? (["warn", "warning", "info"].includes(level) ? "low" : "high") : urgency;
}

// An independent Winston transport: PagerDuty keeps its existing destination,
// delivery and failure handling. No PagerDuty webhook or API result is used.
export class IncidentIOTransport extends Transport {
  private pending = 0;
  get isFlushed(): boolean {
    return this.pending === 0;
  }
  constructor(
    options: ConstructorParameters<typeof Transport>[0],
    private readonly config: Config,
  ) {
    super(options);
  }

  async log(info: any, callback: (error?: unknown) => void): Promise<void> {
    this.pending++;
    try {
      const destination = this.config.customServices?.[info.notificationPath] ?? this.config.destination;

      const title = `${info.level}: ${info.at} ⭢ ${info.message}`;
      // Match the existing trigger-only logger semantics: each log occurrence
      // is separate unless its producer supplies a stable key. Retries of this
      // send always reuse the same key. Never infer recovery from quiet logs.
      const rawKey = typeof info.incidentDeduplicationKey === "string" ? info.incidentDeduplicationKey : randomUUID();
      const deduplicationKey = createHash("sha256")
        .update(JSON.stringify([info["bot-identifier"] ?? "", info.notificationPath ?? "", rawKey]))
        .digest("hex");
      const payload = {
        title: title.slice(0, 1024),
        description: typeof info.mrkdwn === "string" ? info.mrkdwn : title,
        status: "firing",
        deduplication_key: deduplicationKey,
        metadata: {
          ...info,
          paging_urgency: pagingUrgency(destination, info.level),
        },
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await axios.post(destination.url, payload, {
            headers: { Authorization: `Bearer ${destination.token}` },
            timeout: 5000,
            maxRedirects: 0,
          });
          if (
            !["accepted", "success"].includes(response.data?.status) ||
            response.data?.deduplication_key !== deduplicationKey
          ) {
            throw new Error("incident.io did not confirm the event key");
          }
          callback();
          return;
        } catch (error) {
          const status = axios.isAxiosError(error) ? error.response?.status : undefined;
          const retryable = status === undefined || status === 429 || status >= 500;
          if (!retryable || attempt === 2) {
            // Axios errors contain credentials and payloads. Never expose them
            // to the logger's error handlers or stringify the original error.
            throw new Error(`incident.io delivery failed${status ? ` (HTTP ${status})` : ""}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        }
      }
    } catch (error) {
      callback(new TransportError("incident.io", error, info));
    } finally {
      this.pending--;
    }
  }
}
