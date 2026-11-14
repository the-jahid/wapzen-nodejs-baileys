import { LoopGuard, normalize } from './loop-guard';

const K = 'phone|peer@lid';

// Plays a conversation: each message arrives `gapMs` after the agent's last
// reply, and the agent answers 2 s later. Returns the first trip, if any.
function play(guard: LoopGuard, texts: string[], gapMs: number, start = 0) {
  let now = start;
  for (const [i, text] of texts.entries()) {
    now += gapMs;
    const tripped = guard.incoming(K, text, now);
    if (tripped) return { tripped, at: i };
    now += 2_000;
    guard.replied(K, `reply ${text}`, now);
  }
  return undefined;
}

describe('LoopGuard', () => {
  it('stops two bots trading the same emoji', () => {
    const guard = new LoopGuard();
    const r = play(guard, Array<string>(20).fill('😊'), 3_000);
    expect(r).toEqual({ tripped: 'echo', at: 6 });
  });

  it('stops a bot that repeats back what the agent said', () => {
    const guard = new LoopGuard();
    let now = 0;
    let tripped;
    for (let i = 0; i < 20 && !tripped; i++) {
      now += 3_000;
      tripped = guard.incoming(K, `Sure, happy to help ${i % 5}!`, now);
      now += 2_000;
      guard.replied(K, `sure happy to help ${(i + 1) % 5}`, now);
    }
    expect(tripped).toBe('echo');
  });

  it('leaves a fast human with different questions alone', () => {
    const guard = new LoopGuard();
    const texts = [
      'hi',
      'price of the blue watch?',
      'do you deliver to Dhaka',
      'how long',
      'cash on delivery?',
      'ok send the red one too',
      'my address is road 5',
      'thanks',
    ];
    expect(play(guard, texts, 5_000)).toBeUndefined();
  });

  it('leaves a slow person who keeps saying ok alone', () => {
    const guard = new LoopGuard();
    expect(play(guard, Array<string>(10).fill('ok'), 60_000)).toBeUndefined();
  });

  it('stops a flood of replies to one chat whatever is said', () => {
    const guard = new LoopGuard();
    const texts = Array.from({ length: 40 }, (_, i) => `question number ${i}`);
    const r = play(guard, texts, 15_000);
    expect(r?.tripped).toBe('flood');
    expect(r?.at).toBe(30);
  });

  it('starts over after tripping and keeps chats apart', () => {
    const guard = new LoopGuard();
    expect(play(guard, Array<string>(7).fill('😊'), 3_000)?.tripped).toBe(
      'echo',
    );
    // Fresh slate: one more emoji doesn't trip again at once.
    expect(guard.incoming(K, '😊', 100_000)).toBeUndefined();
    expect(guard.incoming('other|chat', '😊', 100_000)).toBeUndefined();
  });

  it('normalizes case, spaces and punctuation', () => {
    expect(normalize('Thanks!! ')).toBe(normalize('thanks'));
    expect(normalize('😊')).toBe('😊');
  });
});
