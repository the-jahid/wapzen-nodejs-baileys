import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chatModel } from '../whatsapp/reply-agent';
import {
  optionCount,
  systemPrompt,
  userContent,
  type FreeToolInput,
} from './free-tools-prompts';

const OUTPUT_TOOL = 'whatsapp_messages';

// Public and free, so both limits are what keeps the bill bounded. Counts
// live in memory: a restart forgets them, which only ever errs generous.
const PER_VISITOR_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_DAILY_CAP = 3000;

export type Option = { label: string; text: string };

export class FreeToolLimitError extends Error {}

@Injectable()
export class FreeToolsService {
  private readonly logger = new Logger(FreeToolsService.name);
  private readonly visitors = new Map<string, number[]>();
  private day = '';
  private dayCount = 0;

  constructor(private readonly config: ConfigService) {}

  /** Counts one generation, or throws FreeToolLimitError when over a limit. */
  private take(visitor: string, now = Date.now()) {
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.dayCount = 0;
      this.visitors.clear();
    }
    const cap =
      Number(this.config.get<string>('FREE_TOOLS_DAILY_CAP')) ||
      DEFAULT_DAILY_CAP;
    if (this.dayCount >= cap) {
      throw new FreeToolLimitError(
        'The free AI tools are busy today. Please try again tomorrow.',
      );
    }
    const recent = (this.visitors.get(visitor) ?? []).filter(
      (at) => now - at < HOUR_MS,
    );
    if (recent.length >= PER_VISITOR_PER_HOUR) {
      const waitMin = Math.ceil((recent[0] + HOUR_MS - now) / 60_000);
      throw new FreeToolLimitError(
        `You've used the free AI tools ${PER_VISITOR_PER_HOUR} times this hour. Please try again in ${waitMin} minute${waitMin === 1 ? '' : 's'}.`,
      );
    }
    recent.push(now);
    this.visitors.set(visitor, recent);
    this.dayCount += 1;
  }

  async generate(visitor: string, input: FreeToolInput): Promise<Option[]> {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    this.take(visitor);

    const count = optionCount(input);
    const model = chatModel(apiKey, 2500).bindTools(
      [
        {
          type: 'function',
          function: {
            name: OUTPUT_TOOL,
            description: `Return the ${count} WhatsApp message options.`,
            parameters: {
              type: 'object',
              properties: {
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string' },
                      text: { type: 'string' },
                    },
                    required: ['label', 'text'],
                  },
                },
              },
              required: ['options'],
            },
          },
        },
      ],
      { tool_choice: OUTPUT_TOOL },
    );
    const started = Date.now();
    const reply = await model.invoke([
      new SystemMessage(systemPrompt(input)),
      new HumanMessage(userContent(input)),
    ]);
    const args = reply.tool_calls?.find((call) => call.name === OUTPUT_TOOL)
      ?.args as { options?: unknown } | undefined;
    const options = (Array.isArray(args?.options) ? args.options : [])
      .map((o: unknown) => {
        const item = (o ?? {}) as { label?: unknown; text?: unknown };
        return {
          label:
            typeof item.label === 'string'
              ? item.label.trim().slice(0, 60)
              : '',
          // Markdown bold slips through now and then; WhatsApp wants one star.
          text:
            typeof item.text === 'string'
              ? item.text
                  .trim()
                  .replace(/\*\*(.+?)\*\*/g, '*$1*')
                  .slice(0, 2000)
              : '',
        };
      })
      .filter((o) => o.text)
      .slice(0, count);
    if (!options.length) throw new Error('AI returned no messages');
    this.logger.log(
      `free tool ${input.tool}${input.tool === 'business' ? `/${input.kind}` : ''}: ${options.length} options in ${Date.now() - started} ms (${this.dayCount} today)`,
    );
    return options;
  }
}
