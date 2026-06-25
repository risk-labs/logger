// This transport enables slack messages to be sent from Winston logging. To configure this
// create a slack webhook and add this to your .env file. a sample in .env_sample shows this.
// see https://slack.com/intl/en-za/help/articles/115005265063-Incoming-Webhooks-for-Slack for more.

// This formatter assumes one of two kinds of inputs:
// 1) A pre-formatted markdown message with a key value named `mrkdwn`. These messages come from bots that have strict
//    formatting rules around how text should be formatted. An example Winston log:
//    this.logger.warn({
//      at: "ContractMonitor",
//      message: "Collateralization ratio alert 🙅‍♂️!",
//      mrkdwn: *This is a markdown* formatted String With markdown syntax.});
//    In this type the transport simply sends the markdown text to the slack webhook.
// 2) A log message can also contain javascript strings, numbers, and even objects. In this case the transport will
//    spread out the content within the log message. Nested objects are also printed. An example Winston log:
//    this.logger.info({
//      at: "Liquidator",
//      message: "Liquidation withdrawn🤑",
//      liquidation: liquidation,
//      amount: withdrawAmount.rawValue,
//      txnConfig,
//      liquidationResult: logResult});
//    In this log the liquidation and txnConfig are objects. these are spread as nested bullet points in the slack message.
//    The amount is a string value. This is shown as a bullet point item.
import Transport from "winston-transport";
import axios from "axios";
import type { AxiosInstance, AxiosRequestConfig } from "axios";

interface MarkdownText {
  type: "mrkdwn";
  text: string;
}

type Text = MarkdownText; // Add more | types here to add other types of text.

interface SectionBlock {
  type: "section";
  text: Text;
}

interface DividerBlock {
  type: "divider";
}

type Block = SectionBlock | DividerBlock; // Add more | types here to add more types of blocks.

interface SlackFormatterResponse {
  blocks: Block[];
}

export const SLACK_MAX_CHAR_LIMIT = 3000;

// Note: info is any because it comes directly from winston.
function slackFormatter(info: any): SlackFormatterResponse {
  try {
    if (!("level" in info) || !("at" in info) || !("message" in info))
      throw new Error("WINSTON MESSAGE INCORRECTLY CONFIGURED");

    // Each part of the slack response is a separate block with markdown text within it.
    // All slack responses start with the heading level and where the message came from.
    const formattedResponse: SlackFormatterResponse = {
      // If the bot contains an identifier flag it should be included in the heading.
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `[${info.level}] *${info["bot-identifier"]}* (${info.at})⭢${info.message}\n` },
        },
      ],
    };
    // All messages from winston come in as a Json object. The loop below expands this object and adds mrkdwn sections
    // for each key value pair with a bullet point. If the section is an object then it was passed containing multiple
    // sub points. This is also expanded as a sub indented section.
    for (const key in info) {
      // these keys have been printed in the previous block or should not be included in slack messages.
      if (
        key == "at" ||
        key == "level" ||
        key == "message" ||
        key == "bot-identifier" ||
        key == "notificationPath" ||
        key == "discordPaths"
      )
        continue;

      // If the key is `mrkdwn` then simply return only the markdown as the txt object. This assumes all formatting has
      // been applied in the bot itself. For example the monitor bots which conform to strict formatting rules.
      if (key == "mrkdwn") {
        formattedResponse.blocks.push({ type: "section", text: { type: "mrkdwn", text: ` ${info[key]}` } });
      }
      // If the value in the message is an object then spread each key value pair within the object.
      else if (typeof info[key] === "object" && info[key] !== null) {
        // Note: create local reference to this object, so we can modify it in the if statement.
        const newBlock: SectionBlock = { type: "section", text: { type: "mrkdwn", text: ` • _${key}_:\n` } };
        // Note: after pushing, we can still modify newBlock and it will affect the element in the array since what's
        // pushed into the array is a pointer.
        formattedResponse.blocks.push(newBlock);
        // For each key value pair within the object, spread the object out for formatting.
        for (const subKey in info[key]) {
          // If the value within the object itself is an object we dont want to spread it any further. Rather,
          // convert the object to a string and print it along side it's key value pair.
          if (typeof info[key][subKey] === "object" && info[key][subKey] !== null) {
            formattedResponse.blocks.push({
              type: "section",
              text: { type: "mrkdwn", text: `    - _${subKey}_: ${JSON.stringify(info[key][subKey])}\n` },
            });
            // Else if not a address, transaction or object then print as ` - key: value`
          } else {
            formattedResponse.blocks.push({
              type: "section",
              text: { type: "mrkdwn", text: `    - _${subKey}_: ${info[key][subKey]}\n` },
            });
          }
        }
        // Else, if the input is not an object then print the values as key value pairs. First check for addresses or txs
      } else if (info[key]) {
        formattedResponse.blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: ` • _${key}_: ${info[key]}\n` },
        });

        // Else, if the value from the key value pair is null still show the key in the log. For example if a param is
        // logged but empty we still want to see the key.
      } else if (info[key] == null) {
        formattedResponse.blocks.push({ type: "section", text: { type: "mrkdwn", text: ` • _${key}_: null` } });
      }
    }
    // Add a divider to the end of the message to help distinguish messages in long lists.
    formattedResponse.blocks.push({ type: "divider" });
    return formattedResponse;
  } catch (error) {
    return {
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Something went wrong in the winston formatter!*\n\nError:${error}\n\nlogInfo:${JSON.stringify(
              info,
            )}`,
          },
        },
      ],
    };
  }
}

type TransportOptions = NonNullable<ConstructorParameters<typeof Transport>[0]>;
interface Options extends TransportOptions {
  name?: string;
  transportConfig: {
    escalationPathWebhookUrls?: { [key: string]: string };
    defaultWebHookUrl: string;
    // Minimum spacing between two POSTs to the same webhook — the "emit at a specific rate" lever.
    // Optional; defaults to DEFAULT_MIN_SEND_INTERVAL_MS (~1 msg/sec, just under Slack's webhook limit).
    minSendIntervalMs?: number;
  };
  formatter: (info: any) => SlackFormatterResponse;
  mrkdwn?: boolean;
  proxy?: AxiosRequestConfig["proxy"];
}

// Slack incoming webhooks allow ~1 request/second/webhook, so the default spacing stays just under that.
export const DEFAULT_MIN_SEND_INTERVAL_MS = 1100;
const MAX_RETRIES = 5; // attempts for a single message before it is dropped
const MAX_QUEUE_SIZE = 1000; // messages buffered per webhook before the oldest are dropped (bounds memory)
const RETRY_FALLBACK_MS = 1000; // retry wait when Slack sent no Retry-After (5xx / network error)

class SlackHook extends Transport {
  private name: string;
  private readonly escalationPathWebhookUrls: { [key: string]: string };
  private readonly defaultWebHookUrl: string;
  private readonly formatter: (info: any) => SlackFormatterResponse;
  private readonly mrkdwn: boolean;
  private readonly axiosInstance: AxiosInstance;
  private readonly minSendIntervalMs: number;
  // One FIFO queue and at most one in-flight drain per webhook URL (Slack's rate limit is per-webhook).
  private readonly queues = new Map<string, { body: unknown; attempts: number }[]>();
  private readonly draining = new Set<string>();

  constructor(opts: Options) {
    super(opts);
    this.name = opts.name || "slackWebhook";
    this.level = opts.level || undefined;
    this.escalationPathWebhookUrls = opts.transportConfig.escalationPathWebhookUrls || {};
    this.defaultWebHookUrl = opts.transportConfig.defaultWebHookUrl;
    this.formatter = opts.formatter;
    this.mrkdwn = opts.mrkdwn || false;
    this.minSendIntervalMs = opts.transportConfig.minSendIntervalMs ?? DEFAULT_MIN_SEND_INTERVAL_MS;
    // Accept every status so we can read 429s (and their Retry-After) instead of letting axios throw.
    this.axiosInstance = axios.create({ proxy: opts.proxy, validateStatus: () => true });
  }

  log(info: any, callback: (error?: unknown) => void): void {
    try {
      // If the log contains a notification path then use a custom slack webhook service. This lets the transport route to
      // different slack channels depending on the context of the log.
      const webhookUrl = this.escalationPathWebhookUrls[info.notificationPath] ?? this.defaultWebHookUrl;

      const payload: { blocks?: Block[]; text?: string; mrkdwn?: boolean } = { mrkdwn: this.mrkdwn };
      const layout = this.formatter(info);
      payload.blocks = layout.blocks || undefined;
      // Split a >3000-char payload into several slack messages; otherwise send it as one.
      const bodies =
        JSON.stringify(payload).length < SLACK_MAX_CHAR_LIMIT
          ? [payload]
          : processMessageBlocks(payload.blocks ?? []).map((blocks) => ({ ...payload, blocks }));
      for (const body of bodies) this.enqueue(webhookUrl, body);
    } catch (error) {
      // Don't surface errors back through winston — that makes it try to log the failure, which in
      // serverless mode emits the noisy "Attempt to write logs with no transports" warning we're killing.
      // eslint-disable-next-line no-console
      console.warn("[SlackTransport] Failed to enqueue Slack message:", error);
    }
    callback(); // accepted into the queue; let winston proceed without waiting for delivery
  }

  private enqueue(webhookUrl: string, body: unknown): void {
    const queue = this.queues.get(webhookUrl) ?? this.queues.set(webhookUrl, []).get(webhookUrl)!;
    if (queue.length >= MAX_QUEUE_SIZE) queue.shift(); // bound memory: drop oldest under a sustained backlog
    queue.push({ body, attempts: 0 });
    void this.drain(webhookUrl);
  }

  // Drains a webhook's queue one message at a time, spaced by minSendIntervalMs, retrying 429s and 5xx.
  private async drain(webhookUrl: string): Promise<void> {
    if (this.draining.has(webhookUrl)) return;
    this.draining.add(webhookUrl);
    const queue = this.queues.get(webhookUrl) ?? [];
    try {
      while (queue.length > 0) {
        const message = queue[0];
        message.attempts += 1;
        const retryMs = await this.deliver(webhookUrl, message.body);
        if (retryMs !== null && message.attempts <= MAX_RETRIES) {
          await sleep(retryMs); // wait Slack's Retry-After (or fallback), then retry the same message
        } else {
          queue.shift(); // delivered, permanently failed, or out of retries
          if (queue.length > 0) await sleep(this.minSendIntervalMs);
        }
      }
    } finally {
      this.draining.delete(webhookUrl);
    }
  }

  // POSTs once. Returns ms to wait before retrying (429/5xx/network), or null when there's nothing to retry.
  private async deliver(webhookUrl: string, body: unknown): Promise<number | null> {
    try {
      const { status, headers } = await this.axiosInstance.post(webhookUrl, body);
      if (status === 200) return null; // delivered
      if (status === 429) return parseRetryAfterMs(headers?.["retry-after"]) ?? RETRY_FALLBACK_MS;
      if (status >= 500) return RETRY_FALLBACK_MS;
      return null; // permanent 4xx (bad payload / disabled webhook) — don't retry
    } catch {
      return RETRY_FALLBACK_MS; // network error — retry
    }
  }
}

// Parse a Slack Retry-After header (integer seconds) into milliseconds; null when absent/unparseable.
export function parseRetryAfterMs(headerValue: unknown): number | null {
  if (headerValue == null) return null;
  const seconds = Number(Array.isArray(headerValue) ? headerValue[0] : headerValue);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processMessageBlocks(blocks: Block[]): Block[][] {
  // If it's more than 3000 chars then we need to split the message sent to slack API into multiple calls.
  let messageIndex = 0;

  // Split any block that's longer than 3000 chars by new line (\n) if possible.
  const splitBlocks = [];
  for (const block of blocks) {
    // If any of the smaller blocks is still larger than 3000 chars then we must redact part of the message.
    for (let smallerBlock of splitByNewLine(block)) {
      if (JSON.stringify(smallerBlock).length > SLACK_MAX_CHAR_LIMIT) {
        const stringifiedBlock = JSON.stringify(smallerBlock);
        const redactedBlock =
          stringifiedBlock.substr(0, 1400) +
          "-MESSAGE REDACTED DUE TO LENGTH-" +
          stringifiedBlock.substr(stringifiedBlock.length - 1400, stringifiedBlock.length);
        smallerBlock = JSON.parse(redactedBlock);
      }
      splitBlocks.push(smallerBlock);
    }
  }

  const processedBlocks: Block[][] = [[]];
  for (const block of splitBlocks) {
    if (JSON.stringify([...processedBlocks[messageIndex], block]).length > SLACK_MAX_CHAR_LIMIT) {
      // If the set blocks is larger than 3000 then we must increment the message index, to enable sending the set
      // of messages over multiple calls to the slack API. The amounts to splitting up one Winston log into multiple
      // slack messages with no single slack message exceeding the 3000 char limit.
      messageIndex += 1;
    }
    if (!processedBlocks[messageIndex]) processedBlocks[messageIndex] = [];
    processedBlocks[messageIndex].push(block);
  }

  return processedBlocks;
}

export function splitByNewLine(block: Block): Block[] {
  // No need to split if the block is already under limit.
  if (block.type === "divider" || JSON.stringify(block).length <= SLACK_MAX_CHAR_LIMIT) {
    return [block];
  }

  const lines = block.text.text.split("\n");
  const smallerBlocks: SectionBlock[] = [];
  for (let line of lines) {
    // Skip empty lines.
    if (line.length == 0) continue;

    // Add a new block if the previous block's content + current line exceed the char limit.
    line += "\n";
    const newBlock =
      smallerBlocks.length === 0
        ? createSectionBlock(line)
        : createSectionBlock(smallerBlocks[smallerBlocks.length - 1].text.text + line);
    if (JSON.stringify(newBlock).length + line.length > SLACK_MAX_CHAR_LIMIT) {
      smallerBlocks.push(createSectionBlock(line));
    } else {
      if (smallerBlocks.length === 0) smallerBlocks.push(createSectionBlock(""));
      smallerBlocks[smallerBlocks.length - 1].text.text += line;
    }
  }
  return smallerBlocks;
}

function createSectionBlock(text: string): SectionBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text },
  };
}

export function createSlackTransport(transportConfig: Options["transportConfig"]): SlackHook {
  return new SlackHook({
    level: "info",
    transportConfig,
    formatter: (info) => {
      return slackFormatter(info);
    },
  });
}
