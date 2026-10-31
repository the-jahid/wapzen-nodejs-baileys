import { SystemMessage, ToolMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, createAgent, createMiddleware } from 'langchain';
import { DEFAULT_MODEL } from '../chat-agents/chat-agents.types';
import type { ChatToolbox } from '../tools/chat-toolbox';

const REPLY_MAX_TOKENS = 500;
// How many times one reply may call tools. The last round is asked for text
// only, so a model that keeps calling tools still ends up answering.
const MAX_TOOL_ROUNDS = 3;

// What one reply brings to the agent, which itself is shared by every chat.
export type ReplyContext = {
  prompt: string;
  // Null when the chat agent has no tools.
  toolbox: ChatToolbox | null;
};

// Tools differ per chat agent, so none are registered up front: each model
// call gets the ones this reply's agent has. With no toolbox the request goes
// out with no tools and no tool_choice, so the model is never offered any.
const chatAgentTools = createMiddleware({
  name: 'ChatAgentTools',
  wrapModelCall: (request, handler) => {
    const { prompt, toolbox } = request.runtime.context as ReplyContext;
    const systemMessage = new SystemMessage(prompt);
    if (!toolbox) return handler({ ...request, systemMessage, tools: [] });

    const finished = request.messages.filter(
      (m) => AIMessage.isInstance(m) && m.tool_calls?.length,
    ).length;
    return handler({
      ...request,
      systemMessage,
      tools: toolbox.definitions(),
      toolChoice: finished + 1 >= MAX_TOOL_ROUNDS ? 'none' : 'auto',
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

export function createReplyAgent(apiKey: string) {
  return createAgent({
    // Every chat agent answers with the same model, whatever the row says. It
    // refuses any temperature but its default, so agent.temperature isn't
    // sent. Minimal effort means no reasoning; it can't be switched off, and
    // leaving it out means the default effort, which can spend every token on
    // reasoning and answer with no text.
    model: new ChatOpenAI({
      model: DEFAULT_MODEL,
      apiKey,
      maxTokens: REPLY_MAX_TOKENS,
      maxRetries: 2,
      reasoning: { effort: 'minimal' },
    }),
    middleware: [chatAgentTools],
  });
}
