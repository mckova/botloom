import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";

interface Ask {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  resolve: (ok: boolean) => void;
}

/**
 * Destructive-action dialog on the native <dialog> element: focus is trapped, Escape cancels and
 * focus returns to the trigger without any custom keyboard code.
 */
export function useConfirm() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const confirm = useCallback(
    (title: string, opts: { body?: ReactNode; confirmLabel?: string } = {}) => new Promise<boolean>((resolve) => setAsk({ title, ...opts, resolve })),
    [],
  );
  const dialog = ask ? <ConfirmDialog ask={ask} onDone={() => setAsk(null)} /> : null;
  return { confirm, dialog };
}

function ConfirmDialog({ ask, onDone }: { ask: Ask; onDone: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const close = (ok: boolean) => {
    ask.resolve(ok);
    ref.current?.close();
    onDone();
  };
  return (
    <dialog ref={ref} className="confirm" aria-labelledby="confirm-title" onCancel={() => close(false)}>
      <h2 id="confirm-title">{ask.title}</h2>
      {ask.body && <p className="muted">{ask.body}</p>}
      <div className="row">
        <button autoFocus onClick={() => close(false)}>
          Cancel
        </button>
        <button className="danger solid" onClick={() => close(true)}>
          {ask.confirmLabel ?? "Delete"}
        </button>
      </div>
    </dialog>
  );
}
