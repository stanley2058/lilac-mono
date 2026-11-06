import { memo, useEffect, useLayoutEffect, useEffectEvent, useRef, useState } from "react";
import { useAppliedTheme } from "../theme/theme";
import { monaco, prepareEditor } from "./monaco-runtime";

export type MonacoEditorProps = {
  value: string;
  language: string;
  label: string;
  readOnly?: boolean;
  wrap?: boolean;
  line?: number;
  endLine?: number;
  navigation?: object;
  uri?: string;
  configKind?: "core" | "mcp";
  onChange?: (value: string) => void;
  onSave?: () => void;
};

export default memo(function MonacoEditor(props: MonacoEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor>(undefined);
  const { theme } = useAppliedTheme();
  const [ready, setReady] = useState(false);
  const onChange = useEffectEvent((value: string) => props.onChange?.(value));
  const onSave = useEffectEvent(() => props.onSave?.());
  useEffect(() => {
    const model = monaco.editor.createModel(
      props.value,
      props.language,
      props.uri ? monaco.Uri.parse(props.uri) : undefined,
    );
    const typography = getComputedStyle(container.current!);
    const view = monaco.editor.create(container.current!, {
      model,
      readOnly: props.readOnly,
      ariaLabel: props.label,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: typography.fontFamily,
      fontSize: parseFloat(typography.fontSize),
      lineHeight: parseFloat(typography.lineHeight),
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 8,
      glyphMargin: false,
      scrollBeyondLastLine: false,
      wordWrap: props.wrap === false ? "off" : "on",
      tabSize: 2,
      insertSpaces: true,
      renderLineHighlight: "gutter",
      renderLineHighlightOnlyWhenFocus: true,
      padding: { top: 8, bottom: 8 },
      fixedOverflowWidgets: true,
    });
    editor.current = view;
    const subscription = view.onDidChangeModelContent(() =>
      onChange(model.getValue(undefined, true)),
    );
    view.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave());
    setReady(true);
    return () => {
      subscription.dispose();
      view.dispose();
      model.dispose();
      editor.current = undefined;
    };
  }, []);
  useEffect(() => {
    if (props.language !== "yaml" || props.readOnly) return;
    void import("./yaml-editor").then(({ enableYaml }) => enableYaml());
  }, [props.language, props.readOnly]);
  useEffect(() => {
    void prepareEditor(props.language, theme);
    const model = editor.current?.getModel();
    if (model) monaco.editor.setModelLanguage(model, props.language);
  }, [props.language, theme]);
  useLayoutEffect(() => {
    const view = editor.current;
    if (view && view.getModel()?.getValue(undefined, true) !== props.value)
      view.setValue(props.value);
  }, [props.value]);
  useEffect(() => {
    editor.current?.updateOptions({
      readOnly: props.readOnly,
      ariaLabel: props.label,
      wordWrap: props.wrap === false ? "off" : "on",
    });
  }, [props.readOnly, props.label, props.wrap]);
  useEffect(() => {
    if (!props.line) return;
    editor.current?.setSelection(new monaco.Range(props.line, 1, props.endLine ?? props.line, 1));
    editor.current?.revealLineInCenter(props.line);
  }, [props.line, props.endLine, props.navigation, ready]);
  return (
    <div
      ref={container}
      data-ui="code-editor"
      className="flex-1 min-h-0 min-w-0 h-full font-mono text-sm leading-code"
    />
  );
});
