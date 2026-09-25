import { useEffect, useState } from 'react';

import type { ChatEntry } from '../../../core/src/messages.js';
import { CHARACTER_SITTING_OFFSET_PX, CHAT_PEEK_VERTICAL_OFFSET } from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { overlayProjection } from '../office/projection.js';
import { CharacterState } from '../office/types.js';
import { chatPreview } from '../officeChat.js';

interface ChatPeekBubblesProps {
  officeState: OfficeState;
  agents: number[];
  chats: Record<number, ChatEntry[]>;
  unread: Record<number, boolean>;
  openAgentId: number | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onOpen: (agentId: number) => void;
}

/**
 * One-line previews of an agent's newest reply, floating above characters
 * whose chat has something unread. Clicking one opens that chat.
 */
export function ChatPeekBubbles({
  officeState,
  agents,
  chats,
  unread,
  openAgentId,
  containerRef,
  zoom,
  panRef,
  onOpen,
}: ChatPeekBubblesProps) {
  const [, setTick] = useState(0);
  const anyUnread = agents.some((id) => unread[id] && id !== openAgentId);
  useEffect(() => {
    if (!anyUnread) return;
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [anyUnread]);

  const el = containerRef.current;
  if (!el || !anyUnread) return null;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );

  return (
    <>
      {agents.map((id) => {
        if (!unread[id] || id === openAgentId) return null;
        // Hovered or selected characters show their status panel in this spot.
        if (officeState.hoveredAgentId === id || officeState.selectedAgentId === id) return null;
        const ch = officeState.characters.get(id);
        const preview = chatPreview(chats[id]);
        if (!ch || !preview) return null;
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        const at = project.toScreen(ch.x, ch.y, CHAT_PEEK_VERTICAL_OFFSET - sittingOffset);
        return (
          <button
            key={id}
            onClick={() => onOpen(id)}
            className="absolute z-40 -translate-x-1/2 -translate-y-full max-w-2xs px-6 py-2 font-reading text-read-sm text-left bg-board text-board-ink border border-board-ink rounded-ui shadow-pixel cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap"
            style={{
              left: at.x,
              top: at.y,
            }}
            title="Open chat"
            data-testid="chat-peek"
            data-agent-id={id}
          >
            {preview}
          </button>
        );
      })}
    </>
  );
}
