import type { GroupMetadata, proto } from 'baileys';

// What the AI needs to know about WhatsApp groups. No Baileys code here, only
// its types, so this can be tested on its own.

// What the dashboard lists for one group. ai_enabled comes from ai_groups.
export type GroupSummary = {
  jid: string;
  name: string;
  member_count: number;
  // False in an admins-only group when this number isn't an admin: a reply
  // would be refused, so the AI can't be switched on there.
  can_send: boolean;
};

export function isGroupJid(jid: string) {
  return jid.endsWith('@g.us');
}

// A JID without its device, in the one spelling this file compares.
function bare(jid: string) {
  return jid.replace(/:\d+(?=@)/, '').replace('@c.us', '@s.whatsapp.net');
}

function isOwn(jid: string | null | undefined, own: string[]) {
  return !!jid && own.includes(bare(jid));
}

export function toGroupSummary(
  group: GroupMetadata,
  own: string[],
): GroupSummary {
  return {
    jid: group.id,
    name: group.subject?.trim() || 'Unnamed group',
    member_count: group.size ?? group.participants.length,
    can_send:
      !group.announce ||
      group.participants.some(
        (member) =>
          !!member.admin &&
          [member.id, member.lid, member.phoneNumber].some((jid) =>
            isOwn(jid, own),
          ),
      ),
  };
}

// The tags and quoted message of a message, whichever kind it is: each kind
// (text, photo, voice message...) carries its own contextInfo.
export function contextInfoOf(
  content: proto.IMessage | null | undefined,
): proto.IContextInfo | undefined {
  for (const part of Object.values(content ?? {})) {
    const info = (part as { contextInfo?: proto.IContextInfo } | null)
      ?.contextInfo;
    if (info) return info;
  }
  return undefined;
}

// Whether a group message is for this number: it tags the number or replies to
// one of its messages. WhatsApp tags and quotes people by either their "@lid"
// or their number, so own holds both.
export function isAddressed(
  info: proto.IContextInfo | undefined,
  own: string[],
) {
  if (!info) return false;
  return (
    isOwn(info.participant, own) ||
    !!info.mentionedJid?.some((jid) => isOwn(jid, own))
  );
}

// The quoted message's author, if it's someone other than this number. The AI
// already remembers what it said itself.
export function quotesSomeoneElse(
  info: proto.IContextInfo | undefined,
  own: string[],
) {
  return !!info?.quotedMessage && !isOwn(info.participant, own);
}

// The message without the "@8801712345678" a tag leaves in its text. A bare tag
// keeps it, so there's still something to answer.
export function withoutTag(text: string, own: string[]) {
  let stripped = text;
  for (const jid of own) {
    const user = jid.split('@')[0];
    stripped = stripped.replace(new RegExp(`@${user}\\b`, 'g'), '');
  }
  return stripped.replace(/[ \t]{2,}/g, ' ').trim() || text;
}
