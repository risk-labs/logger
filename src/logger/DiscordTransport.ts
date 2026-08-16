import { isDictionary } from "../helpers/typeGuards";
import { AsyncLogQueue } from "./AsyncLogQueue";
import { TransportError } from "./TransportError";

import Transport from "winston-transport";

import axios from "axios";
import type { AxiosInstance } from "axios";

type TransportOptions = ConstructorParameters<typeof Transport>[0];

// Timeout applied to every webhook post. Without it a single hung socket holds a request open forever, which used to
// take the whole logger down with it (see AsyncLogQueue for why).
export const DISCORD_REQUEST_TIMEOUT_MS = 10_000;

// Bounds the memory held by a flood: beyond this many pending messages the oldest are dropped and reported in a
// summary message.
export const DISCORD_MAX_QUEUE_SIZE = 1000;

// Discord replies with 429 and a `retry_after` (in seconds) in the response body when a webhook is being posted to
// faster than its rate limit allows. Everything else is a genuine delivery failure and is reported rather than retried.
function discordRetryDelaySeconds(error: unknown): number | undefined {
  if (!axios.isAxiosError(error) || error.response?.status !== 429) return undefined;
  const retryAfter = Number((error.response.data as { retry_after?: unknown } | undefined)?.retry_after);
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1;
}

// Interface for log info object.
interface DiscordInfo {
  message: string;
  mrkdwn: string;
  notificationPath?: string;
  discordPaths?: string[] | null; // Optional as also might send to default channel.
}

interface Body {
  username: string;
  avatar_url: string;
  embeds: { title: string; description: string; color: number }[];
}
interface QueueElement {
  body: Body;
  webHook: string;
  info: unknown; // Retained only so that a failed delivery can be reported with the log entry that produced it.
}

// Type guard for log info object.
export const isDiscordInfo = (info: unknown): info is DiscordInfo => {
  if (!isDictionary(info)) return false;
  if (typeof info.message !== "string" || typeof info.mrkdwn !== "string") return false;
  if (typeof info.notificationPath !== "undefined" && typeof info.notificationPath !== "string") return false;
  if (typeof info.discordPaths === "undefined") return true; // Optional
  if (info.discordPaths === null) return true; // Can be explicitly set to null.

  // If provided and not null, discordPaths should be an array of strings.
  if (!Array.isArray(info.discordPaths)) return false;
  return info.discordPaths.every((path) => typeof path === "string");
};

export class DiscordTransport extends Transport {
  private readonly defaultWebHookUrl: string;
  private readonly escalationPathWebhookUrls: { [key: string]: string };
  private readonly postOnNonEscalationPaths: boolean;

  private readonly axiosInstance: AxiosInstance;
  private readonly maxQueueSize: number;
  private readonly logQueue: AsyncLogQueue<QueueElement>;

  constructor(
    winstonOpts: TransportOptions,
    ops: {
      defaultWebHookUrl: string;
      escalationPathWebhookUrls: { [key: string]: string };
      postOnNonEscalationPaths: boolean;
      maxQueueSize?: number;
    },
  ) {
    super(winstonOpts);
    this.defaultWebHookUrl = ops.defaultWebHookUrl;
    this.escalationPathWebhookUrls = ops.escalationPathWebhookUrls ?? {};
    this.postOnNonEscalationPaths = ops.postOnNonEscalationPaths ?? true;

    this.axiosInstance = axios.create({ timeout: DISCORD_REQUEST_TIMEOUT_MS });
    this.maxQueueSize = ops.maxQueueSize ?? DISCORD_MAX_QUEUE_SIZE;
    this.logQueue = new AsyncLogQueue<QueueElement>({
      maxQueueSize: this.maxQueueSize,
      deliver: async ({ webHook, body }) => {
        await this.axiosInstance.post(webHook, body);
      },
      onError: (error, { info }) => {
        // The winston callback has long since fired, so surface this on the transport instead. winston forwards it to
        // the logger's error event, where the existing transportErrorLogger plumbing picks it up.
        this.emit("error", new TransportError("Discord", error, info));
      },
      onDropped: (droppedCount) => this.reportDroppedMessages(droppedCount),
      retryDelaySeconds: discordRetryDelaySeconds,
    });
  }

  // Getter for checking if the transport is flushed.
  get isFlushed(): boolean {
    return this.logQueue.isFlushed;
  }

  // Note: info must be any because that's what the base class uses.
  log(info: any, callback: (error?: unknown) => void): void {
    // We only try sending if we have message and mrkdwn.
    // Also if discordPaths is null when provided then this is a noop message for Discord and the log should be skipped
    const canSend = isDiscordInfo(info) && info.discordPaths !== null;

    if (canSend) {
      try {
        const body = {
          username: "UMA Infrastructure",
          avatar_url: "https://i.imgur.com/RCcxxEZ.png",
          embeds: [{ title: `${info.message}`, description: this.formatLinks(info.mrkdwn), color: 9696729 }],
        };

        // A log message can conditionally contain additional Discord specific paths. Validate these first.
        let webHooks: string[] = [];
        if (info.discordPaths) {
          // Assign a webhook for each escalationPathWebHook defined for the provided discordPaths. This lets
          // the logger define exactly which logs should go to which discord channel.
          webHooks = info.discordPaths.map((discordPath) => this.escalationPathWebhookUrls[discordPath]);
        }

        // Else, There are no discord specific settings. In this case, we treat this like a normal log. Either the
        // transport is configured to send on undefined escalation paths (will use default path if path does
        // not exist) or the transport has a defined escalation path for the given message's notification path.
        else if (
          this.postOnNonEscalationPaths ||
          (info.notificationPath && this.escalationPathWebhookUrls[info.notificationPath])
        ) {
          // The webhook is preferentially set to the defined escalation path, or the default webhook.
          webHooks =
            info.notificationPath && this.escalationPathWebhookUrls[info.notificationPath]
              ? [this.escalationPathWebhookUrls[info.notificationPath]]
              : [this.defaultWebHookUrl];
        }

        // Queue a webhook request for each of the configured webhooks upstream. The queue posts them sequentially,
        // backing off when Discord rate limits us.
        for (const webHook of webHooks) this.logQueue.enqueue({ webHook, body, info });
      } catch (error) {
        return callback(new TransportError("Discord", error, info));
      }
    }

    // Acknowledge the write immediately: delivery happens in the background so that a slow or unresponsive webhook can
    // never apply backpressure to the winston pipeline and stall every other transport.
    callback();
  }

  // Posts a single summary in place of the messages shed during a flood, so that a gap in the channel is never silent.
  // Drops are counted across all webhooks but reported on the default one, since that is the channel that is watched.
  private reportDroppedMessages(droppedCount: number): void {
    const description =
      `Dropped ${droppedCount} log message(s) after exceeding the Discord transport queue limit of ` +
      `${this.maxQueueSize}. The dropped logs are still available in the console and GCP logs.`;
    this.logQueue.enqueue({
      webHook: this.defaultWebHookUrl,
      body: {
        username: "UMA Infrastructure",
        avatar_url: "https://i.imgur.com/RCcxxEZ.png",
        embeds: [{ title: "Dropped log messages", description, color: 9696729 }],
      },
      info: { at: "DiscordTransport", message: "Dropped log messages", droppedCount },
    });
  }

  // Discord URLS are formatted differently to markdown links produced upstream in the bots. For example, slack links
  // will look like this <https://google.com|google.com> but links for discord should look like this
  // [google.com](https://google.com).This function takes in the one format and converts it to the other such that
  // links sent to discord are nicely formatted and clickable.
  formatLinks(msg: any): any {
    // Find the start and end indexes of all the markdown links.
    const startIndexes: any = [];
    const endIndexes: any = [];
    for (let i = 0; i < msg.length; i++) {
      const startIndex = msg.indexOf("<", i);
      if (!startIndexes.includes(startIndex) && startIndex != -1) startIndexes.push(startIndex);

      const endIndex = msg.indexOf(">", i);
      if (!endIndexes.includes(endIndex) && endIndex != -1) endIndexes.push(endIndex);
    }

    // For each markdown link, build the new link with the discord format. Replace the original link with the new one.
    let modifiedMessage = msg;
    for (let i = 0; i < startIndexes.length; i++) {
      const originalUrl = msg.substring(startIndexes[i], endIndexes[i] + 1);
      const pipeIndex = originalUrl.indexOf("|");
      const markdownUrl =
        `[${originalUrl.substring(pipeIndex + 1, originalUrl.length - 1)}]` + // hyperlink
        `(${originalUrl.substring(1, pipeIndex)})`; // url
      modifiedMessage = modifiedMessage.replace(originalUrl, markdownUrl);
    }
    return modifiedMessage;
  }
}
