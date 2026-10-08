import { SpanStatusCode, context, trace, type Span, type Tracer } from "@opentelemetry/api";
import { pick, safely } from "./safe.js";

/**
 * Traces follow one edit through the gateway: a root span `omnisync.edit` with `verify`, `append` and `fanout` children,
 * and a separate root `omnisync.checkpoint`. Attributes pass an allowlist, so nothing about a document, key, person or
 * payload can reach a span however a caller is written.
 */
const OUTCOMES = [
  "ok",
  "duplicate",
  "replay",
  "engine_rejected",
  "bad_signature",
  "unknown_key",
  "malformed",
  "not_update",
  "forbidden",
  "claimed_time",
  "rate_limited",
  "unavailable",
  "internal",
  "conflict",
] as const;
const STAGES = ["verify", "append", "fanout"] as const;
export type Stage = (typeof STAGES)[number];

export interface EditTrace {
  /** Starts a stage; call the returned function when it finishes (more than once is harmless). */
  stage(name: Stage): () => void;
  /** Ends the edit and any stage still open. `error` is for server-side failures, not for refusing bad input. */
  end(outcome: string, error?: boolean): void;
}

export interface CheckpointTrace {
  set(attrs: { n?: number; documents?: number }): void;
  end(outcome: string, error?: boolean): void;
}

const NO_EDIT: EditTrace = { stage: () => () => {}, end: () => {} };
const NO_CHECKPOINT: CheckpointTrace = { set: () => {}, end: () => {} };

const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function finish(span: Span, outcome: string, error: boolean): void {
  // The gateway has three reasons for a claimed time outside the certificate's life; one outcome is enough to see.
  const normal = outcome.startsWith("claimed_") ? "claimed_time" : outcome;
  safely(() => span.setAttribute("omnisync.outcome", pick(OUTCOMES, normal)));
  safely(() => {
    if (error) span.setStatus({ code: SpanStatusCode.ERROR });
  });
  safely(() => span.end());
}

export class Tracing {
  readonly #tracer: Tracer;

  constructor(tracer?: Tracer) {
    this.#tracer = tracer ?? trace.getTracer("omnisync");
  }

  edit(bytes: number): EditTrace {
    try {
      const root = this.#tracer.startSpan("omnisync.edit");
      if (count(bytes)) safely(() => root.setAttribute("omnisync.update.bytes", bytes));
      const parent = trace.setSpan(context.active(), root);
      const open = new Set<Span>();
      let ended = false;
      return {
        stage: (name) => {
          if (ended) return () => {};
          let span: Span | undefined;
          safely(() => {
            span = this.#tracer.startSpan(pick(STAGES, name), {}, parent);
            open.add(span);
          });
          return () => {
            const s = span;
            if (s === undefined || !open.delete(s)) return;
            safely(() => s.end());
          };
        },
        end: (outcome, error = false) => {
          if (ended) return;
          ended = true;
          for (const s of open) safely(() => s.end());
          open.clear();
          finish(root, outcome, error);
        },
      };
    } catch {
      return NO_EDIT;
    }
  }

  checkpoint(): CheckpointTrace {
    try {
      const span = this.#tracer.startSpan("omnisync.checkpoint");
      let ended = false;
      return {
        set: (attrs) => {
          if (ended) return;
          if (count(attrs.n)) safely(() => span.setAttribute("omnisync.checkpoint.n", attrs.n as number));
          if (count(attrs.documents)) safely(() => span.setAttribute("omnisync.checkpoint.documents", attrs.documents as number));
        },
        end: (outcome, error = false) => {
          if (ended) return;
          ended = true;
          finish(span, outcome, error);
        },
      };
    } catch {
      return NO_CHECKPOINT;
    }
  }
}
