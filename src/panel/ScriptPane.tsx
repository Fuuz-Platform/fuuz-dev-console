import { useEffect, useMemo, useRef, useState } from 'react';
import jsonata from 'jsonata';
import {
  parseInputs, toTransferable, type ScriptLanguage, type ScriptResult,
} from '../core/scriptRun';
import {
  flowNodeScaffold, nodesThatRan, screenBindings, screenStateScaffold, triggerScaffold,
  TRIGGER_BINDINGS, type TriggerOperation,
} from '../core/scriptContext';
import { applyCompletion, completionsAt, type CompletionRequest } from '../core/completions';
import { ACCEPTED, parseWorkspaceFile, serializeWorkspace, suggestedName } from '../core/workspaceFile';
import { openText, saveText } from './fileIo';
import type { ModelShape } from '../core/modelTree';
import type { Host } from './host';
import { API_ACCESS, API_DISABLED_REASON } from '../core/apiAccess';
import { insertAt, searchPaths } from '../core/pathInsert';
import { accepts } from '../core/functionPalette';
import {
  appendOperator, findFunctions, paletteFor, platformFunctionsIn, resolveType, tokenAround,
  wrapInFunction, type FunctionDoc,
} from '../core/functionPalette';
import { PathTree } from './PathTree';

/**
 * Write a script against a payload and a context, and see what it returns.
 *
 * Available on every surface, including none: unlike every other pane this needs
 * nothing from the page — no capture, no design, no attached tab. Working out a
 * transform before the screen exists to run it in is exactly when you need it.
 *
 * JSONata evaluates here in the panel with the platform's own version, 2.1.1.
 * JavaScript cannot: an extension page's CSP forbids `eval`, so it runs in a
 * sandboxed frame with no extension APIs and no reach into the Fuuz tab. That
 * containment is why neither is gated — nothing here touches a live tenant.
 */
/**
 * Search hits, each one still a click away from being inserted.
 *
 * The full path is shown rather than just the matching key: `$components.TicketTable.data.rows`
 * is the answer, and a row reading only `rows` would send you back to the tree to find out
 * which `rows` it meant.
 */
function Hits({ matches, onPick, suits }: {
  matches: ReturnType<typeof searchPaths>;
  onPick: (path: string) => void;
  /** The type the armed function wants, so search results dim the same way the tree does. */
  suits?: string;
  values?: boolean;
}) {
  if (!matches.length) return <div className="elabel" style={{ padding: '4px 8px' }}>Nothing matches.</div>;
  return (
    <>
      {matches.map((m) => (
        <div key={m.path} className={`pathrow ${suits && !hitFits(m, suits) ? 'unfit' : ''}`}
          title={`Insert ${m.path}`} onClick={() => onPick(m.path)}>
          <span className="caret" />
          {/* Whether the key or the value matched — the difference between "where is
              libraryId" and "which element holds LIB-002". */}
          <span className={`pathkey ${m.on === 'value' ? 'onvalue' : ''}`}>{m.path}</span>
          <span className="pathval">{m.preview}</span>
        </div>
      ))}
    </>
  );
}

/**
 * Whether a search hit suits the armed function.
 *
 * Judged on the *preview*, which is all a hit carries — `"Pump"` is a string, `12` a number. Cheaper
 * than re-walking to the value, and the preview is derived from it, so the two cannot disagree.
 */
function hitFits(hit: { preview: string }, suits: string): boolean {
  if (suits === 'any') return true;
  const p = hit.preview;
  const type = p.startsWith('"') ? 'string'
    : p.startsWith('[') ? 'array'
      : p.startsWith('{') ? 'object'
        : /^(true|false)$/.test(p) ? 'boolean'
          : /^-?[\d.]+$/.test(p) ? 'number' : 'unknown';
  return accepts(suits, type as never);
}

/**
 * What the script is written *against*.
 *
 * A blank payload is honest and unhelpful, because the hard part of a Fuuz expression is
 * knowing what is bound. Each mode binds a different `$`, which is exactly what decides
 * whether an expression transfers to the designer unchanged.
 */
type BindingMode = 'free' | 'screen' | 'model' | 'flow';

export function ScriptPane({ seedContext, elements = [], flowSummary = [], host, surface }: {
  /**
   * Which designer is open — `screen`, `schema`, `flow`, or undefined off a designer.
   *
   * Only the modes that can work here are offered: Screen state needs a screen, Model
   * trigger needs a schema, Flow node needs a flow that has run. Showing all four
   * everywhere meant three of them were dead ends at any given moment.
   */
  surface?: string;
  /** The captured screen context, offered as a starting point for the context box. */
  seedContext?: unknown;
  /** Design elements, so components and their functions complete before they run. */
  elements?: { name: string; type: string }[];
  /**
   * Every node that ran, for the payload picker.
   *
   * The *summary*, not the payload-bearing runs: those are capped by a byte budget, so one
   * integration node with a large API response left only itself in the list.
   */
  flowSummary?: { node: string; runs: number; totalMs?: number; failed?: number }[];
  host: Host;
}) {
  const [language, setLanguage] = useState<ScriptLanguage>('jsonata');
  const [mode, setMode] = useState<BindingMode>('free');
  const [copied, setCopied] = useState('');
  const [script, setScript] = useState('');
  const [payloadText, setPayloadText] = useState('{}');
  const [contextText, setContextText] = useState('{}');
  const [result, setResult] = useState<ScriptResult | undefined>();
  const [running, setRunning] = useState(false);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const ready = useRef(false);
  const nextId = useRef(1);
  const pending = useRef(new Map<number, (r: ScriptResult) => void>());
  /** The file this workspace came from or was last written to. */
  const [file, setFile] = useState<{ name?: string; handle?: unknown }>({});
  const [fileNote, setFileNote] = useState('');

  /* ── Model triggers ────────────────────────────────────────────────────── */

  const [models, setModels] = useState<string[]>([]);
  const [modelError, setModelError] = useState<string | undefined>();
  const [model, setModel] = useState('');
  const [shape, setShape] = useState<ModelShape | undefined>();
  const [operation, setOperation] = useState<TriggerOperation>('update');

  // Fetched when the mode is first entered: a list of every model in the environment is
  // not worth a request until it is going to be shown.
  useEffect(() => {
    if (mode !== 'model' || models.length || modelError) return;
    void host.query?.models().then((r) => {
      setModels(r.names);
      if (!r.names.length) setModelError(r.error ?? 'No models came back from the schema.');
    });
  }, [mode, models.length, modelError, host]);

  useEffect(() => {
    if (mode !== 'model' || !model) return;
    let cancelled = false;
    void host.query?.describeModel(model).then((s) => {
      if (cancelled || !s) { if (!cancelled) setShape(undefined); return; }
      setShape(s);
      // Scaffolded on selection, not on every render: it overwrites both input boxes,
      // and doing that under the developer's cursor would be destructive.
      const scaffold = triggerScaffold(s, operation);
      setPayloadText(scaffold.payload);
      setContextText(scaffold.context);
    });
    return () => { cancelled = true; };
  }, [mode, model, operation, host]);

  /*
   * A model trigger is JSONata, always.
   *
   * Triggers are evaluated by the platform's own expression engine, so offering
   * JavaScript here would let someone write something that cannot be pasted into a model
   * at all.
   */
  useEffect(() => {
    if (mode === 'model' && language !== 'jsonata') setLanguage('jsonata');
  }, [mode, language]);

  /* ── Flow node payloads ────────────────────────────────────────────────── */

  const flowNodes = useMemo(() => nodesThatRan(flowSummary), [flowSummary]);
  const [pickedNode, setPickedNode] = useState('');
  const [nodeNote, setNodeNote] = useState('');

  /**
   * Fetch the chosen node's recorded payload on demand.
   *
   * On demand precisely because the payloads are large: holding every node's is what the byte budget
   * exists to prevent, and it was that budget which emptied this list. One node's payload, when you
   * ask for it, costs nothing until then.
   */
  const loadNode = async (name: string) => {
    setPickedNode(name);
    if (!name) return;
    setNodeNote('loading…');
    const reply = await host.flow?.payloads(name) as
      { runs?: { output?: unknown; state?: unknown; status?: string }[] } | undefined;
    // The newest run: a node that ran several times is being debugged at its latest attempt.
    const run = reply?.runs?.[(reply.runs?.length ?? 0) - 1];
    if (!run) {
      setNodeNote(`No recorded payload for ${name} — it ran, but the engine kept no output for it.`);
      return;
    }
    const scaffold = flowNodeScaffold({ node: name, key: name, status: run.status ?? 'ok', output: run.output, state: run.state });
    setPayloadText(scaffold.payload);
    setContextText(scaffold.context);
    setNodeNote(`${name} · output loaded as the payload, its state as $state`);
  };

  /* ── The sandbox, for JavaScript ───────────────────────────────────────── */

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as { source?: string; id?: number } & ScriptResult;
      if (msg?.source === 'fuuz-script-sandbox-ready') { ready.current = true; return; }
      if (msg?.source !== 'fuuz-script-sandbox-result' || typeof msg.id !== 'number') return;
      const resolve = pending.current.get(msg.id);
      pending.current.delete(msg.id);
      resolve?.({ ok: msg.ok, value: msg.value, error: msg.error, logs: msg.logs, elapsedMs: msg.elapsedMs });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /**
   * Run in the sandbox, with a timeout that replaces the frame.
   *
   * `while (true) {}` wedges the frame and there is nothing inside it that can
   * interrupt its own synchronous execution — no worker to terminate. So the timeout
   * lives here and its remedy is to reload the iframe, which is the only thing that
   * actually recovers. Saying "timed out" while leaving a dead frame in place would
   * break every subsequent run.
   */
  const runInSandbox = (source: string, payload: unknown, context: Record<string, unknown>) =>
    new Promise<ScriptResult>((resolve) => {
      const el = frame.current;
      if (!el?.contentWindow) { resolve({ ok: false, error: 'The script sandbox has not loaded yet — try again in a moment.' }); return; }
      const id = nextId.current++;
      let settled = false;
      const done = (r: ScriptResult) => { if (!settled) { settled = true; resolve(r); } };
      pending.current.set(id, done);
      const timer = setTimeout(() => {
        if (settled) return;
        pending.current.delete(id);
        // Reload it: a wedged frame answers nothing ever again.
        el.src = el.src;
        ready.current = false;
        done({ ok: false, error: 'The script ran for 5 seconds and was stopped. The sandbox was reloaded — an infinite loop cannot be interrupted any other way.' });
      }, 5000);
      const clear = (r: ScriptResult) => { clearTimeout(timer); done(r); };
      pending.current.set(id, clear);
      el.contentWindow.postMessage(
        { source: 'fuuz-script-sandbox', id, script: source, payload: toTransferable(payload), context: toTransferable(context) as Record<string, unknown> },
        '*'
      );
    });

  /* ── Running ───────────────────────────────────────────────────────────── */

  const run = async () => {
    if (!script.trim()) { setResult(undefined); return; }
    if (inputs.error) { setResult({ ok: false, error: inputs.error }); return; }

    /*
     * Fuuz's own functions cannot be evaluated here.
     *
     * The bundled engine is stock JSONata 2.1.1; `$query`, `$cuid`, `$moment` and the rest live on
     * the platform. Saying so up front — and naming them — is the difference between "your
     * expression is fine, it just needs the platform to run" and a bare "unknown function", which
     * reads as the expression being wrong.
     */
    const platform = language === 'jsonata' ? platformFunctionsIn(script) : [];
    if (platform.length) {
      setResult({
        ok: false,
        error: `${platform.join(', ')} ${platform.length === 1 ? 'is a Fuuz function' : 'are Fuuz functions'}`
          + ' — they run on the platform, not in this panel, so this expression cannot be evaluated here.'
          + ' Everything else about it is still checked: paste it into the designer to run it.',
      });
      return;
    }

    setRunning(true);
    try {
      if (language === 'jsonata') {
        const started = performance.now();
        try {
          /*
           * The payload is the document; the context's keys are the bindings.
           *
           * This is how a flow node sees it — `$` is the payload, `$state` and
           * `$metadata` are bindings — and matching it is the whole point: an
           * expression that works here has to work when pasted into the designer.
           */
          const value = await jsonata(script).evaluate(inputs.payload ?? {}, inputs.context);
          setResult({
            ok: true,
            value: value === undefined ? '(no match)' : toTransferable(value),
            elapsedMs: performance.now() - started,
          });
        } catch (e) {
          setResult({ ok: false, error: e instanceof Error ? e.message : String(e), elapsedMs: performance.now() - started });
        }
      } else {
        setResult(await runInSandbox(script, inputs.payload, inputs.context));
      }
    } finally {
      setRunning(false);
    }
  };

  // ⌘/ctrl + Enter runs, which is the convention in every query console.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run(); }
  };

  /**
   * Which modes this page can actually offer.
   *
   * Keyed on the open surface, not on whether data happens to be present: a screen designer
   * offers Screen state even before a capture, because that is where you would want it. Free
   * is always offered — it needs nothing.
   */
  const offers = {
    screen: surface === 'screen' || seedContext !== undefined,
    model: surface === 'schema',
    flow: surface === 'flow' || flowNodes.length > 0,
  };

  /*
   * A mode that no longer applies falls back to Free.
   *
   * Switching designer tabs would otherwise leave the pane in, say, Flow node with its
   * picker gone and a payload from a flow you are no longer looking at.
   */
  useEffect(() => {
    if (mode === 'screen' && !offers.screen) setMode('free');
    if (mode === 'model' && !offers.model) setMode('free');
    if (mode === 'flow' && !offers.flow) setMode('free');
  }, [mode, offers.screen, offers.model, offers.flow]);

  const inputs = useMemo(() => parseInputs(payloadText, contextText), [payloadText, contextText]);
  const contextKeys = inputs.error ? [] : Object.keys(inputs.context);

  /**
   * The object `$name` completions resolve against.
   *
   * In screen mode the captured context is augmented with the `fn` bags, so
   * `$components.Table1.fn.refresh` completes even though the runtime never logs a
   * function. Everywhere else the context box is the whole truth — which is the point of
   * scaffolding it from a model or a node.
   */
  const completionContext = useMemo(
    () => (mode === 'screen' ? screenBindings(seedContext ?? inputs.context, elements) : inputs.context),
    [mode, seedContext, inputs.context, elements]
  );

  /**
   * Screen-state mode: the payload becomes every element's live state.
   *
   * Both boxes are filled, so the whole screen is browsable and completable at once —
   * `$.AssetIntakeForm.data` from the payload, `$components.AssetIntakeForm.data` and
   * `$metadata…` from the context.
   */
  const screenScaffold = useMemo(
    () => screenStateScaffold(toTransferable(seedContext)),
    [seedContext]
  );

  const enterScreenMode = () => {
    setMode('screen');
    if (seedContext === undefined) return;
    setPayloadText(screenScaffold.payload);
    setContextText(screenScaffold.context);
  };

  /* ── Autocomplete ──────────────────────────────────────────────────────── */

  /**
   * Where the caret was, so a click on a path inserts in the right place.
   *
   * Read from the textarea on every interaction rather than at insert time: clicking a tree
   * row moves focus out of the editor, and by then `selectionStart` is whatever it was left
   * at — which is fine, provided it was recorded while the editor still had focus.
   */
  const caret = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  /**
   * Mirrored into state as well as the ref.
   *
   * The ref is what an insertion reads; the state is what makes the palette re-render as the
   * cursor moves, which is the entire point — a palette that only updated on keystrokes would
   * show the wrong functions the moment you clicked elsewhere in the expression.
   */
  const [caretPos, setCaretPos] = useState(0);
  /** A search across the whole catalogue, when the type filter is not what you want. */
  const [fnFind, setFnFind] = useState('');
  const [showPalette, setShowPalette] = useState(true);
  /**
   * The function whose data requirements the payload and context are filtered by.
   *
   * The inverse of the palette: with `$substring` in view, everything that is not a string dims, so a
   * large capture narrows to the parts that would fit.
   *
   * **Driven by hover**, and pinned by shift-click. It was shift-click only, which is a hidden
   * modifier — so selecting a function appeared to do nothing to the data, and the feature read as
   * broken. Hovering shows it as you move across the palette, which needs no explaining; pinning is
   * what you reach for once you want to go and click a value.
   */
  const [pinnedFn, setPinnedFn] = useState<FunctionDoc | undefined>();
  const [hoveredFn, setHoveredFn] = useState<FunctionDoc | undefined>();
  const armed = pinnedFn ?? hoveredFn;
  const rememberCaret = (el: HTMLTextAreaElement) => {
    caret.current = { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
    setCaretPos(el.selectionStart ?? 0);
  };

  /**
   * The expression under the cursor, and what type it holds.
   *
   * This is what makes the palette a tool rather than a reference: `$.LiveStreamCount` resolves
   * to a number, so the panel offers `$sum`, `$round`, `+` — not all 64 functions.
   */
  const token = tokenAround(script, caretPos);
  const cursorType = useMemo(
    () => (inputs.error ? 'unknown' as const : resolveType(token.text, inputs.payload, inputs.context)),
    [token.text, inputs.payload, inputs.context, inputs.error]
  );
  const palette = useMemo(
    // A trigger cannot call the write functions, so they are not offered in that mode at all.
    () => paletteFor(cursorType, token.text || undefined, mode === 'model' ? 'trigger' : undefined),
    [cursorType, token.text, mode]
  );
  const found = useMemo(() => findFunctions(fnFind), [fnFind]);

  /**
   * Apply a function to whatever the cursor is on.
   *
   * `$.LiveStreamCount` + `$sum` becomes `$sum($.LiveStreamCount)` with the caret inside the
   * parentheses at the end of the argument — ready for a second argument or an operator, which
   * is what you reach for next.
   */
  const applyFunction = (fn: FunctionDoc) => {
    // The filter existed to find the argument; once applied, leaving everything dimmed would be a
    // filter nobody asked for any more.
    setPinnedFn(undefined);
    setHoveredFn(undefined);
    const next = wrapInFunction(script, token, fn);
    setScript(next.text);
    caret.current = { start: next.caret, end: next.caret };
    setCaretPos(next.caret);
    requestAnimationFrame(() => {
      const el = box.current;
      if (el) { el.focus(); el.setSelectionRange(next.caret, next.caret); }
    });
  };

  const applyOperator = (op: string) => {
    const next = appendOperator(script, caret.current.end, op);
    setScript(next.text);
    caret.current = { start: next.caret, end: next.caret };
    setCaretPos(next.caret);
    requestAnimationFrame(() => {
      const el = box.current;
      if (el) { el.focus(); el.setSelectionRange(next.caret, next.caret); }
    });
  };

  /** Drop a path into the script where the cursor is. */
  const insertPath = (path: string) => {
    const { start, end } = caret.current;
    const next = insertAt(script, start, end, path);
    setScript(next.text);
    caret.current = { start: next.caret, end: next.caret };
    // Focus back to the editor with the caret after the insertion, so a second click or a
    // keystroke continues from there rather than at the top of the box.
    requestAnimationFrame(() => {
      const el = box.current;
      if (el) { el.focus(); el.setSelectionRange(next.caret, next.caret); }
    });
  };

  /** Whether each box shows raw JSON or a clickable tree. */
  const [payloadView, setPayloadView] = useState<'tree' | 'text'>('tree');
  const [contextView, setContextView] = useState<'tree' | 'text'>('tree');
  /**
   * A search over each box.
   *
   * Browsing works when you know roughly where something is. A captured screen context is
   * thousands of nodes across dozens of elements, and expanding your way to `libraryId` is the
   * wrong tool — so keys *and values* are searchable, and every hit is still one click to
   * insert.
   */
  const [payloadFind, setPayloadFind] = useState('');
  const [contextFind, setContextFind] = useState('');

  const [completion, setCompletion] = useState<CompletionRequest | undefined>();
  const [chosen, setChosen] = useState(0);
  const box = useRef<HTMLTextAreaElement | null>(null);

  const refreshCompletions = (text: string, caret: number) => {
    // JSONata only: `$components` means nothing in the JavaScript runner, where the
    // bindings are plain consts and the browser has no completion hook to offer.
    if (language !== 'jsonata') { setCompletion(undefined); return; }
    const next = completionsAt(text, caret, {
      context: completionContext,
      elements,
      // `$.field` resolves against the document, which is the payload box — the most
      // common thing to write in a trigger or a flow expression.
      document: inputs.payload,
    });
    setCompletion(next?.items.length ? next : undefined);
    setChosen(0);
  };

  const accept = (index: number) => {
    if (!completion) return;
    const item = completion.items[index];
    if (!item) return;
    const next = applyCompletion(script, completion, item);
    setScript(next.text);
    setCompletion(undefined);
    // Restored after React has written the new value, or the caret lands at the end and
    // the next keystroke types in the wrong place.
    requestAnimationFrame(() => {
      const el = box.current;
      if (el) { el.focus(); el.setSelectionRange(next.caret, next.caret); }
    });
  };

  const onScriptKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run(); return; }
    if (completion) {
      const n = completion.items.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); setChosen((c) => (c + 1) % n); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setChosen((c) => (c - 1 + n) % n); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(chosen); return; }
      if (e.key === 'Escape') { e.preventDefault(); setCompletion(undefined); return; }
    }
    // Ctrl+space asks explicitly, for when the list was dismissed.
    if ((e.metaKey || e.ctrlKey) && e.key === ' ') {
      e.preventDefault();
      refreshCompletions(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
    }
  };

  const copy = (what: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(''), 1400);
    });
  };

  /* ── Open and save ─────────────────────────────────────────────────────── */

  const workspace = () => ({
    kind: 'script' as const, language, script, payload: payloadText, context: contextText,
  });

  const save = async (saveAs = false) => {
    const w = workspace();
    const outcome = await saveText(
      serializeWorkspace(w),
      file.name ?? suggestedName(w),
      ACCEPTED.script,
      saveAs ? undefined : file.handle
    );
    if (!outcome.ok) { setFileNote(outcome.error ?? 'Could not save.'); return; }
    setFile({ name: outcome.name, handle: outcome.handle });
    // "Downloaded" rather than "saved": there is no path to go back to, and implying
    // one would make the next Save look like it had failed to overwrite.
    setFileNote(outcome.how === 'download' ? `downloaded ${outcome.name}` : `saved ${outcome.name}`);
  };

  const open = async () => {
    const outcome = await openText(ACCEPTED.script);
    if (!outcome.ok) { setFileNote(outcome.error ?? 'Could not open.'); return; }
    const parsed = parseWorkspaceFile(outcome.text ?? '', 'script');
    if (parsed.kind === 'error') { setFileNote(parsed.error); return; }
    if (parsed.kind === 'workspace' && parsed.workspace.kind === 'script') {
      setLanguage(parsed.workspace.language);
      setScript(parsed.workspace.script);
      setPayloadText(parsed.workspace.payload);
      setContextText(parsed.workspace.context);
      setFile({ name: outcome.name, handle: outcome.handle });
      setFileNote(`opened ${outcome.name}`);
      return;
    }
    /*
     * A plain `.js` or `.jsonata` file: its text becomes the script and the inputs are
     * left alone. Clearing them would discard the payload the developer had already
     * set up, which is usually the part they wanted to keep.
     */
    if (parsed.kind !== 'text') return;
    setScript(parsed.text);
    setFile({ name: outcome.name, handle: outcome.handle });
    setFileNote(`opened ${outcome.name} — payload and context kept`);
    setResult(undefined);
  };

  return (
    <div className="pane script" style={{ flex: 1 }}>
      <div className="panehead">
        <span className="label">Scripting</span>
        <span className="seg">
          <button className={`btn ${language === 'jsonata' ? 'on' : ''}`} onClick={() => setLanguage('jsonata')}>JSONata</button>
          <button className={`btn ${language === 'javascript' ? 'on' : ''}`}
            disabled={mode === 'model'}
            title={mode === 'model' ? 'Model triggers are evaluated by the platform’s JSONata engine' : undefined}
            onClick={() => setLanguage('javascript')}>JavaScript</button>
        </span>
        <button className="btn primary" onClick={() => void run()} disabled={running}>
          {running ? 'Running…' : 'Run  ⌘⏎'}
        </button>
        <span className="seg">
          <button className={`btn tiny ${copied === 's' ? 'on' : ''}`} onClick={() => copy('s', script)}
            title="Copy the script to the clipboard">{copied === 's' ? 'copied' : 'Copy'}</button>
          {/*
            * Open and Save belong to Free mode only.
            *
            * The other modes *generate* their payload and context — from a capture, a model's
            * fields, a node's recorded output — so saving them would write a snapshot that the
            * mode overwrites on its next scaffold, and opening a file would be silently
            * discarded the same way. Copy still works everywhere, because copying the script
            * text is never ambiguous.
            */}
          {mode === 'free' ? (
            <>
              <button className="btn tiny" onClick={() => void open()}>Open</button>
              <button className="btn tiny" onClick={() => void save()}
                title="Saves the script with its payload and context, so it reopens ready to run">Save</button>
              {!!file.handle && <button className="btn tiny" onClick={() => void save(true)}>Save as</button>}
            </>
          ) : (
            <button className="btn tiny" disabled
              title="Open and Save are for Free mode — the other modes fill the payload and context themselves, so a saved copy would be overwritten">
              Open / Save
            </button>
          )}
        </span>
        <span className="count">
          {fileNote
            || (language === 'jsonata' ? 'JSONata 2.1.1 — the platform’s own version' : 'sandboxed frame · no page access')}
        </span>
      </div>

      {/* Each mode binds a different `$`, which is what decides whether an expression
          transfers to the designer unchanged — and only the ones that can work on *this*
          page are offered. All four everywhere meant three dead ends at any moment. */}
      <div className="legend design" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="seg">
          <button className={`btn tiny ${mode === 'free' ? 'on' : ''}`} onClick={() => setMode('free')}
            title="Whatever you type in the payload and context boxes">Free</button>

          {offers.screen && (
            <button className={`btn tiny ${mode === 'screen' ? 'on' : ''}`} onClick={enterScreenMode}
              title="The captured screen context, with each element’s fn bag">Screen state</button>
          )}

          {/*
            * Model triggers need the model's fields, which is a schema introspection call.
            * Shown on a schema surface but disabled while API access is off — the mode
            * exists, and the reason it cannot run is worth stating rather than hiding.
            */}
          {offers.model && (
            <button className={`btn tiny ${mode === 'model' ? 'on' : ''}`} onClick={() => setMode('model')}
              disabled={!API_ACCESS}
              title={API_ACCESS
                ? 'A data-model trigger: $ is the mutation input, with $before and $after'
                : API_DISABLED_REASON}>Model trigger</button>
          )}

          {offers.flow && (
            <button className={`btn tiny ${mode === 'flow' ? 'on' : ''}`} onClick={() => setMode('flow')}
              disabled={!flowNodes.length}
              title={flowNodes.length
                ? 'A flow node’s recorded output'
                : 'Run the flow first — no node output has been captured'}>
              Flow node{flowNodes.length ? ` (${flowNodes.length})` : ''}
            </button>
          )}
        </span>

        {mode === 'screen' && (
          <>
            <button className="btn tiny" onClick={enterScreenMode}
              title="Re-read the newest captured state into both boxes">reload state</button>
            <span className="hint">
              {elements.length
                ? `${elements.length} elements — $components.<name>.fn.<function> completes too`
                : 'No design elements yet — open a screen designer, or run a screen'}
            </span>
          </>
        )}

        {mode === 'model' && (
          <>
            <select className="code tiny" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Pick a data model…</option>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <span className="seg">
              {(['create', 'update', 'delete'] as TriggerOperation[]).map((op) => (
                <button key={op} className={`btn tiny ${operation === op ? 'on' : ''}`}
                  onClick={() => setOperation(op)}>{op}</button>
              ))}
            </span>
            {shape && <span className="hint">{`${shape.summary.fields} fields`}</span>}
            {modelError && <span className="warn">{modelError}</span>}
          </>
        )}

        {mode === 'flow' && (
          <>
            <select className="code tiny" value={pickedNode} onChange={(e) => void loadNode(e.target.value)}>
              <option value="">Pick a node’s output…</option>
              {flowNodes.map((r) => (
                <option key={r.node} value={r.node}>
                  {`${r.failed ? '✕ ' : ''}${r.node}`
                    + `${r.runs > 1 ? ` ×${r.runs}` : ''}`
                    + `${r.totalMs !== undefined ? ` · ${Math.round(r.totalMs)}ms` : ''}`}
                </option>
              ))}
            </select>
            {nodeNote && <span className="hint">{nodeNote}</span>}
          </>
        )}
      </div>

      {/* The nullability is the part people get wrong, and it is not symmetrical — so it
          is stated for the operation actually selected, not in general. */}
      {mode === 'model' && (
        <div className="legend design">
          <span className="warn">{TRIGGER_BINDINGS[operation].note}</span>
        </div>
      )}

      {/* `$.Form1.data` is a browsing convenience and will not work pasted into a screen —
          which has to be said, not left to be discovered. */}
      {mode === 'screen' && (
        <div className="legend design">
          <span className="warn">{screenScaffold.note}</span>
        </div>
      )}

      <div className="scriptgrid">
        <div className="scriptio">
          <div className="iohead">
            <span className="label">Payload</span>
            <span className="hint">
              {mode === 'model' && TRIGGER_BINDINGS[operation].document === 'unset'
                ? 'not set on delete — read the record from $before'
                : mode === 'screen'
                  ? `live state of ${screenScaffold.elements} element${screenScaffold.elements === 1 ? '' : 's'} — $.<element>`
                  : language === 'jsonata' ? 'the document — $' : 'argument `payload`'}
            </span>
            <span className="seg">
              <button className={`btn tiny ${payloadView === 'tree' ? 'on' : ''}`}
                title="Click a value to drop its path into the script"
                onClick={() => setPayloadView('tree')}>tree</button>
              <button className={`btn tiny ${payloadView === 'text' ? 'on' : ''}`}
                onClick={() => setPayloadView('text')}>text</button>
            </span>
            <button className="btn tiny" onClick={() => copy('p', payloadText)}>
              {copied === 'p' ? '✓' : 'copy'}
            </button>
          </div>
          {payloadView === 'tree' ? (
            <>
              <input className="filter pathfind"
                value={payloadFind}
                placeholder={armed ? `Dimmed to what ${armed.name} takes` : 'Find a key or a value'}
                onChange={(e) => setPayloadFind(e.target.value)} />
              <div className="pathtree">
                {inputs.error
                  ? <div className="elabel warn">{inputs.error}</div>
                  : payloadFind.trim()
                    ? <Hits matches={searchPaths(inputs.payload, 'document', payloadFind)} onPick={insertPath} suits={armed?.applies} values />
                    /* `document` root: the payload is JSONata's `$`, so paths start `$.` */
                    : <PathTree value={inputs.payload} root="document" onPick={insertPath} suits={armed?.applies} />}
              </div>
            </>
          ) : (
            <textarea className="code" value={payloadText} spellCheck={false}
              onChange={(e) => setPayloadText(e.target.value)} onKeyDown={onKeyDown} />
          )}

          <div className="iohead">
            <span className="label">Context</span>
            <span className="hint">
              {contextKeys.length
                ? contextKeys.map((k) => (language === 'jsonata' ? `$${k}` : k)).join(', ')
                : 'keys become bindings'}
            </span>
            <span className="seg">
              <button className={`btn tiny ${contextView === 'tree' ? 'on' : ''}`}
                title="Click a value to drop its path into the script"
                onClick={() => setContextView('tree')}>tree</button>
              <button className={`btn tiny ${contextView === 'text' ? 'on' : ''}`}
                onClick={() => setContextView('text')}>text</button>
            </span>
          </div>
          {contextView === 'tree' ? (
            <>
              <input className="filter pathfind"
                value={contextFind}
                placeholder={armed ? `Dimmed to what ${armed.name} takes` : 'Find a key or a value'}
                onChange={(e) => setContextFind(e.target.value)} />
              <div className="pathtree">
                {inputs.error
                  ? <div className="elabel warn">{inputs.error}</div>
                  : contextFind.trim()
                    ? <Hits matches={searchPaths(inputs.context, 'bindings', contextFind)} onPick={insertPath} suits={armed?.applies} values />
                    /* `bindings` root: a top-level context key *is* the binding name, so
                       `state` becomes `$state` and not `$.state`. */
                    : <PathTree value={inputs.context} root="bindings" onPick={insertPath} suits={armed?.applies} />}
              </div>
            </>
          ) : (
            <textarea className="code" value={contextText} spellCheck={false}
              onChange={(e) => setContextText(e.target.value)} onKeyDown={onKeyDown} />
          )}
        </div>

        <div className="scriptmain">
          <div className="iohead">
            <span className="label">Script</span>
            <span className="hint">
              {language === 'jsonata'
                ? 'evaluated against the payload · ctrl+space for completions'
                : 'async — `await` works; a bare expression is returned'}
            </span>
          </div>
          <div className="editorwrap">
            <textarea ref={box} className="code editor" value={script} spellCheck={false}
              placeholder={mode === 'model'
                ? '$before.quantity != $.quantity ? $~>|$|{"total": $.quantity * $.price}| : $'
                : language === 'jsonata' ? '$state.orderId' : 'return payload.items.length;'}
              onChange={(e) => {
                setScript(e.target.value);
                refreshCompletions(e.target.value, e.target.selectionStart ?? 0);
              }}
              onKeyDown={(e) => { onScriptKeyDown(e); rememberCaret(e.currentTarget); }}
              onKeyUp={(e) => rememberCaret(e.currentTarget)}
              onClick={(e) => rememberCaret(e.currentTarget)}
              onSelect={(e) => rememberCaret(e.currentTarget as HTMLTextAreaElement)}
              /* Delayed, so a click on a suggestion lands before the list is torn down. */
              onBlur={() => setTimeout(() => setCompletion(undefined), 120)} />

            {completion && (
              <div className="completions">
                {completion.items.slice(0, 12).map((item, i) => (
                  <div key={item.insert} className={`citem ${i === chosen ? 'on' : ''} k-${item.kind}`}
                    onMouseDown={(e) => { e.preventDefault(); accept(i); }}>
                    <span className="clabel">{item.label}</span>
                    <span className="cpreview">{item.preview}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/*
            * The palette: what you can do to whatever the cursor is on.
            *
            * Filtered by the resolved type, because a list of 64 functions is a reference and
            * this needs to be a keyboard. Operators sit alongside the functions since they are
            * what you reach for straight after wrapping something.
            */}
          <div className="iohead">
            <span className="caret" style={{ cursor: 'pointer' }}
              onClick={() => setShowPalette((v) => !v)}>{showPalette ? '▾' : '▸'}</span>
            <span className="label">Functions</span>
            <span className="hint" title="Resolved from the payload and context at the cursor">
              {/* Says what hovering does, because a filter nobody knows about is a filter that does
                  not exist — which is how this read before. */}
              {(() => {
                const shown = fnFind ? found : palette.functions;
                const fuuz = shown.filter((f) => f.origin === 'fuuz').length;
                const where = `${shown.length} · ${fuuz} Fuuz`;
                return token.text
                  ? `${token.text} · ${palette.type} · ${where}`
                  : `${where} — hover one to dim the values it cannot take`;
              })()}
            </span>
            <input className="filter" value={fnFind} placeholder="Find any function"
              onChange={(e) => setFnFind(e.target.value)} style={{ flex: 1, minWidth: 80 }} />
          </div>

          {showPalette && (
            <div className="palette">
              {/* Operators first: shortest to read, and the most common next action. */}
              {!fnFind && palette.operators.length > 0 && (
                <div className="palrow">
                  {palette.operators.map((o) => (
                    <button key={o.op} className="palop" title={o.hint}
                      onClick={() => applyOperator(o.op)}>{o.op}</button>
                  ))}
                </div>
              )}

              <div className="palrow wrap" onMouseLeave={() => setHoveredFn(undefined)}>
                {(fnFind ? found : palette.functions).map((fn) => (
                  <button key={fn.name}
                    className={`palfn sec-${fn.section.toLowerCase().replace(/\W/g, '')}`
                      + `${armed?.name === fn.name ? ' armed' : ''}`
                      + `${fn.origin === 'fuuz' ? ' platform' : ''}`}
                    title={`${fn.signature} — ${fn.description}`
                      + `\n\n${fn.section} · ${fn.origin === 'fuuz' ? 'Fuuz platform function — runs in Fuuz, not in this panel' : 'standard JSONata — runs here'}`
                      + `\n\nHover: dims the payload and context to what it takes. Click: wraps ${token.text || 'the cursor'}. Shift-click: keeps the filter on.`}
                    /*
                     * Hover filters, click applies, shift-click pins.
                     *
                     * Three intents, ordered by how often they are wanted and by how much explaining
                     * each needs — hovering explains itself, which is why the filter lives there.
                     */
                    onMouseEnter={() => setHoveredFn(fn)}
                    onClick={(e) => {
                      if (e.shiftKey) setPinnedFn(pinnedFn?.name === fn.name ? undefined : fn);
                      else applyFunction(fn);
                    }}>
                    {fn.name}
                  </button>
                ))}
                {fnFind && found.length === 0 && (
                  <span className="elabel">No function matches “{fnFind}”.</span>
                )}
              </div>

              {armed && (
                <div className="elabel palpreview">
                  <b>{armed.signature}</b> takes {armed.applies === 'any' ? 'any value' : `a ${armed.applies}`} —
                  everything else is dimmed above. Dimmed rows still work; JSONata coerces.
                  {pinnedFn
                    ? <button className="btn tiny" onClick={() => setPinnedFn(undefined)}>unpin</button>
                    : <span className="hint">shift-click to keep this filter on</span>}
                </div>
              )}

              {/* What clicking will actually produce — checkable before committing to it. */}
              {!fnFind && !armed && token.text && (
                <div className="elabel palpreview">
                  a click wraps <code>{token.text}</code> — e.g.{' '}
                  <code>{palette.functions[0]
                    ? `${palette.functions[0].name}(${token.text})`
                    : token.text}</code>
                </div>
              )}
            </div>
          )}

          <div className="iohead">
            <span className="label">Output</span>
            {result?.elapsedMs !== undefined && <span className="hint">{`${result.elapsedMs.toFixed(1)}ms`}</span>}
            {result?.ok && (
              <button className="btn tiny" onClick={() => copy('o', JSON.stringify(result.value, null, 2))}>
                {copied === 'o' ? '✓' : 'copy'}
              </button>
            )}
          </div>
          <div className="output">
            {!result && <div className="elabel">Run the script to see its result.</div>}
            {result?.error && <pre className="err">{result.error}</pre>}
            {result?.logs?.length ? (
              <div className="logs">
                {/* Captured, because a sandboxed frame's console output goes somewhere
                    the developer is not looking. */}
                {result.logs.map((line, i) => <div className="logline" key={i}>{line}</div>)}
              </div>
            ) : null}
            {result?.ok && <pre>{JSON.stringify(result.value, null, 2)}</pre>}
          </div>
        </div>
      </div>

      {/* Hidden, and only meaningful for JavaScript. Kept mounted so the first run
          does not pay for the load. */}
      <iframe ref={frame} src="sandbox.html" title="script sandbox" style={{ display: 'none' }} />
    </div>
  );
}
