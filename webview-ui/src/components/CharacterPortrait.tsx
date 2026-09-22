import { useEffect, useRef } from 'react';

import { getCachedSprite } from '../office/sprites/spriteCache.js';
import { getCharacterSprites, getLoadedCharacterCount } from '../office/sprites/spriteData.js';
import { Direction } from '../office/types.js';

/** A character's standing (or typing) frame, facing down — for pickers and team cards. */
export function CharacterPortrait({
  palette,
  zoom = 2,
  typing = false,
  title,
}: {
  palette: number;
  zoom?: number;
  typing?: boolean;
  title?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || getLoadedCharacterCount() === 0) return;
    const sprites = getCharacterSprites(palette);
    const frame = typing ? sprites.typing[Direction.DOWN][0] : sprites.walk[Direction.DOWN][0];
    const source = getCachedSprite(frame, zoom);
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0);
  }, [palette, zoom, typing]);
  return <canvas ref={ref} title={title} className="block [image-rendering:pixelated]" />;
}
