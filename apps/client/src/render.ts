import { drawEntity } from "@tcg/game-template";
import type { SnapMessage } from "@tcg/shared";

export function render(ctx: CanvasRenderingContext2D, snap: SnapMessage): void {
  ctx.clearRect(0, 0, 800, 600);
  for (const e of Object.values(snap.entities ?? {})) drawEntity(ctx, e);
}
