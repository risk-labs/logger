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

import { AsyncLogQueue } from "./AsyncLogQueue";
import { TransportError } from "./TransportError";

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

// Timeout applied to every webhook post. Without it a single hung socket holds a request open forever, parking the
// queue behind it until it fills up and starts shedding messages.
export const SLACK_REQUEST_TIMEOUT_MS = 10_000;

// Slack incoming webhooks drain at roughly one message per second, so the queue has to absorb bursts. This bounds the
// memory held by a flood: beyond this many pending messages the oldest are dropped and reported in a summary message.
export const SLACK_MAX_QUEUE_SIZE = 1000;

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

type SlackPayload = { blocks?: Block[]; text?: string; mrkdwn?: boolean };

interface QueueElement {
  webhookUrl: string;
  payload: SlackPayload;
  info: any; // Retained only so that a failed delivery can be reported with the log entry that produced it.
}

// Slack returns 429 with a `Retry-After` header (in seconds) when a webhook is posted to faster than it drains.
// Everything else is a genuine delivery failure and is reported rather than retried.
function slackRetryDelaySeconds(error: unknown): number | undefined {
  if (!axios.isAxiosError(error) || error.response?.status !== 429) return undefined;
  const retryAfter = Number(error.response.headers?.["retry-after"]);
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1;
}

type TransportOptions = NonNullable<ConstructorParameters<typeof Transport>[0]>;
interface Options extends TransportOptions {
  name?: string;
  transportConfig: {
    escalationPathWebhookUrls?: { [key: string]: string };
    defaultWebHookUrl: string;
  };
  formatter: (info: any) => SlackFormatterResponse;
  mrkdwn?: boolean;
  proxy?: AxiosRequestConfig["proxy"];
  maxQueueSize?: number;
}

class SlackHook extends Transport {
  private name: string;
  private readonly escalationPathWebhookUrls: { [key: string]: string };
  private readonly defaultWebHookUrl: string;
  private readonly formatter: (info: any) => SlackFormatterResponse;
  private readonly mrkdwn: boolean;
  private readonly axiosInstance: AxiosInstance;
  private readonly maxQueueSize: number;
  private readonly logQueue: AsyncLogQueue<QueueElement>;

  constructor(opts: Options) {
    super(opts);
    this.name = opts.name || "slackWebhook";
    this.level = opts.level || undefined;
    this.escalationPathWebhookUrls = opts.transportConfig.escalationPathWebhookUrls || {};
    this.defaultWebHookUrl = opts.transportConfig.defaultWebHookUrl;
    this.formatter = opts.formatter;
    this.mrkdwn = opts.mrkdwn || false;
    this.axiosInstance = axios.create({
      proxy: opts.proxy,
      timeout: SLACK_REQUEST_TIMEOUT_MS,
      validateStatus: (status) => {
        return status == 200;
      },
    });
    this.maxQueueSize = opts.maxQueueSize ?? SLACK_MAX_QUEUE_SIZE;
    this.logQueue = new AsyncLogQueue<QueueElement>({
      maxQueueSize: this.maxQueueSize,
      deliver: async ({ webhookUrl, payload }) => {
        await this.axiosInstance.post(webhookUrl, payload);
      },
      onError: (error, { info }) => {
        // The winston callback has long since fired, so surface this on the transport instead. winston forwards it to
        // the logger's error event, where the existing transportErrorLogger plumbing picks it up.
        this.emit("error", new TransportError("Slack", error, info));
      },
      onDropped: (droppedCount) => this.reportDroppedMessages(droppedCount),
      retryDelaySeconds: slackRetryDelaySeconds,
    });
  }

  // Getter for checking if the transport is flushed. Used by waitForLogger to block termination until the queue drains.
  get isFlushed(): boolean {
    return this.logQueue.isFlushed;
  }

  // Note: info must be any because that's what the base class uses.
  log(info: any, callback: (error?: unknown) => void): void {
    try {
      // If the log contains a notification path then use a custom slack webhook service. This lets the transport route to
      // different slack channels depending on the context of the log.
      const webhookUrl = this.escalationPathWebhookUrls[info.notificationPath] ?? this.defaultWebHookUrl;

      // Formatting is cheap and synchronous; only delivery is queued. Anything that throws here is a bug in the
      // formatter and is reported to winston directly, as it would have been before the queue existed.
      for (const payload of this.buildPayloads(info)) this.logQueue.enqueue({ webhookUrl, payload, info });
    } catch (error) {
      return callback(new TransportError("Slack", error, info));
    }

    // Acknowledge the write immediately: delivery happens in the background so that a slow or unresponsive webhook can
    // never apply backpressure to the winston pipeline and stall every other transport.
    callback();
  }

  // Turns one log entry into the payloads to post. Slack rejects messages over the character limit, so oversized
  // entries are split into several messages, each with its own payload object.
  private buildPayloads(info: any): SlackPayload[] {
    const blocks: Block[] | undefined = this.formatter(info).blocks || undefined;
    const payload: SlackPayload = { mrkdwn: this.mrkdwn, blocks };

    // If the overall payload is less than 3000 chars then we can send it all in one go to the slack API.
    if (blocks === undefined || JSON.stringify(payload).length < SLACK_MAX_CHAR_LIMIT) return [payload];

    // Otherwise split it into one payload per message. Each gets its own object: they are queued, not posted
    // immediately, so they cannot share (and overwrite) a single payload.
    return processMessageBlocks(blocks).map((processedBlock) => ({ mrkdwn: this.mrkdwn, blocks: processedBlock }));
  }

  // Posts a single summary in place of the messages shed during a flood, so that a gap in the channel is never silent.
  // Drops are counted across all webhooks but reported on the default one, since that is the channel that is watched.
  private reportDroppedMessages(droppedCount: number): void {
    const text =
      `[warn] *SlackTransport*⭢Dropped ${droppedCount} log message(s) after exceeding the queue limit of ` +
      `${this.maxQueueSize}. The dropped logs are still available in the console and GCP logs.\n`;
    this.logQueue.enqueue({
      webhookUrl: this.defaultWebHookUrl,
      payload: { mrkdwn: this.mrkdwn, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] },
      info: { at: "SlackTransport", message: "Dropped log messages", droppedCount },
    });
  }
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
