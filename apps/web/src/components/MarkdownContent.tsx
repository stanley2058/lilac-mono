import {
  HTML_PREVIEW_LANGUAGE,
  parseReferenceHref,
  parseCitationHref,
} from "@stanley2058/lilac-client-protocol";
import { CitationChip } from "./CitationChip";
import { ConversationBadge } from "./ConversationReference";
import { FileLink, MarkdownImage } from "./FileActions";
import { parseFilePath } from "../file-target";
import { githubAlerts, MarkdownBlockquote } from "./markdown-alerts";
import {
  createContext,
  useContext,
  useMemo,
  lazy,
  memo,
  Suspense,
  type ComponentProps,
} from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough/parseOnly";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { remarkChatMath } from "./remark-chat-math";
import { isWorkflowRunId, remarkWorkflowRunIds } from "../workflow-run-id";
import { WorkflowRunChip } from "./WorkflowRunChip";
import { RichRenderBoundary } from "./Markdown";
import { LinkWithFavicon } from "./LinkWithFavicon";
import { AttachmentReference } from "./AttachmentReference";
import { MessageResourcesContext } from "./message-resources";
import { CodeBlock } from "./CodeBlock";
import { MarkdownTable, MarkdownTableContext } from "./MarkdownTable";
import { remarkTableSources } from "../markdown-table-source";
import { HtmlPreviewBlock } from "./HtmlPreview";
import { markdownUrl } from "./markdown-policy";
import { userMessageLineBreaks } from "./composer-line-breaks";
import { remarkSkillMentions, SkillCatalogContext } from "./skill-mentions";
import { SkillBadge } from "./SkillBadge";
import {
  type MarkdownSource,
  remarkMarkdownSource,
  rehypeMarkdownSource,
  sourceAttributes,
} from "../markdown-source";

const HighlightedCode = lazy(() => import("./rich-code"));
const Diagram = lazy(() => import("./rich-diagram"));
const MathExpression = lazy(() => import("./rich-math"));
const plugins = [
  remarkGfm,
  remarkCjkFriendly,
  remarkCjkFriendlyGfmStrikethrough,
  remarkMath,
  remarkChatMath,
  remarkWorkflowRunIds,
];
const rehypePlugins = [githubAlerts];
function userPlugins(skillNames: string[]) {
  return [
    ...plugins,
    userMessageLineBreaks,
    [remarkSkillMentions, skillNames] satisfies [typeof remarkSkillMentions, string[]],
  ];
}

function RichBlock({
  source,
  language,
  node,
}: {
  source: string;
  language: string;
  node: ExtraProps["node"];
}) {
  if (language === HTML_PREVIEW_LANGUAGE)
    return (
      <div {...sourceAttributes(node)}>
        <HtmlPreviewBlock source={source} />
      </div>
    );
  const fallback = <CodeBlock source={source} language={language} />;
  let content = <HighlightedCode source={source} language={language} />;
  if (language === "mermaid") content = <Diagram source={source} />;
  if (language === "math") content = <MathExpression source={source} display />;
  return (
    <div {...sourceAttributes(node)} data-language={language}>
      <RichRenderBoundary key={`${language}:${source}`} fallback={fallback}>
        <Suspense fallback={fallback}>{content}</Suspense>
      </RichRenderBoundary>
    </div>
  );
}

function Pre({ node, children }: ComponentProps<"pre"> & ExtraProps) {
  const code = node?.children[0];
  if (code?.type !== "element" || code.tagName !== "code") return <pre>{children}</pre>;
  const classes = code.properties.className;
  const language = Array.isArray(classes)
    ? classes.find((name) => typeof name === "string" && name.startsWith("language-"))
    : undefined;
  const source = code.children
    .map((child) => (child.type === "text" ? child.value : ""))
    .join("")
    .replace(/\n$/u, "");
  return (
    <RichBlock
      node={code}
      source={source}
      language={typeof language === "string" ? language.slice(9) : "text"}
    />
  );
}

const TaskLabel = createContext("Task");
function taskText(node: NonNullable<ExtraProps["node"]>["children"][number]): string {
  if (node.type === "text") return node.value;
  if (node.type !== "element" || node.tagName === "input") return "";
  return node.children.map(taskText).join("");
}
function ListItem({ node, children, ...props }: ComponentProps<"li"> & ExtraProps) {
  const label = node?.children.map(taskText).join("").trim() || "Task";
  return (
    <TaskLabel.Provider value={label}>
      <li {...props}>{children}</li>
    </TaskLabel.Provider>
  );
}
function TaskCheckbox({ checked }: ComponentProps<"input">) {
  const label = useContext(TaskLabel);
  return <input type="checkbox" checked={checked} disabled aria-label={label} />;
}

function MessageLink({ children, href, node }: ComponentProps<"a"> & ExtraProps) {
  if (node?.properties["data-source"] === undefined)
    return <RenderedMessageLink href={href}>{children}</RenderedMessageLink>;
  return (
    <span {...sourceAttributes(node)}>
      <RenderedMessageLink href={href}>{children}</RenderedMessageLink>
    </span>
  );
}

function RenderedMessageLink({ children, href }: ComponentProps<"a">) {
  const resources = useContext(MessageResourcesContext);
  const citation = href ? parseCitationHref(href) : undefined;
  if (citation) return <CitationChip citation={citation} />;
  const reference = href
    ? parseReferenceHref(href, typeof location === "undefined" ? undefined : location.origin)
    : undefined;
  if (reference) return <ConversationBadge target={reference} />;
  const resource = href === undefined ? undefined : resources.get(href);
  if (resource && href)
    return (
      <AttachmentReference href={resource.href} resource={resource.resource}>
        {children}
      </AttachmentReference>
    );
  if (href && /^\/api\/(files|resources)\//.test(href)) {
    const name = typeof children === "string" ? children : "File";
    return (
      <FileLink target={{ type: "resource", href, name, mediaType: "application/octet-stream" }} />
    );
  }
  const path = href ? parseFilePath(href) : undefined;
  if (path) return <FileLink target={path} />;
  return <LinkWithFavicon href={href}>{children}</LinkWithFavicon>;
}

const components: Components = {
  pre: Pre,
  blockquote: MarkdownBlockquote,
  li: ListItem,
  input: TaskCheckbox,
  code: ({ className, children, node }) => {
    if (!className && typeof children === "string" && isWorkflowRunId(children))
      return (
        <span {...sourceAttributes(node)}>
          <WorkflowRunChip runId={children} />
        </span>
      );
    const file = !className && typeof children === "string" ? parseFilePath(children) : undefined;
    if (file)
      return (
        <span {...sourceAttributes(node)}>
          <FileLink target={file} />
        </span>
      );
    const display = className?.includes("math-display") ?? false;
    if (!display && !className?.includes("math-inline"))
      return (
        <code {...sourceAttributes(node)} className={className}>
          {children}
        </code>
      );
    const source = typeof children === "string" ? children : "";
    const fallback = <code>{source}</code>;
    return (
      <RichRenderBoundary key={source} fallback={fallback}>
        <Suspense fallback={fallback}>
          <span {...sourceAttributes(node)}>
            <MathExpression source={source} display={display} />
          </span>
        </Suspense>
      </RichRenderBoundary>
    );
  },
  a: MessageLink,
  span: ({ node, ...props }) => {
    const skill = node?.properties.dataSkill;
    if (typeof skill === "string") return <SkillBadge name={skill} />;
    const workflowRun = node?.properties.dataWorkflowRun;
    if (typeof workflowRun === "string")
      return (
        <span {...sourceAttributes(node)}>
          <WorkflowRunChip runId={workflowRun} />
        </span>
      );
    return <span {...props} />;
  },
  img: ({ node, ...props }) =>
    node?.properties["data-source"] === undefined ? (
      <MarkdownImage {...props} />
    ) : (
      <span {...sourceAttributes(node)}>
        <MarkdownImage {...props} />
      </span>
    ),
  table: MarkdownTable,
};

function UserMarkdown({ text }: { text: string }) {
  const skills = useContext(SkillCatalogContext);
  const remarkPlugins = useMemo(() => userPlugins(skills.map((skill) => skill.name)), [skills]);
  return <RenderedMarkdown text={text} remarkPlugins={remarkPlugins} />;
}

function RenderedMarkdown({
  text,
  remarkPlugins,
  source,
}: {
  text: string;
  remarkPlugins: ComponentProps<typeof ReactMarkdown>["remarkPlugins"];
  source?: MarkdownSource;
}) {
  const tableSources = useMemo(() => ({ text, tables: new Map<string, string>() }), [text]);
  const mappedRemarkPlugins = useMemo(
    () => [
      ...(remarkPlugins ?? []),
      [remarkTableSources, tableSources.tables] satisfies [
        typeof remarkTableSources,
        Map<string, string>,
      ],
      ...(source
        ? [[remarkMarkdownSource, source] satisfies [typeof remarkMarkdownSource, typeof source]]
        : []),
    ],
    [remarkPlugins, source, tableSources],
  );
  const mappedRehypePlugins = useMemo(
    () =>
      source
        ? [
            ...rehypePlugins,
            [rehypeMarkdownSource, source] satisfies [typeof rehypeMarkdownSource, typeof source],
          ]
        : rehypePlugins,
    [source],
  );
  return (
    <MarkdownTableContext value={tableSources.tables}>
      <ReactMarkdown
        remarkPlugins={mappedRemarkPlugins}
        rehypePlugins={mappedRehypePlugins}
        components={components}
        urlTransform={markdownUrl}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </MarkdownTableContext>
  );
}

export default memo(function MarkdownContent({
  text,
  preserveLineBreaks = false,
  source,
}: {
  text: string;
  preserveLineBreaks?: boolean;
  source?: MarkdownSource;
}) {
  if (preserveLineBreaks) return <UserMarkdown text={text} />;
  return <RenderedMarkdown text={text} remarkPlugins={plugins} source={source} />;
});
