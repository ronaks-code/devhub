import { useState } from "react";
import { ImageOff, X } from "lucide-react";
import { assetUrl } from "../lib/api";

/**
 * An image content block, widened beyond the engine's `{type:"image",mediaType?}`
 * shape. The engine type (which we can't edit, and won't shim with a .d.ts) does
 * not yet carry the bytes or a path, so we read them defensively here:
 *
 *  - `data`      → raw base64 (no data-URL prefix), shown via a data URL.
 *  - `assetPath` → an on-disk path, loaded through GET /api/assets?path= .
 *  - `url`       → an already-usable URL (e.g. a remote/data URL), used as-is.
 *
 * Any of these may be absent; when none yield a renderable source we fall back
 * to the small stub MessageView used to show inline.
 */
export interface ImageBlockData {
  type: "image";
  mediaType?: string;
  /** Raw base64 (no `data:...;base64,` prefix). */
  data?: string;
  /** On-disk path, served via /api/assets (allowlisted server-side). */
  assetPath?: string;
  /** A ready-to-use src (remote URL or full data URL). */
  url?: string;
}

/** Resolve a usable <img src> from whatever the block carries, or null. */
function resolveSrc(block: ImageBlockData): string | null {
  // A full data URL or remote URL is usable as-is.
  if (typeof block.url === "string" && block.url) return block.url;
  // Raw base64 → wrap in a data URL (default to PNG when mediaType is absent).
  if (typeof block.data === "string" && block.data) {
    const media = block.mediaType || "image/png";
    // Guard against a value that's accidentally already a data URL.
    return block.data.startsWith("data:") ? block.data : `data:${media};base64,${block.data}`;
  }
  // On-disk path → let the browser fetch it from the assets route.
  if (typeof block.assetPath === "string" && block.assetPath) return assetUrl(block.assetPath);
  return null;
}

/** The compact inline stub used when there's nothing renderable to show. */
function Stub({ mediaType }: { mediaType?: string }) {
  return (
    <div className="my-1 inline-flex items-center gap-1.5 rounded-md bg-zinc-900/50 px-2 py-1 text-xs text-zinc-500 ring-1 ring-zinc-800">
      <ImageOff className="h-3.5 w-3.5" />
      image{mediaType ? ` (${mediaType})` : ""}
    </div>
  );
}

/**
 * Render an image content block inline: a bounded thumbnail that opens a
 * full-size lightbox on click. Falls back to {@link Stub} when the block has no
 * renderable source, or when the image fails to load (broken path / revoked
 * asset) — so a missing image never breaks the transcript.
 */
export function ImageBlock({ block }: { block: ImageBlockData }) {
  const [open, setOpen] = useState(false);
  // Flips to true if the <img> errors (bad path, 404 from /api/assets, etc.),
  // collapsing back to the stub instead of a broken-image glyph.
  const [failed, setFailed] = useState(false);

  const src = resolveSrc(block);
  if (!src || failed) return <Stub mediaType={block.mediaType} />;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Click to enlarge"
        className="my-1 block overflow-hidden rounded-lg ring-1 ring-zinc-800 transition hover:ring-clay-500/40 focus:outline-none focus:ring-2 focus:ring-clay-500/50"
      >
        <img
          src={src}
          alt={block.mediaType ? `image (${block.mediaType})` : "image"}
          onError={() => setFailed(true)}
          className="max-h-64 max-w-full object-contain"
          loading="lazy"
        />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm"
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            title="Close"
            className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full bg-zinc-900/80 text-zinc-300 ring-1 ring-zinc-700 transition hover:bg-zinc-800 hover:text-zinc-100"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={src}
            alt={block.mediaType ? `image (${block.mediaType})` : "image"}
            // Stop propagation so clicking the image itself doesn't close the
            // lightbox (only the backdrop / close button do).
            onClick={(e) => e.stopPropagation()}
            onError={() => {
              setFailed(true);
              setOpen(false);
            }}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
          />
        </div>
      ) : null}
    </>
  );
}
