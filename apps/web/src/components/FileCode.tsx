import { CodeEditor } from "./CodeEditor";
import type { FileTarget } from "../file-target";
export default function FileCode({
  source,
  language,
  wrap,
  line,
  endLine,
  navigation,
}: {
  source: string;
  language: string;
  wrap: boolean;
  line?: number;
  endLine?: number;
  navigation?: FileTarget;
}) {
  return (
    <CodeEditor
      value={source}
      language={language}
      label="File contents"
      readOnly
      wrap={wrap}
      line={line}
      endLine={endLine}
      navigation={navigation}
    />
  );
}
