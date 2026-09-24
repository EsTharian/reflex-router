// Outcome capture (record only). Joins Claude Code hook events to the proxy's decision records and emits, per
// decision window, the signals Phase 2 will tune against: correction (from the next user prompt), a failing test run
// after an edit, and edits reverted within a few turns.
//
// Windows: a main-chat user turn is keyed by the hooks' prompt_id and runs from its UserPromptSubmit to the next one;
// a subagent is keyed by its agent id and runs from SubagentStart to SubagentStop (several may be open at once;
// SubagentStop for an id without SubagentStart is ignored). Records are append-only: `outcome` when a window closes,
// `outcome_update` for a revert found after its window closed, `harness_injected` for a wire `new` main turn that no
// UserPromptSubmit accounts for. Nothing here can affect a request; prompt and file text stays in memory.
import crypto from "node:crypto";
import { hashId } from "../log/decision-log.js";
import { CORRECTION_WINDOW_CHARS, REVERT_WINDOW_TURNS, UNDO_RULE_IDS, correctionSignal, coversFile, exitCode, gitRestoredPaths, testRunnerKind, type CorrectionSignal } from "./heuristics.js";
import type { EscalationEvent, EscalationSignal } from "../worker/escalation.js";
import { EDIT_TOOLS, type HookEvent, type ToolUse } from "./hooks.js";
import { injectedPromptKind, isHandbackPrompt } from "../wire/claude-code.js";

/** Version of the heuristics that produced a record; bump when rules or weights change. */
export const HEURISTICS_VERSION = 1;
/** A wire `new` main turn binds to a UserPromptSubmit opened within this window before (or just after) it. */
export const PROMPT_MATCH_BEFORE_MS = 120_000;
export const PROMPT_MATCH_AFTER_MS = 2_000;
/** How many recent main-chat wire classifications a session keeps, to explain windows without a decision. */
const RECENT_WIRE_MAX = 64;
/** A wire request counts as "in" a window from shortly before it opened (the hook and the request race) to its close. */
const WIRE_LEAD_MS = 2_000;

/** What the router reports for each classified request (raw ids stay in memory; records carry hashes). */
export interface DecisionInfo {
  readonly id: string;
  readonly at: number;
  readonly sessionId: string | null;
  readonly agentId: string | null;
  readonly kind: "main" | "subagent" | "unknown";
  readonly turn: "new" | "continuation" | "side";
  readonly sideKind?: string | null;
  /** A `continuation` carrying a message the user typed mid-loop (src/wire/claude-code.ts). */
  readonly interjection?: boolean;
  readonly conv: string | null;
  readonly requestedModel: string | null;
  readonly sentModel: string | null;
  /** REFLEX_EFFORT ran this turn below the client's effort level (the model may be the one asked for). */
  readonly effortLowered?: boolean;
  /** A subagent's `new` turn: the hash of its task text, which joins it to the Agent call that started it (status line). */
  readonly taskHash?: string | null;
}

type RevertKind = "inverse_edit" | "write_restore" | "git_restore";

export interface OutcomeRecord {
  readonly v: 1;
  readonly record: "outcome";
  readonly id: string;
  readonly at: string;
  readonly session: string | null;
  /** The decision record this window belongs to; null when no proxy decision matched (e.g. worker restarted). */
  readonly decision_id: string | null;
  /** Hash of the hooks' prompt_id (main-chat windows). */
  readonly turn_id: string | null;
  readonly turn_seq: number;
  readonly scope: "main" | "subagent";
  readonly agent: string | null;
  readonly agent_type: string | null;
  /** How the window was joined to its decision. `interjection`: a message typed mid-tool-loop, joined to the pinned
   * conversation's own `new` decision — that decision then owns two windows, so these are counted separately in the
   * report and never inside a per-arm rate. */
  readonly attribution: "prompt_id" | "agent_id" | "interjection";
  /**
   * Subagent windows only: how this subagent was attached to the main turn that spawned it. `prompt_id`: its
   * SubagentStart carried a prompt id the main chat had already opened a window for. `current_turn`: it did not, so
   * the open main turn was used. `none`: no main turn was open, and `turn_seq` is 0. Never creates a main window -
   * doing that produced windows no wire turn could join (see #parentTurn).
   */
  readonly parent_turn: "prompt_id" | "current_turn" | "none" | null;
  readonly models: { readonly requested: string | null; readonly sent: string | null } | null;
  /**
   * Why `decision_id` is null. `no_wire_turn`: the window's UserPromptSubmit had no wire `new` turn; `nearest_wire` is
   * the main-chat wire classification closest to the window's start (e.g. `side:cross_session`, `continuation`), or
   * null when none was seen. (`UserPromptSubmit` also fires for messages the user did not type: other-session
   * messages, task notifications, subagent hand-backs.) `slash_command` is reserved: prompts starting with "/" open
   * no window.
   */
  readonly no_decision: { readonly reason: "no_wire_turn" | "slash_command"; readonly nearest_wire: string | null } | null;
  readonly window: { readonly closed_by: "next_prompt" | "subagent_stop" | "session_end"; readonly duration_ms: number; readonly ms_to_last_stop: number | null };
  readonly counts: {
    readonly edits: number;
    readonly bash: number;
    readonly bash_failures: number;
    readonly test_runs: number;
    readonly test_failures: number;
    /**
     * Messages that arrived through `UserPromptSubmit` while the window was open but were not typed by the user:
     * harness-injected ones (other-session messages, task notifications) and subagent hand-backs. None of them closes
     * the window or feeds its correction signal.
     */
    readonly injected_prompts: number;
  };
  readonly signals: {
    /** Strength of the next prompt looking like a correction; null when there was no next prompt (subagents, session end). */
    readonly correction: { readonly score: number; readonly matched: readonly string[]; readonly prompt_chars: number } | null;
    readonly test_failure_after_edit: { readonly detected: boolean; readonly runs: readonly { readonly kind: string; readonly exit_code: number | null; readonly edits_before: number }[] };
    /** Reverts of this window's edits found while the window was open (later ones come as outcome_update). */
    readonly reverted_edit: { readonly detected: boolean; readonly events: readonly { readonly kind: RevertKind; readonly file: string | null; readonly offset_turns: number }[] };
  };
  readonly params: { readonly heuristics_version: number; readonly revert_window_turns: number; readonly correction_window_chars: number };
}

export interface OutcomeUpdate {
  readonly v: 1;
  readonly record: "outcome_update";
  readonly id: string;
  readonly at: string;
  readonly session: string | null;
  readonly decision_id: string | null;
  /** Hash of the hooks' prompt_id (main-chat windows). */
  readonly turn_id: string | null;
  readonly turn_seq: number;
  readonly scope: "main" | "subagent";
  readonly agent: string | null;
  /**
   * `reverted_edit`: a revert found after its window closed. `correction_reattributed`: the undo-family part of a
   * correction score was moved off the turn that merely preceded the prompt and onto the turn the revert actually
   * undid (the attribution bug recorded in docs/observations.md, M4 acceptance).
   */
  readonly signal: "reverted_edit" | "correction_reattributed";
  readonly detail:
    | { readonly kind: RevertKind; readonly file: string | null; readonly offset_turns: number; readonly detected_in_turn_seq: number }
    | { readonly matched: readonly string[]; readonly score: number; readonly offset_turns: number; readonly from_turn_seq: number; readonly detected_in_turn_seq: number };
}

export interface HarnessInjected {
  readonly v: 1;
  readonly record: "harness_injected";
  readonly id: string;
  readonly at: string;
  readonly session: string | null;
  readonly decision_id: string;
  readonly conv: string | null;
  readonly reason: "no_user_prompt_submit";
}

export type TrackerRecord = OutcomeRecord | OutcomeUpdate | HarnessInjected;

interface Window {
  readonly scope: "main" | "subagent";
  readonly key: string; // prompt_id or agent id
  readonly seq: number; // the user turn's sequence number (subagents: the spawning turn's)
  readonly openedAt: number;
  agentType: string | null;
  decision: DecisionInfo | null;
  /** Set only when the window was joined other than by its own `new` turn; widens `attribution`. */
  joinedVia?: "interjection";
  /** Subagent windows only: how the spawning main turn was found (see #parentTurn). */
  parentVia?: "prompt_id" | "current_turn" | "none";
  /**
   * The correction signal of the prompt that OPENED this window (the same prompt that closed the previous one). Kept
   * so that, if this window turns out to revert an earlier turn's edit, the undo-family part of that score can be
   * re-attributed to the turn actually undone instead of the one that merely came before the prompt.
   */
  openingCorrection: CorrectionSignal | null;
  lastStopAt: number | null;
  edits: number;
  bash: number;
  bashFailures: number;
  testRuns: number;
  testFailures: { kind: string; exit_code: number | null; edits_before: number }[];
  injectedPrompts: number;
  reverts: { kind: RevertKind; file: string | null; offset_turns: number }[];
  closed: boolean;
}

interface EditRec {
  readonly window: Window;
  readonly file: string;
  readonly oldHash: string | null;
  readonly newHash: string;
  /** Hash of the file's full content before this edit, when the hook response carried it. */
  readonly originalHash: string | null;
  readonly seq: number;
}

interface Session {
  readonly id: string;
  seq: number;
  readonly turns: Map<string, Window>;
  current: Window | null;
  readonly agents: Map<string, Window>;
  /** Subagent decisions that arrived before their SubagentStart. */
  readonly pendingAgentDecisions: Map<string, DecisionInfo>;
  edits: EditRec[];
  /** A UserPromptSubmit has arrived: hooks are being delivered for this session. */
  promptsSeen: boolean;
  /** Time of the last slash-command prompt (it opens no window; a wire turn it expands into is not "injected"). */
  lastSlashAt: number | null;
  /** Recent main-chat wire classifications (`new`, `continuation`, `side:<kind>`), newest last. */
  recentWire: { readonly at: number; readonly label: string }[];
  /** Per conversation key, the last main-chat `new` decision: the one the router's pin belongs to. */
  readonly lastNewByConv: Map<string, DecisionInfo>;
}

const h = (s: string): string => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

export interface TrackerDeps {
  readonly emit: (r: TrackerRecord) => void;
  /**
   * Called when a window that was ROUTED closes carrying an outcome signal. The only channel through which outcome
   * capture can reach anything else; the router ignores it unless REFLEX_ESCALATE=1. Record-writing is unaffected by
   * whether this is wired, and nothing here may block or throw into the tracker.
   */
  readonly onSignal?: (e: EscalationEvent) => void;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export class OutcomeTracker {
  readonly #sessions = new Map<string, Session>();
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(private readonly d: TrackerDeps) {
    this.#now = d.now ?? Date.now;
    this.#newId = d.newId ?? (() => crypto.randomUUID());
  }

  #session(id: string): Session {
    let s = this.#sessions.get(id);
    if (!s) {
      s = { id, seq: 0, turns: new Map(), current: null, agents: new Map(), pendingAgentDecisions: new Map(), edits: [], promptsSeen: false, lastSlashAt: null, recentWire: [], lastNewByConv: new Map() };
      this.#sessions.set(id, s);
    }
    return s;
  }

  #window(scope: Window["scope"], key: string, seq: number): Window {
    return { scope, key, seq, openedAt: this.#now(), agentType: null, decision: null, openingCorrection: null, lastStopAt: null, edits: 0, bash: 0, bashFailures: 0, testRuns: 0, testFailures: [], injectedPrompts: 0, reverts: [], closed: false };
  }

  /**
   * The main-chat turn sequence an event belongs to, WITHOUT creating a window. `SubagentStart` carries the subagent's
   * own prompt id, which the main chat never saw, so routing it through `#turnFor` manufactured a phantom main window
   * that no wire turn could ever join: it sat open until session_end with zero counts and closed `no_wire_turn`
   * (observed as 29d16aa2 seq 4, docs/observations.md, where the phantom and the subagent window share a turn_seq and
   * an openedAt to the millisecond). A subagent belongs to the turn that spawned it or to no turn at all.
   */
  #parentTurn(s: Session, promptId: string | null): { seq: number; via: "prompt_id" | "current_turn" | "none" } {
    if (promptId !== null) {
      const t = s.turns.get(promptId);
      if (t) return { seq: t.seq, via: "prompt_id" };
    }
    if (s.current && !s.current.closed) return { seq: s.current.seq, via: "current_turn" };
    return { seq: 0, via: "none" };
  }

  /** The main-chat turn an event belongs to: its prompt_id's turn, else the current one (created if none yet). */
  #turnFor(s: Session, promptId: string | null): Window {
    if (promptId !== null) {
      const t = s.turns.get(promptId);
      if (t) return t;
      const w = this.#window("main", promptId, ++s.seq); // an event whose UserPromptSubmit we did not see
      s.turns.set(promptId, w);
      s.current ??= w;
      return w;
    }
    if (s.current) return s.current;
    const w = this.#window("main", `anon-${s.seq + 1}`, ++s.seq);
    s.turns.set(w.key, w);
    s.current = w;
    return w;
  }

  /** Never throws. */
  ingest(e: HookEvent): void {
    try {
      this.#ingest(e);
    } catch {
      // outcome capture is best effort; a malformed sequence must never matter
    }
  }

  #ingest(e: HookEvent): void {
    const s = this.#session(e.base.sessionId);
    switch (e.type) {
      case "PreToolUse":
        return; // the status line's subagent titles; nothing to capture
      case "UserPromptSubmit": {
        s.promptsSeen = true;
        if (e.prompt.trimStart().startsWith("/")) {
          // A slash command is not a turn of its own: no window, and the current turn stays open for the next real prompt.
          s.lastSlashAt = this.#now();
          return;
        }
        if (injectedPromptKind(e.prompt) !== null || isHandbackPrompt(e.prompt)) {
          // Claude Code injected this message itself, or it is a subagent's report handed back into the main chat
          // (model output, not the user). Neither is the user's reaction to the previous reply, so it neither closes
          // that turn nor feeds its correction signal; events under its prompt_id join the open user turn.
          const open = s.current && !s.current.closed ? s.current : null;
          if (open) {
            open.injectedPrompts++;
            if (e.base.promptId !== null) s.turns.set(e.base.promptId, open);
          }
          return;
        }
        const corr = correctionSignal(e.prompt);
        if (s.current && !s.current.closed) this.#close(s, s.current, "next_prompt", corr);
        const key = e.base.promptId ?? `anon-${s.seq + 1}`;
        const w = this.#window("main", key, ++s.seq);
        w.openingCorrection = corr;
        s.turns.set(key, w);
        s.current = w;
        this.#prune(s);
        return;
      }
      case "SubagentStart": {
        if (e.base.agentId === null) return;
        const parent = this.#parentTurn(s, e.base.promptId);
        const w = this.#window("subagent", e.base.agentId, parent.seq);
        w.parentVia = parent.via;
        w.agentType = e.agentType;
        const pending = s.pendingAgentDecisions.get(e.base.agentId);
        if (pending) {
          w.decision = pending;
          s.pendingAgentDecisions.delete(e.base.agentId);
        }
        s.agents.set(e.base.agentId, w);
        return;
      }
      case "SubagentStop": {
        const w = e.base.agentId !== null ? s.agents.get(e.base.agentId) : undefined;
        if (w && !w.closed) this.#close(s, w, "subagent_stop", null); // ids without SubagentStart are ignored
        return;
      }
      case "Stop": {
        const w = this.#turnFor(s, e.base.promptId);
        w.lastStopAt = this.#now();
        return;
      }
      case "PostToolUse":
      case "PostToolUseFailure":
        this.#tool(s, e.base.agentId, e.base.promptId, e.tool, e.type === "PostToolUseFailure");
        return;
    }
  }

  #tool(s: Session, agentId: string | null, promptId: string | null, tool: ToolUse, failed: boolean): void {
    const turn = this.#turnFor(s, promptId);
    const agentWin = agentId !== null ? s.agents.get(agentId) : undefined;
    const w = agentWin ?? turn;
    const seq = w.seq;

    if (EDIT_TOOLS.has(tool.name) && tool.filePath !== null && !failed) {
      const originalHash = tool.originalFile !== null ? h(tool.originalFile) : null;
      for (const edit of tool.edits) {
        const newHash = h(edit.newText);
        const oldHash = edit.oldText !== null ? h(edit.oldText) : null;
        const prior = this.#recent(s, seq).filter((r) => r.file === tool.filePath);
        const inverse = oldHash !== null ? prior.find((r) => r.oldHash === newHash && r.newHash === oldHash) : undefined;
        const restored = tool.name === "Write" ? prior.find((r) => r.originalHash !== null && r.originalHash === newHash) : undefined;
        const undone = inverse ?? restored;
        if (undone) this.#revert(s, undone, inverse ? "inverse_edit" : "write_restore", seq, w);
        s.edits.push({ window: w, file: tool.filePath, oldHash, newHash, originalHash, seq });
      }
      w.edits++; // a subagent's edits count in its own window; the main turn sees them through #editsInTurn
      return;
    }

    if (tool.name === "Bash") {
      w.bash++;
      if (failed) w.bashFailures++;
      const command = tool.command ?? "";
      const kind = testRunnerKind(command);
      if (kind !== null) {
        w.testRuns++;
        if (failed) {
          // The main turn counts its subagents' edits too: "a turn that contained an Edit/Write".
          const editsBefore = w.scope === "main" ? this.#editsInTurn(s, w) : w.edits;
          w.testFailures.push({ kind, exit_code: exitCode(tool.error), edits_before: editsBefore });
        }
      }
      if (!failed) {
        const restored = gitRestoredPaths(command);
        if (restored.length > 0) {
          const seen = new Set<string>();
          for (const r of this.#recent(s, seq)) {
            if (!coversFile(restored, r.file) || seen.has(`${r.window.key}|${r.file}`)) continue;
            seen.add(`${r.window.key}|${r.file}`);
            this.#revert(s, r, "git_restore", seq, w);
          }
        }
      }
    }
  }

  /** Edits made in the main turn `w` and in the subagents it spawned. */
  #editsInTurn(s: Session, w: Window): number {
    return s.edits.filter((r) => r.seq === w.seq).length;
  }

  /** Earlier edits still inside the revert window of an event in turn `seq`. */
  #recent(s: Session, seq: number): EditRec[] {
    return s.edits.filter((r) => seq - r.seq <= REVERT_WINDOW_TURNS);
  }

  #revert(s: Session, undone: EditRec, kind: RevertKind, seq: number, detectedIn: Window): void {
    const w = undone.window;
    const offset = seq - undone.seq;
    const detail = { kind, file: hashId(undone.file), offset_turns: offset };
    this.#reattributeUndo(s, w, detectedIn, offset, seq);
    if (!w.closed) {
      w.reverts.push(detail);
      return;
    }
    this.d.emit({
      v: 1,
      record: "outcome_update",
      id: this.#newId(),
      at: new Date(this.#now()).toISOString(),
      session: hashId(s.id),
      decision_id: w.decision?.id ?? null,
      turn_id: w.scope === "main" ? hashId(w.key) : null,
      turn_seq: w.seq,
      scope: w.scope,
      agent: w.scope === "subagent" ? hashId(w.key) : null,
      signal: "reverted_edit",
      detail: { ...detail, detected_in_turn_seq: seq },
    });
  }

  /**
   * The undo-family fix. `correctionSignal` scores the prompt that CLOSED a turn, so a prompt like "undo that" puts its
   * `en:undo` weight on the turn immediately before it. When that prompt goes on to revert an edit made `offset_turns`
   * earlier, the turn it indicts is the reverted one, not its predecessor. With `offset_turns > 0` the undo-family part
   * of the score is therefore re-attributed with an `outcome_update`; the original `outcome` record is append-only and
   * is left exactly as written (the report subtracts, it does not rewrite). Nothing is re-attributed at offset 0: the
   * revert undid an edit from the same turn the score already sits on.
   */
  #reattributeUndo(s: Session, reverted: Window, detectedIn: Window, offset: number, seq: number): void {
    if (offset <= 0) return;
    const corr = detectedIn.openingCorrection;
    if (!corr) return;
    const matched = corr.matched.filter((id) => UNDO_RULE_IDS.has(id));
    if (matched.length === 0) return;
    this.d.emit({
      v: 1,
      record: "outcome_update",
      id: this.#newId(),
      at: new Date(this.#now()).toISOString(),
      session: hashId(s.id),
      decision_id: reverted.decision?.id ?? null,
      turn_id: reverted.scope === "main" ? hashId(reverted.key) : null,
      turn_seq: reverted.seq,
      scope: reverted.scope,
      agent: reverted.scope === "subagent" ? hashId(reverted.key) : null,
      signal: "correction_reattributed",
      detail: { matched, score: corr.score, offset_turns: offset, from_turn_seq: detectedIn.seq - 1, detected_in_turn_seq: seq },
    });
    if (reverted.decision !== null) this.#signal(reverted, { signal: "reverted_edit", score: corr.score, turnSeq: reverted.seq });
  }

  /**
   * Hands one escalation signal to whoever wired `onSignal` (the router, only when REFLEX_ESCALATE=1). Never throws
   * into the tracker: outcome capture must keep writing records whatever the consumer does. Only a window whose
   * decision was ROUTED (another model, or a lower effort level) is reported — a turn that ran exactly as the client
   * asked has nothing to escalate to, and reporting it would let escalation fire on requests reflex never touched.
   */
  #signal(w: Window, e: { signal: EscalationSignal; score: number | null; turnSeq: number }): void {
    const d = w.decision;
    if (this.d.onSignal === undefined || d === null || d.conv === null) return;
    const moved = d.sentModel !== null && d.requestedModel !== null && d.sentModel !== d.requestedModel;
    if (!moved && d.effortLowered !== true) return;
    try {
      this.d.onSignal({ conv: d.conv, signal: e.signal, score: e.score, decisionId: d.id, turnSeq: e.turnSeq });
    } catch {
      // a consumer's failure must never affect the record that is being written
    }
  }

  #prune(s: Session): void {
    s.edits = s.edits.filter((r) => s.seq - r.seq <= REVERT_WINDOW_TURNS);
    for (const [k, w] of s.turns) if (w.closed && s.seq - w.seq > REVERT_WINDOW_TURNS) s.turns.delete(k);
    for (const [k, w] of s.agents) if (w.closed && s.seq - w.seq > REVERT_WINDOW_TURNS) s.agents.delete(k);
  }

  #close(s: Session, w: Window, closedBy: OutcomeRecord["window"]["closed_by"], correction: CorrectionSignal | null): void {
    w.closed = true;
    const now = this.#now();
    this.d.emit({
      v: 1,
      record: "outcome",
      id: this.#newId(),
      at: new Date(now).toISOString(),
      session: hashId(s.id),
      decision_id: w.decision?.id ?? null,
      turn_id: w.scope === "main" ? hashId(w.key) : null,
      turn_seq: w.seq,
      scope: w.scope,
      agent: w.scope === "subagent" ? hashId(w.key) : null,
      agent_type: w.agentType,
      attribution: w.joinedVia ?? (w.scope === "main" ? "prompt_id" : "agent_id"),
      parent_turn: w.scope === "subagent" ? w.parentVia ?? "none" : null,
      models: w.decision ? { requested: w.decision.requestedModel, sent: w.decision.sentModel } : null,
      no_decision: w.decision ? null : { reason: "no_wire_turn", nearest_wire: w.scope === "main" ? this.#nearestWire(s, w, now) : null },
      window: { closed_by: closedBy, duration_ms: now - w.openedAt, ms_to_last_stop: w.lastStopAt !== null ? w.lastStopAt - w.openedAt : null },
      counts: { edits: w.edits, bash: w.bash, bash_failures: w.bashFailures, test_runs: w.testRuns, test_failures: w.testFailures.length, injected_prompts: w.injectedPrompts },
      signals: {
        correction: correction ? { score: correction.score, matched: correction.matched, prompt_chars: correction.promptChars } : null,
        test_failure_after_edit: { detected: w.testFailures.some((f) => f.edits_before > 0), runs: w.testFailures },
        reverted_edit: { detected: w.reverts.length > 0, events: w.reverts },
      },
      params: { heuristics_version: HEURISTICS_VERSION, revert_window_turns: REVERT_WINDOW_TURNS, correction_window_chars: CORRECTION_WINDOW_CHARS },
    });
    // The record is written first and unconditionally; the signal is a strictly additional side effect. One signal per
    // window, in the order the plan lists them, so section 13's n counts windows and not matched rules.
    if (correction !== null && correction.score > 0) this.#signal(w, { signal: "correction", score: correction.score, turnSeq: w.seq });
    else if (w.testFailures.some((f) => f.edits_before > 0)) this.#signal(w, { signal: "test_failure", score: null, turnSeq: w.seq });
    else if (w.reverts.length > 0) this.#signal(w, { signal: "reverted_edit", score: null, turnSeq: w.seq });
  }

  /**
   * The newest main-chat window still waiting for a decision, opened close enough in time to be this request's.
   * Time-based, like the `new` join it was extracted from: if the response outlives the gap to the next typed prompt
   * the window has already closed and the join is missed. That race predates this and is not addressed here.
   */
  #pendingTurn(s: Session, at: number): Window | undefined {
    const candidates = [...s.turns.values()].filter((w) => w.scope === "main" && !w.key.startsWith("anon-") && w.decision === null && w.openedAt <= at + PROMPT_MATCH_AFTER_MS && w.openedAt >= at - PROMPT_MATCH_BEFORE_MS);
    return candidates.sort((a, b) => b.openedAt - a.openedAt)[0];
  }

  /** The main-chat wire classification closest to the start of `w`, among those inside the window. */
  #nearestWire(s: Session, w: Window, closedAt: number): string | null {
    const inside = s.recentWire.filter((x) => x.at >= w.openedAt - WIRE_LEAD_MS && x.at <= closedAt);
    inside.sort((a, b) => Math.abs(a.at - w.openedAt) - Math.abs(b.at - w.openedAt));
    return inside[0]?.label ?? null;
  }

  /** Called by the router for every classified request; `new` turns are joined, main-chat ones remembered. Never throws. */
  onDecision(d: DecisionInfo): void {
    try {
      if (d.sessionId === null || d.kind === "unknown") return;
      const s = this.#session(d.sessionId);
      if (d.kind === "main") {
        const label = d.turn === "side" ? `side:${d.sideKind ?? "unclassified"}` : d.turn === "continuation" && d.interjection === true ? "continuation:interjection" : d.turn;
        s.recentWire.push({ at: d.at, label });
        if (s.recentWire.length > RECENT_WIRE_MAX) s.recentWire.shift();
      }
      // A message typed into a running tool loop is the user's own turn but takes no decision of its own: the pin is
      // held, so the work it produces runs on the turn's decision. Join its window to that decision, or the correction
      // in the NEXT prompt lands on `decision_id: null` and is lost.
      if (d.kind === "main" && d.turn === "continuation" && d.interjection === true) {
        const prior = d.conv === null ? undefined : s.lastNewByConv.get(d.conv);
        const w = prior ? this.#pendingTurn(s, d.at) : undefined;
        if (w && prior) {
          w.decision = prior;
          w.joinedVia = "interjection";
        }
        return; // no prior decision on this conversation: the window stays no_wire_turn, which says why
      }
      if (d.turn !== "new") return;
      if (d.kind === "subagent") {
        if (d.agentId === null) return;
        const w = s.agents.get(d.agentId);
        if (w) w.decision ??= d;
        else s.pendingAgentDecisions.set(d.agentId, d);
        return;
      }
      const t = this.#pendingTurn(s, d.at);
      if (t) {
        t.decision = d;
        if (d.conv !== null) s.lastNewByConv.set(d.conv, d);
        return;
      }
      // Without any UserPromptSubmit in this session the hooks are not arriving (e.g. blocked by managed policy),
      // so the absence of one proves nothing: no flag. A slash command that expands into a model turn is not injected.
      if (!s.promptsSeen) return;
      if (s.lastSlashAt !== null && s.lastSlashAt <= d.at + PROMPT_MATCH_AFTER_MS && s.lastSlashAt >= d.at - PROMPT_MATCH_BEFORE_MS) return;
      this.d.emit({ v: 1, record: "harness_injected", id: this.#newId(), at: new Date(d.at).toISOString(), session: hashId(d.sessionId), decision_id: d.id, conv: d.conv, reason: "no_user_prompt_submit" });
    } catch {
      // best effort
    }
  }

  /** Closes every open window (worker shutdown / end of session). */
  flush(): void {
    for (const s of this.#sessions.values()) {
      for (const w of [...s.turns.values(), ...s.agents.values()]) if (!w.closed) this.#close(s, w, "session_end", null);
    }
  }
}
