/**
 * Script Editor View
 *
 * Read-only CodeMirror editor with JavaScript syntax highlighting and
 * programmatic line highlighting for the replay debugger.
 *
 * Uses CodeMirror 6's StateField + Decoration system so only the
 * affected line re-renders when the highlight changes — no full DOM rebuild.
 */
import { javascript } from '@codemirror/lang-javascript';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { useEffect, useRef } from 'react';

// ─── Line highlight extension ────────────────────────────────────────

/** Effect dispatched to update which line is highlighted (1-based, 0 = none). */
const setHighlightLine = StateEffect.define<number>();

/** Line decoration applied to the highlighted line. */
const highlightMark = Decoration.line({ class: 'cm-replay-highlight' });

/** StateField tracking the current highlight decoration set. */
const highlightLineField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setHighlightLine)) {
        const lineNumber = effect.value;
        if (lineNumber <= 0 || lineNumber > tr.state.doc.lines) {
          return Decoration.none;
        }
        const line = tr.state.doc.line(lineNumber);
        return Decoration.set([highlightMark.range(line.from)]);
      }
    }
    return decorations;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ─── Dark theme matching the existing design system ──────────────────

const darkTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'transparent',
      fontSize: '12px',
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      borderRight: '1px solid rgb(51, 65, 85)', // slate-700
      color: 'rgb(100, 116, 139)', // slate-500
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
    },
    '.cm-content': {
      caretColor: 'transparent',
    },
    '.cm-cursor': {
      display: 'none',
    },
    // Replay highlight: sky accent matching the design system
    '.cm-replay-highlight': {
      backgroundColor: 'rgba(14, 165, 233, 0.15)', // sky-500/15
      borderLeft: '2px solid rgb(56, 189, 248)', // sky-400
    },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    },
  },
  { dark: true },
);

// ─── Extensions (created once, reused across renders) ────────────────

const extensions = [javascript(), highlightLineField, darkTheme, EditorView.lineWrapping];

// ─── Component ───────────────────────────────────────────────────────

interface ScriptEditorViewProps {
  /** The script text to display. */
  value: string;
  /** 0-based line index to highlight, or -1 for no highlight. */
  highlightLine: number;
  /** Max height in CSS units (e.g. '250px'). */
  maxHeight?: string;
}

export function ScriptEditorView({ value, highlightLine, maxHeight = '250px' }: ScriptEditorViewProps) {
  const editorRef = useRef<ReactCodeMirrorRef>(null);

  // Dispatch highlight line effect when the highlighted line changes
  useEffect(() => {
    const view = editorRef.current?.view;
    if (!view) {
      return;
    }

    // CodeMirror uses 1-based line numbers; our prop is 0-based (-1 = none)
    const cmLine = highlightLine >= 0 ? highlightLine + 1 : 0;

    view.dispatch({ effects: setHighlightLine.of(cmLine) });

    // Scroll the highlighted line into view
    if (cmLine > 0 && cmLine <= view.state.doc.lines) {
      const line = view.state.doc.line(cmLine);
      view.dispatch({
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      });
    }
  }, [highlightLine]);

  return (
    <CodeMirror
      ref={editorRef}
      value={value}
      extensions={extensions}
      readOnly
      editable={false}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        indentOnInput: false,
        bracketMatching: false,
        closeBrackets: false,
        autocompletion: false,
        crosshairCursor: false,
        rectangularSelection: false,
        highlightSelectionMatches: false,
        searchKeymap: false,
      }}
      maxHeight={maxHeight}
      theme="dark"
    />
  );
}
