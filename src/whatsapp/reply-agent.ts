import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, createAgent, createMiddleware } from 'langchain';
import { DEFAULT_MODEL } from '../chat-agents/chat-agents.types';
import type { ChatToolbox } from '../tools/chat-toolbox';

const REPLY_MAX_TOKENS = 500;
// How many times one reply may call tools. The last round is asked for text
// only, so a model that keeps calling tools still ends up answering.
const MAX_TOOL_ROUNDS = 3;
// The answer to the yes-or-no question below is one short function call.
const CONFIRMATION_MAX_TOKENS = 60;
// How much of the chat that question is asked about.
const CONFIRMATION_TURNS = 6;

const CONFIRMATION_FUNCTION = 'order_decision';
const CONFIRMATION_PROMPT = [
  "You read a WhatsApp chat between a business's assistant and a customer. Set confirmed to true only if all of these hold:",
  "1. The assistant's last message sets out the whole order and asks whether to place it.",
  '2. Nothing the order needs is missing: what they want, their name, and whatever the business asks for below.',
  "3. The customer's last message is a plain yes to that, in any language.",
  'Customer messages that are a yes: "yes", "ok", "correct, place it", "go ahead", "হ্যাঁ", "ঠিক আছে", "জি".',
  'Customer messages that are not a yes, so confirmed is false: "Ayesha Rahman", "House 5, Road 3, Banani", "no", "no wait, make it one pepperoni instead", "add garlic bread", "how much is it?".',
  "If the assistant's last message gave an order number, that order is done, so confirmed is false.",
].join('\n');

// What one reply brings to the agent, which itself is shared by every chat.
export type ReplyContext = {
  prompt: string;
  // Null when the chat agent has no tools.
  toolbox: ChatToolbox | null;
  // A function the first model call must make, when the reply already knows
  // what has to happen.
  requiredTool?: string;
};

// Tools differ per chat agent, so none are registered up front: each model
// call gets the ones this reply's agent has. With no toolbox the request goes
// out with no tools and no tool_choice, so the model is never offered any.
const chatAgentTools = createMiddleware({
  name: 'ChatAgentTools',
  wrapModelCall: (request, handler) => {
    const { prompt, toolbox, requiredTool } = request.runtime
      .context as ReplyContext;
    const systemMessage = new SystemMessage(prompt);
    if (!toolbox) return handler({ ...request, systemMessage, tools: [] });

    const finished = request.messages.filter(
      (m) => AIMessage.isInstance(m) && m.tool_calls?.length,
    ).length;
    const choice =
      requiredTool && finished === 0
        ? { type: 'function' as const, function: { name: requiredTool } }
        : 'auto';
    return handler({
      ...request,
      systemMessage,
      tools: toolbox.definitions(),
      toolChoice: finished + 1 >= MAX_TOOL_ROUNDS ? 'none' : choice,
    });
  },
  wrapToolCall: async (request) => {
    const { toolbox } = request.runtime.context as ReplyContext;
    const { id, name, args } = request.toolCall;
    return new ToolMessage({
      tool_call_id: id ?? '',
      name,
      content: await toolbox!.run(name, args),
    });
  },
});

// Every chat agent answers with the same model, whatever the row says. It
// refuses any temperature but its default, so agent.temperature isn't sent.
// Minimal effort means no reasoning; it can't be switched off, and leaving it
// out means the default effort, which can spend every token on reasoning and
// answer with no text.
function chatModel(apiKey: string, maxTokens: number) {
  return new ChatOpenAI({
    model: DEFAULT_MODEL,
    apiKey,
    maxTokens,
    maxRetries: 2,
    reasoning: { effort: 'minimal' },
  });
}

export function createReplyAgent(apiKey: string) {
  return createAgent({
    model: chatModel(apiKey, REPLY_MAX_TOKENS),
    middleware: [chatAgentTools],
  });
}

// Whether the customer's last message agrees to the order the agent set out.
// At minimal effort the model often asks for confirmation again instead of
// placing the order, or places it too early (in a live test it placed 11 in 30,
// 7 in 30 in Bangla, and sometimes said it had), so the reply doesn't leave that
// to it: this one narrow question is forced, and only a yes lets an order be
// placed, by making the call required.
export function createConfirmationCheck(apiKey: string) {
  const model = chatModel(apiKey, CONFIRMATION_MAX_TOKENS).bindTools(
    [
      {
        type: 'function',
        function: {
          name: CONFIRMATION_FUNCTION,
          description: 'Records whether the customer confirmed the order.',
          parameters: {
            type: 'object',
            properties: { confirmed: { type: 'boolean' } },
            required: ['confirmed'],
          },
        },
      },
    ],
    {
      tool_choice: {
        type: 'function',
        function: { name: CONFIRMATION_FUNCTION },
      },
    },
  );

  return async (
    turns: { role: 'user' | 'assistant'; text: string }[],
    text: string,
    instructions: string,
  ) => {
    const chat = [...turns.slice(-CONFIRMATION_TURNS)]
      .map((t) => `${t.role === 'user' ? 'Customer' : 'Assistant'}: ${t.text}`)
      .concat(`Customer: ${text}`)
      .join('\n');
    const business = instructions.trim();
    const reply = await model.invoke([
      new SystemMessage(
        business
          ? `${CONFIRMATION_PROMPT}\n\nThe business's order instructions:\n${business}`
          : CONFIRMATION_PROMPT,
      ),
      new HumanMessage(chat),
    ]);
    return reply.tool_calls?.[0]?.args?.confirmed === true;
  };
}
