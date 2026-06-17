import { useCallback, useEffect, useRef, useState } from "react";
import { api, NotImplementedError } from "../lib/api";

/** One pending/complete image attachment tracked by the hook. */
export interface PendingAttachment {
  /** Stable client id for keys + removal. */
  id: string;
  /** Original (or generated) filename, shown under the thumbnail. */
  filename: string;
  /** MIME type, e.g. "image/png". */
  mediaType: string;
  /** Object-URL for the local thumbnail preview (revoked on removal/unmount). */
  previewUrl: string;
  /** Upload lifecycle: in-flight, done (has `path`), or failed. */
  status: "uploading" | "done" | "error";
  /** The server-returned on-disk path, once the upload completes. */
  path?: string;
  /** A short failure reason when `status` is "error". */
  error?: string;
}

export interface UseImageAttachOptions {
  /**
   * Insert the uploaded file's path into the composer as an `@`-reference (with a
   * trailing space) so the CLI reads the file. Called once per image, the moment
   * its upload completes — so the reference appears as soon as the path exists.
   */
  onInsertPath: (path: string) => void;
}

export interface UseImageAttachResult {
  /** Pending/complete attachments, for rendering thumbnails. */
  attachments: PendingAttachment[];
  /** Remove one pending attachment (does not delete the server file). */
  remove: (id: string) => void;
  /** Clear all pending attachments (e.g. after the prompt is sent). */
  clear: () => void;
  /** Paste handler for the composer textarea — extracts image clipboard items. */
  onPaste: (e: React.ClipboardEvent) => void;
  /** Drop handler for the composer — extracts dropped image files. */
  onDrop: (e: React.DragEvent) => void;
  /** dragover handler — must preventDefault so the drop fires. */
  onDragOver: (e: React.DragEvent) => void;
  /** True while at least one upload is in flight (lets the host show a hint). */
  uploading: boolean;
  /**
   * Set when the server doesn't implement POST /api/attachments (404/501). Lets
   * the composer show a one-line "image upload isn't available here" notice
   * instead of silently dropping the paste/drop. Cleared on the next successful op.
   */
  unsupported: boolean;
}

/** Read a File as raw base64 (strips the `data:...;base64,` prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const res = reader.result;
      if (typeof res !== "string") return reject(new Error("unexpected read result"));
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.readAsDataURL(file);
  });
}

let attachSeq = 0;

/**
 * Composer image attachments: paste (Ctrl/Cmd+V) or drag-drop an image onto the
 * ChatPane composer, upload it via POST /api/attachments, and insert the returned
 * on-disk path into the prompt as an `@`-reference (the CLI reads the file). The
 * hook also tracks pending uploads with local thumbnail previews so the user sees
 * them immediately while the upload runs.
 *
 * Plain words: you paste a screenshot into the chat box; this shows a little
 * preview right away, quietly uploads it, and drops "@<path-to-the-image>" into
 * your message so Claude's CLI can open it.
 *
 * Degrades gracefully: if the server hasn't shipped the attachments route yet, it
 * flags `unsupported` (so the composer can say so) instead of throwing.
 */
export function useImageAttach({ onInsertPath }: UseImageAttachOptions): UseImageAttachResult {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [unsupported, setUnsupported] = useState(false);

  // Keep the latest insert callback in a ref so the stable paste/drop handlers
  // always read the current value without re-subscribing listeners.
  const insertRef = useRef(onInsertPath);
  insertRef.current = onInsertPath;

  // Track object-URLs so we can revoke them (avoid leaking blobs) on unmount.
  const urlsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const urls = urlsRef.current;
    return () => {
      for (const u of urls) URL.revokeObjectURL(u);
      urls.clear();
    };
  }, []);

  const remove = useCallback((id: string) => {
    setAttachments((list) => {
      const found = list.find((a) => a.id === id);
      if (found) {
        URL.revokeObjectURL(found.previewUrl);
        urlsRef.current.delete(found.previewUrl);
      }
      return list.filter((a) => a.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setAttachments((list) => {
      for (const a of list) {
        URL.revokeObjectURL(a.previewUrl);
        urlsRef.current.delete(a.previewUrl);
      }
      return [];
    });
  }, []);

  // Upload one image file: add a pending row with a thumbnail, POST it, then mark
  // done (+ insert its path) or error. Errors are kept on the row (not thrown) so
  // one bad paste doesn't break the composer.
  const uploadFile = useCallback((file: File) => {
    const id = `att-${++attachSeq}`;
    const previewUrl = URL.createObjectURL(file);
    urlsRef.current.add(previewUrl);
    const filename = file.name || `pasted-image-${id}.${(file.type.split("/")[1] || "png")}`;

    setAttachments((list) => [
      ...list,
      { id, filename, mediaType: file.type || "image/png", previewUrl, status: "uploading" },
    ]);

    void (async () => {
      try {
        const dataBase64 = await fileToBase64(file);
        const res = await api.uploadAttachment({ filename, dataBase64 });
        setUnsupported(false);
        setAttachments((list) =>
          list.map((a) => (a.id === id ? { ...a, status: "done", path: res.path } : a)),
        );
        // Insert the @-reference as soon as the path exists.
        if (res.path) insertRef.current(res.path);
      } catch (err) {
        const isUnsupported = err instanceof NotImplementedError;
        if (isUnsupported) setUnsupported(true);
        setAttachments((list) =>
          list.map((a) =>
            a.id === id
              ? {
                  ...a,
                  status: "error",
                  error: isUnsupported ? "Image upload isn't available on this server yet." : "Upload failed.",
                }
              : a,
          ),
        );
      }
    })();
  }, []);

  // Pull image files out of a clipboard or drag DataTransfer. Non-images are
  // ignored so pasting text still falls through to the textarea's own handling.
  const imagesFromItems = useCallback((items: DataTransferItemList | null): File[] => {
    if (!items) return [];
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    return files;
  }, []);

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = imagesFromItems(e.clipboardData?.items ?? null);
      if (files.length === 0) return; // let normal text paste happen
      e.preventDefault();
      for (const f of files) uploadFile(f);
    },
    [imagesFromItems, uploadFile],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const dt = e.dataTransfer;
      // Prefer the typed items list; fall back to `files` for older paths.
      let files = imagesFromItems(dt?.items ?? null);
      if (files.length === 0 && dt?.files) {
        files = Array.from(dt.files).filter((f) => f.type.startsWith("image/"));
      }
      if (files.length === 0) return;
      e.preventDefault();
      for (const f of files) uploadFile(f);
    },
    [imagesFromItems, uploadFile],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    // Only intercept when an image is being dragged, so text drag-drop is normal.
    const types = e.dataTransfer?.types;
    if (types && Array.from(types).includes("Files")) e.preventDefault();
  }, []);

  const uploading = attachments.some((a) => a.status === "uploading");

  return { attachments, remove, clear, onPaste, onDrop, onDragOver, uploading, unsupported };
}
